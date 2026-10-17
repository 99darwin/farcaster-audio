"""Auth addresses (KeyRegistry keyType 2) for Protocol Auth sign-in.

A device's secp256k1 auth address is added on-chain with
``KeyGateway.addFor`` during the signer link flow
(``user_signer_service``). This module keeps the local ``auth_addresses``
cache in sync with the KeyRegistry (``KeyRegistry.keyDataOf``). Hypersnap's
``/v1/signersByFid`` lists only Ed25519 keys, so auth addresses are checked
on-chain.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth_address import AuthAddress
from app.services.key_request_signing import (  # noqa: F401 - re-exported
    _get_app_account,
)

# Pending auth-address rows are reconciled on-chain at most once per this
# interval. Approved/revoked rows are terminal and never re-checked.
PENDING_RECHECK_SECONDS = 30
TERMINAL_STATUSES = frozenset({"approved", "revoked"})


async def check_auth_address_status(auth_address: str, fid: int | None) -> dict:
    """On-chain status of ``auth_address`` for ``fid``.

    ``approved`` when the KeyRegistry holds it as an active keyType 2 key
    for ``fid``, otherwise ``pending_approval``. Without a ``fid`` nothing
    can be checked and the status is ``unknown``.
    """
    # Imported lazily: signer_registry imports this module.
    from app.services import signer_registry

    if fid is None:
        return {"address": auth_address, "status": "unknown", "fid": None}
    is_active = await signer_registry.is_auth_address_active(fid, auth_address)
    status = "approved" if is_active else "pending_approval"
    return {"address": auth_address, "status": status, "fid": fid}


async def upsert_auth_address_from_registration(
    db: AsyncSession,
    address: str,
    fid: int,
    status: str,
    approval_url: str | None,
) -> AuthAddress:
    """Insert or update an auth address row from a registration response."""
    now = datetime.now(timezone.utc)
    result = await db.execute(select(AuthAddress).where(AuthAddress.address == address))
    row = result.scalar_one_or_none()
    if row is None:
        row = AuthAddress(
            address=address,
            fid=fid,
            status=status,
            approval_url=approval_url,
            registered_at=now,
            last_checked_at=now,
            approved_at=now if status == "approved" else None,
        )
        db.add(row)
    else:
        row.fid = fid
        if row.status not in TERMINAL_STATUSES:
            row.status = status
            row.approval_url = approval_url
            if status == "approved" and row.approved_at is None:
                row.approved_at = now
        row.last_checked_at = now
    await db.commit()
    await db.refresh(row)
    return row


async def mark_auth_address_revoked(db: AsyncSession, address: str) -> None:
    """Mark an auth address as revoked locally. Idempotent."""
    now = datetime.now(timezone.utc)
    result = await db.execute(select(AuthAddress).where(AuthAddress.address == address))
    row = result.scalar_one_or_none()
    if row is None:
        return
    row.status = "revoked"
    row.approval_url = None
    row.last_checked_at = now
    await db.commit()


async def get_auth_address_status_cached(
    db: AsyncSession,
    address: str,
) -> dict:
    """Resolve auth address status from local DB, refreshing on-chain lazily.

    Same lifecycle as `get_signer_status_cached` in snap_signer_service.
    """
    now = datetime.now(timezone.utc)
    result = await db.execute(select(AuthAddress).where(AuthAddress.address == address))
    row = result.scalar_one_or_none()

    if row is not None:
        if row.status in TERMINAL_STATUSES:
            return {"address": address, "status": row.status, "fid": row.fid}
        last_checked = row.last_checked_at
        if last_checked is not None:
            # SQLite drops timezone info on round-trip; coerce to UTC.
            if last_checked.tzinfo is None:
                last_checked = last_checked.replace(tzinfo=timezone.utc)
            if now - last_checked < timedelta(seconds=PENDING_RECHECK_SECONDS):
                return {
                    "address": address,
                    "status": row.status,
                    "fid": row.fid,
                }

    upstream = await check_auth_address_status(
        address, row.fid if row is not None else None
    )
    upstream_status = upstream.get("status", "unknown")
    upstream_fid = upstream.get("fid") or (row.fid if row is not None else None)

    if row is None:
        if upstream_fid is None:
            return {
                "address": address,
                "status": upstream_status,
                "fid": None,
            }
        row = AuthAddress(
            address=address,
            fid=upstream_fid,
            status=upstream_status,
            approval_url=upstream.get("auth_address_approval_url"),
            registered_at=now,
            last_checked_at=now,
            approved_at=now if upstream_status == "approved" else None,
        )
        db.add(row)
    else:
        row.status = upstream_status
        if upstream_status == "approved" and row.approved_at is None:
            row.approved_at = now
        if upstream_status in TERMINAL_STATUSES:
            row.approval_url = None
        else:
            row.approval_url = upstream.get(
                "auth_address_approval_url", row.approval_url
            )
        row.last_checked_at = now

    await db.commit()
    return {
        "address": address,
        "status": upstream_status,
        "fid": row.fid,
    }
