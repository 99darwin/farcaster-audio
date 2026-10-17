"""Ed25519 signer registration for Farcaster Snap interactivity.

The Farcaster Snap server package (`@farcaster/snap`) strictly requires POST
bodies to be JSON Farcaster Signatures signed with an `app_key` (Ed25519)
that is actively registered on the hub for the user's FID. Auth addresses
(secp256k1) are explicitly rejected.

The key is added on-chain with ``KeyGateway.addFor``: this service signs
the SignedKeyRequest with the app's Farcaster account, and the status is
read from Hypersnap's ``/v1/signersByFid`` (``signer_registry``).
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.snap_signer import SnapSigner
from app.services.key_request_signing import sign_key_request

ED25519_PUBLIC_KEY_BYTES = 32
# Pending rows are reconciled with Hypersnap at most once per this interval.
PENDING_RECHECK_SECONDS = 30
# Approved rows are reconciled at most once per this interval. On-chain
# removal can invalidate them silently, so they are re-checked periodically.
# Revoked is truly terminal (a removed key never flips back).
APPROVED_RECHECK_SECONDS = 24 * 60 * 60
TERMINAL_STATUSES = frozenset({"approved", "revoked"})
# How long a row of each status may be served from the local DB before
# being reconciled with Hypersnap. Statuses absent from this map fall
# through to a Hypersnap call unconditionally.
RECHECK_BY_STATUS = {
    "approved": APPROVED_RECHECK_SECONDS,
    "pending_approval": PENDING_RECHECK_SECONDS,
}


def _decode_pubkey_hex(public_key_hex: str) -> bytes:
    """Validate and decode a 0x-prefixed 32-byte Ed25519 public key."""
    if not public_key_hex.startswith("0x"):
        raise ValueError("public_key must be 0x-prefixed")
    raw = bytes.fromhex(public_key_hex[2:])
    if len(raw) != ED25519_PUBLIC_KEY_BYTES:
        raise ValueError("Ed25519 public key must be 32 bytes")
    return raw


def generate_signed_key_request_for_ed25519(
    public_key_hex: str,
) -> tuple[str, int]:
    """Sign an EIP-712 SignedKeyRequest authorizing an Ed25519 app_key.

    The `key` field carries the raw 32-byte public key. Returns
    ``(signature_hex, deadline)``.
    """
    return sign_key_request(_decode_pubkey_hex(public_key_hex))


async def check_ed25519_signer_status(public_key_hex: str, fid: int | None) -> dict:
    """Hypersnap status of an Ed25519 key for ``fid``.

    ``approved`` when ``/v1/signersByFid`` lists it as an active on-chain
    key for ``fid``, otherwise ``pending_approval``. Without a ``fid``
    nothing can be checked and the status is ``unknown``.
    """
    # Imported lazily: signer_registry imports this module.
    from app.services import signer_registry

    _decode_pubkey_hex(public_key_hex)
    if fid is None:
        return {"public_key": public_key_hex, "status": "unknown", "fid": None}
    is_active = await signer_registry.is_ed25519_signer_active(fid, public_key_hex)
    status = "approved" if is_active else "pending_approval"
    return {"public_key": public_key_hex, "status": status, "fid": fid}


class SnapSignerOwnershipConflict(Exception):
    """The key is recorded for another fid and is not on-chain for the caller."""


async def get_signer_owner(db: AsyncSession, public_key: str) -> int | None:
    """The fid that owns ``public_key`` in ``snap_signers``, if any.

    Postgres is the source of truth for ownership; status and invalidate
    authorize against this, never against a cache.
    """
    return await db.scalar(
        select(SnapSigner.fid).where(SnapSigner.public_key == public_key)
    )


async def upsert_signer_from_registration(
    db: AsyncSession,
    public_key: str,
    fid: int,
    status: str,
    approval_url: str | None,
) -> SnapSigner:
    """Insert or refresh the caller's snap signer row.

    A key recorded for another fid is never overwritten on the caller's
    word: it moves to the caller only when Hypersnap lists it as an active
    on-chain key of the caller's fid (which only that fid's custody can
    arrange). Otherwise ``SnapSignerOwnershipConflict`` is raised.

    A first-time registration of an unknown key is recorded as the caller's
    pending key, as before: the status is always reconciled against the
    row's fid on Hypersnap, so the row grants nothing until that fid adds
    the key on-chain.
    """
    try:
        return await _upsert_signer(db, public_key, fid, status, approval_url)
    except IntegrityError:
        # A concurrent first-time registration inserted the row first.
        await db.rollback()
        return await _upsert_signer(db, public_key, fid, status, approval_url)


async def _upsert_signer(
    db: AsyncSession,
    public_key: str,
    fid: int,
    status: str,
    approval_url: str | None,
) -> SnapSigner:
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(SnapSigner).where(SnapSigner.public_key == public_key)
    )
    row = result.scalar_one_or_none()
    if row is None:
        row = SnapSigner(
            public_key=public_key,
            fid=fid,
            status=status,
            approval_url=approval_url,
            registered_at=now,
            last_checked_at=now,
            approved_at=now if status == "approved" else None,
        )
        db.add(row)
    elif row.fid != fid:
        # Imported lazily: signer_registry imports this module.
        from app.services import signer_registry

        if not await signer_registry.is_ed25519_signer_active(fid, public_key):
            raise SnapSignerOwnershipConflict(public_key)
        # Proven on-chain for the caller: the previous row is stale.
        row.fid = fid
        row.status = "approved"
        row.approval_url = None
        row.registered_at = now
        row.approved_at = now
        row.last_checked_at = now
    else:
        # Don't downgrade a terminal status from a re-registration response.
        if row.status not in TERMINAL_STATUSES:
            row.status = status
            row.approval_url = approval_url
            if status == "approved" and row.approved_at is None:
                row.approved_at = now
        row.last_checked_at = now
    await db.commit()
    await db.refresh(row)
    return row


async def mark_signer_revoked(db: AsyncSession, public_key: str) -> None:
    """Mark a snap signer as revoked locally. Idempotent."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(SnapSigner).where(SnapSigner.public_key == public_key)
    )
    row = result.scalar_one_or_none()
    if row is None:
        return
    row.status = "revoked"
    row.approval_url = None
    row.last_checked_at = now
    await db.commit()


