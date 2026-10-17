"""Snap signer management.

Tracks on-device Ed25519 public keys used for Farcaster Snaps. The
private key stays in SecureStore on the device. A key is ``approved`` once
it is added on-chain for the user's FID (``KeyGateway``) and Hypersnap
lists it; the server-relayed ``addFor`` for snap keys is a follow-up, so
registration records the key as ``pending_approval``.
"""

import logging
import re

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients.hypersnap import HypersnapError
from app.dependencies import get_current_user, get_db, get_redis, require_non_demo_user
from app.schemas.snap import (
    InvalidateSnapSignerRequest,
    RegisterSnapSignerRequest,
    RegisterSnapSignerResponse,
    SnapSignerStatusResponse,
)
from app.services.snap_signer_service import (
    SnapSignerOwnershipConflict,
    get_signer_owner,
    get_signer_status_cached,
    mark_signer_revoked,
    upsert_signer_from_registration,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/snaps", tags=["snaps"])

PUBKEY_PATTERN = re.compile(r"^0x[0-9a-fA-F]{64}$")

RATE_LIMIT_MAX = 3
RATE_LIMIT_WINDOW_SECONDS = 3600
INVALIDATE_RATE_LIMIT_MAX = 10
INVALIDATE_RATE_LIMIT_WINDOW_SECONDS = 3600


def _normalize_pubkey(public_key: str) -> str:
    """Validate + lowercase an Ed25519 pubkey. Raises 400 on invalid input."""
    if not PUBKEY_PATTERN.match(public_key):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Ed25519 public key",
        )
    return public_key.lower()


async def _require_signer_owner(db: AsyncSession, public_key: str, fid: int) -> None:
    """403 unless ``fid`` owns the key's ``snap_signers`` row.

    Constant-shape 403 for both "does not exist" and "not yours" so we
    don't leak whether an arbitrary pubkey is registered in our system.
    """
    if await get_signer_owner(db, public_key) != fid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Snap signer not accessible",
        )


@router.post("/register-signer", response_model=RegisterSnapSignerResponse)
async def register_snap_signer(
    body: RegisterSnapSignerRequest,
    fid: int = Depends(require_non_demo_user),
    redis: aioredis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
):
    """Register an Ed25519 public key for snap interactivity."""
    public_key = _normalize_pubkey(body.public_key)
    rate_key = f"snap_signer_rate:{fid}"

    # Rate limit: atomically increment first so concurrent requests cannot
    # race past the check. We always count the attempt against the caller's
    # budget — including failures — which prevents an attacker from
    # hammering upstream by deliberately triggering errors.
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(rate_key)
        pipe.expire(rate_key, RATE_LIMIT_WINDOW_SECONDS)
        new_count, _ = await pipe.execute()
    if int(new_count) > RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registration attempts. Try again later.",
        )

    upstream_status = "pending_approval"
    approval_url = None

    # Ownership lives in Postgres (the row's fid). A key held by another fid
    # moves only when it is on-chain for the caller; DB failures surface
    # instead of leaving an unrecorded claim.
    try:
        await upsert_signer_from_registration(
            db=db,
            public_key=public_key,
            fid=fid,
            status=upstream_status,
            approval_url=approval_url,
        )
    except SnapSignerOwnershipConflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Public key already registered",
        )
    except HypersnapError as exc:
        logger.error(
            "snap signer ownership check failed for fid=%s err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to verify snap signer",
        )

    return RegisterSnapSignerResponse(
        public_key=public_key,
        status=upstream_status,
        approval_url=approval_url,
    )


@router.get("/signer-status", response_model=SnapSignerStatusResponse)
async def get_snap_signer_status(
    public_key: str,
    fid: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Check whether a snap signer has been approved.

    Only the fid that owns the key's ``snap_signers`` row may read it. Reads
    the local row first; only falls through to Hypersnap for stale entries.
    """
    public_key = _normalize_pubkey(public_key)

    await _require_signer_owner(db, public_key, fid)

    try:
        result = await get_signer_status_cached(db, public_key)
    except HypersnapError as exc:
        logger.error(
            "snap signer status check failed for fid=%s err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to check snap signer status",
        )

    # Return the verified owner fid rather than trusting the upstream value.
    return SnapSignerStatusResponse(
        public_key=public_key,
        status=result.get("status", "unknown"),
        fid=fid,
    )


@router.post("/signer-invalidate", status_code=status.HTTP_204_NO_CONTENT)
async def invalidate_snap_signer(
    body: InvalidateSnapSignerRequest,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Mark a snap signer as revoked locally.

    Called by the client after observing a signing failure that indicates
    the signer is no longer valid (e.g. revoked from Warpcast). Authorization
    follows the same ownership check as `/signer-status`. Lightly rate-limited
    so a malicious client can't grief the table.
    """
    public_key = _normalize_pubkey(body.public_key)

    # Lightweight rate limit: 10/hour/user. Atomic incr-then-expire.
    rate_key = f"snap_signer_invalidate_rate:{fid}"
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(rate_key)
        pipe.expire(rate_key, INVALIDATE_RATE_LIMIT_WINDOW_SECONDS)
        new_count, _ = await pipe.execute()
    if int(new_count) > INVALIDATE_RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many invalidate attempts. Try again later.",
        )

    await _require_signer_owner(db, public_key, fid)

    await mark_signer_revoked(db, public_key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
