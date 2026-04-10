"""Ed25519 signer registration for Farcaster Snap interactivity.

The Farcaster Snap server package (`@farcaster/snap`) strictly requires POST
bodies to be JSON Farcaster Signatures signed with an `app_key` (Ed25519)
that is actively registered on the hub for the user's FID. Auth addresses
(secp256k1) are explicitly rejected.

This service mirrors `auth_address_service.py` but for Ed25519 keys: it
signs an EIP-712 SignedKeyRequest with the app's Farcaster account and
registers the user's on-device Ed25519 public key with Neynar's
developer-managed signer API.
"""

import time
from datetime import datetime, timedelta, timezone

import httpx
from eth_account.messages import encode_typed_data
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.snap_signer import SnapSigner
from app.services.auth_address_service import (
    SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN,
    SIGNED_KEY_REQUEST_TYPES,
    _get_app_account,
)

KEY_REQUEST_DEADLINE_SECONDS = 86400  # 24 hours
# Pending rows are reconciled with Neynar at most once per this interval.
# Approved/revoked rows are terminal and never re-checked.
PENDING_RECHECK_SECONDS = 30
TERMINAL_STATUSES = frozenset({"approved", "revoked"})

NEYNAR_SIGNER_REGISTER_URL = (
    "https://api.neynar.com/v2/farcaster/signer"
    "/developer_managed/signed_key/"
)
NEYNAR_SIGNER_STATUS_URL = (
    "https://api.neynar.com/v2/farcaster/signer/developer_managed"
)


def _decode_pubkey_hex(public_key_hex: str) -> bytes:
    """Validate and decode a 0x-prefixed 32-byte Ed25519 public key."""
    if not public_key_hex.startswith("0x"):
        raise ValueError("public_key must be 0x-prefixed")
    raw = bytes.fromhex(public_key_hex[2:])
    if len(raw) != 32:
        raise ValueError("Ed25519 public key must be 32 bytes")
    return raw


def generate_signed_key_request_for_ed25519(
    public_key_hex: str,
) -> tuple[str, int]:
    """Sign an EIP-712 SignedKeyRequest authorizing an Ed25519 app_key.

    The `key` field carries the raw 32-byte public key (not zero-padded —
    it is already exactly 32 bytes). Returns (signature_hex, deadline).
    """
    if settings.FARCASTER_APP_FID <= 0:
        raise ValueError("FARCASTER_APP_FID is not configured")

    key_bytes = _decode_pubkey_hex(public_key_hex)

    app_account = _get_app_account()
    deadline = int(time.time()) + KEY_REQUEST_DEADLINE_SECONDS

    message = {
        "requestFid": settings.FARCASTER_APP_FID,
        "key": key_bytes,
        "deadline": deadline,
    }

    signable = encode_typed_data(
        domain_data=SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN,
        message_types=SIGNED_KEY_REQUEST_TYPES,
        message_data=message,
    )

    signed = app_account.sign_message(signable)
    return f"0x{signed.signature.hex()}", deadline


async def register_ed25519_signer_with_neynar(
    public_key_hex: str,
    signature: str,
    deadline: int,
) -> dict:
    """Register an Ed25519 public key with Neynar as a developer-managed signer."""
    # Defense in depth: validate even though callers normalize upstream.
    _decode_pubkey_hex(public_key_hex)

    payload = {
        "public_key": public_key_hex,
        "app_fid": settings.FARCASTER_APP_FID,
        "deadline": deadline,
        "signature": signature,
        "sponsor": {
            "sponsored_by_neynar": True,
        },
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.post(
            NEYNAR_SIGNER_REGISTER_URL,
            json=payload,
            headers={
                "x-api-key": settings.NEYNAR_API_KEY,
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def check_ed25519_signer_status(public_key_hex: str) -> dict:
    """Check the registration status of a developer-managed Ed25519 signer."""
    # Defense in depth: validate even though callers normalize upstream.
    _decode_pubkey_hex(public_key_hex)

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.get(
            NEYNAR_SIGNER_STATUS_URL,
            params={"public_key": public_key_hex},
            headers={"x-api-key": settings.NEYNAR_API_KEY},
        )
        resp.raise_for_status()
        return resp.json()


async def upsert_signer_from_registration(
    db: AsyncSession,
    public_key: str,
    fid: int,
    status: str,
    approval_url: str | None,
) -> SnapSigner:
    """Insert or update a snap signer row from a registration response."""
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
    else:
        row.fid = fid
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
    """Resolve snap signer status from local DB, refreshing from Neynar lazily.

    Behaviour:
    - If a row exists with a terminal status (approved/revoked) → return it
      immediately, no Neynar call.
    - If a row exists with a pending status and was checked < 30s ago → return
      stale value (saves a Neynar call during tight polling loops).
    - Otherwise (missing row OR stale pending) → make exactly one Neynar call,
      upsert, return.
    """
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(SnapSigner).where(SnapSigner.public_key == public_key)
    )
    row = result.scalar_one_or_none()

    if row is not None:
        if row.status in TERMINAL_STATUSES:
            return {"public_key": public_key, "status": row.status, "fid": row.fid}
        last_checked = row.last_checked_at
        if last_checked is not None:
            # SQLite drops timezone info on round-trip; coerce to UTC.
            if last_checked.tzinfo is None:
                last_checked = last_checked.replace(tzinfo=timezone.utc)
            if now - last_checked < timedelta(seconds=PENDING_RECHECK_SECONDS):
                return {
                    "public_key": public_key,
                    "status": row.status,
                    "fid": row.fid,
                }

    upstream = await check_ed25519_signer_status(public_key)
    upstream_status = upstream.get("status", "unknown")
    upstream_fid = upstream.get("fid") or (row.fid if row is not None else None)

    if row is None:
        if upstream_fid is None:
            # Should not happen — we own the ownership mapping in Redis and
            # only call this for keys we already track. Don't persist a row
            # with NULL fid; just return the upstream payload.
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
            row.approval_url = upstream.get(
                "signer_approval_url", row.approval_url
            )
        row.last_checked_at = now

    await db.commit()
    return {
        "public_key": public_key,
        "status": upstream_status,
        "fid": row.fid,
    }