async def get_signer_status_cached(
    db: AsyncSession,
    public_key: str,
) -> dict:
    """Resolve snap signer status from local DB, refreshing from Hypersnap lazily.

    Behaviour:
    - `revoked` rows are truly terminal — never re-checked.
    - `approved` rows are reconciled at most once per 24h. On-chain
      revocation can invalidate an "approved" row silently; without the
      recheck a stale row would mask the revocation forever and the
      mobile app would never see the gate fire again.
    - `pending_approval` rows are re-checked once per 30s during tight
      polling loops.
    - Missing row or stale row → exactly one Hypersnap call, upsert, return.
    - An `approved` key that is no longer active on-chain becomes `revoked`.
    """
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(SnapSigner).where(SnapSigner.public_key == public_key)
    )
    row = result.scalar_one_or_none()

    if row is not None:
        if row.status == "revoked":
            return {"public_key": public_key, "status": row.status, "fid": row.fid}
        recheck_window = RECHECK_BY_STATUS.get(row.status)
        if recheck_window is not None:
            last_checked = row.last_checked_at
            if last_checked is not None:
                # SQLite drops timezone info on round-trip; coerce to UTC.
                if last_checked.tzinfo is None:
                    last_checked = last_checked.replace(tzinfo=timezone.utc)
                if now - last_checked < timedelta(seconds=recheck_window):
                    return {
                        "public_key": public_key,
                        "status": row.status,
                        "fid": row.fid,
                    }

    upstream = await check_ed25519_signer_status(
        public_key, row.fid if row is not None else None
    )
    upstream_status = upstream.get("status", "unknown")
    upstream_fid = upstream.get("fid") or (row.fid if row is not None else None)
    if row is not None and row.status == "approved" and upstream_status != "approved":
        # The key was live and has since been removed on-chain.
        upstream_status = "revoked"

    if row is None:
        if upstream_fid is None:
            # Should not happen: the router only calls this for keys with
            # an owned row. Don't persist a row with NULL fid; just return
            # the upstream payload.
            return {
                "public_key": public_key,
                "status": upstream_status,
                "fid": None,
            }
        row = SnapSigner(
            public_key=public_key,
            fid=upstream_fid,
            status=upstream_status,
            approval_url=upstream.get("signer_approval_url"),
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
            row.approval_url = upstream.get("signer_approval_url", row.approval_url)
        row.last_checked_at = now

    await db.commit()
    return {
        "public_key": public_key,
        "status": upstream_status,
        "fid": row.fid,
    }
