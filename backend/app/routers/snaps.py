"""Snap signer management.

Registers on-device Ed25519 public keys with Neynar as developer-managed
signers so users can interact with Farcaster Snaps. The private key stays
in SecureStore on the device; this endpoint only handles the EIP-712 key
request that authorizes the pubkey onchain.
"""

import logging
import re

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_current_user, get_redis
from app.schemas.snap import (
    RegisterSnapSignerRequest,
    RegisterSnapSignerResponse,
    SnapSignerStatusResponse,
)
from app.services.snap_signer_service import (
    check_ed25519_signer_status,
    generate_signed_key_request_for_ed25519,
    register_ed25519_signer_with_neynar,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/snaps", tags=["snaps"])

PUBKEY_PATTERN = re.compile(r"^0x[0-9a-fA-F]{64}$")

RATE_LIMIT_MAX = 3
RATE_LIMIT_WINDOW_SECONDS = 3600
# Ownership mapping lifetime. Long enough to cover signer lifecycle but
# bounded so stale/unapproved registrations don't accumulate forever.
SNAP_SIGNER_OWNERSHIP_TTL_SECONDS = 30 * 86400


def _normalize_pubkey(public_key: str) -> str:
    """Validate + lowercase an Ed25519 pubkey. Raises 400 on invalid input."""
    if not PUBKEY_PATTERN.match(public_key):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Ed25519 public key",
        )
    return public_key.lower()


def _ownership_key(public_key_lower: str) -> str:
    return f"snap_signer:{public_key_lower}"


@router.post("/register-signer", response_model=RegisterSnapSignerResponse)
async def register_snap_signer(
    body: RegisterSnapSignerRequest,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Register an Ed25519 public key for snap interactivity."""
    public_key = _normalize_pubkey(body.public_key)
    rate_key = f"snap_signer_rate:{fid}"

    # Rate limit: atomically increment first so concurrent requests cannot
    # race past the check. We always count the attempt against the caller's
    # budget — including failures — which prevents an attacker from
    # hammering Neynar by deliberately triggering upstream errors.
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(rate_key)
        pipe.expire(rate_key, RATE_LIMIT_WINDOW_SECONDS)
        new_count, _ = await pipe.execute()
    if int(new_count) > RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registration attempts. Try again later.",
        )

    # Reject attempts to re-register a pubkey already claimed by a different fid.
    existing_owner = await redis.get(_ownership_key(public_key))
    if existing_owner is not None and int(existing_owner) != fid:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Public key already registered",
        )

    try:
        signature, deadline = generate_signed_key_request_for_ed25519(public_key)
    except ValueError as exc:
        logger.error("Ed25519 signed key request failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    try:
        result = await register_ed25519_signer_with_neynar(
            public_key_hex=public_key,
            signature=signature,
            deadline=deadline,
        )
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Neynar snap signer registration failed for fid=%s status=%s",
            fid,
            exc.response.status_code,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Snap signer registration failed",
        )
    except httpx.RequestError as exc:
        logger.error(
            "Neynar snap signer registration transport error for fid=%s: %s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Snap signer registration unavailable",
        )

    # Verify Neynar echoed back the pubkey we sent — protects against
    # state split where the client is told one key but Redis/hub have another.
    upstream_pubkey = result.get("public_key")
    if upstream_pubkey and upstream_pubkey.lower() != public_key:
        logger.error("Neynar returned mismatched pubkey for fid=%s", fid)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Snap signer registration failed",
        )

    # Atomically claim the ownership mapping. SET NX prevents a concurrent
    # duplicate registration from overwriting an existing record; TTL caps
    # unbounded key growth.
    claimed = await redis.set(
        _ownership_key(public_key),
        str(fid),
        ex=SNAP_SIGNER_OWNERSHIP_TTL_SECONDS,
        nx=True,
    )
    if not claimed:
        # Key was written between our initial check and now. Re-read to
        # decide whether this is a same-fid refresh or a conflict.
        existing = await redis.get(_ownership_key(public_key))
        if existing is not None and int(existing) != fid:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Public key already registered",
            )
        # Same fid — refresh TTL to keep the claim alive.
        await redis.expire(
            _ownership_key(public_key), SNAP_SIGNER_OWNERSHIP_TTL_SECONDS
        )

    return RegisterSnapSignerResponse(
        public_key=public_key,
        status=result.get("status", "pending_approval"),
        approval_url=result.get("signer_approval_url"),
    )


@router.get("/signer-status", response_model=SnapSignerStatusResponse)
async def get_snap_signer_status(
    public_key: str,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Check whether a snap signer has been approved."""
    public_key = _normalize_pubkey(public_key)

    # Constant-shape 403 for both "does not exist" and "not yours" so we
    # don't leak whether an arbitrary pubkey is registered in our system.
    owner_fid = await redis.get(_ownership_key(public_key))
    if owner_fid is None or int(owner_fid) != fid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Snap signer not accessible",
        )

    try:
        result = await check_ed25519_signer_status(public_key)
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Neynar snap signer status check failed for fid=%s status=%s",
            fid,
            exc.response.status_code,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to check snap signer status",
        )
    except httpx.RequestError as exc:
        logger.error(
            "Neynar snap signer status transport error for fid=%s: %s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Snap signer status unavailable",
        )

    # Return the verified fid from our ownership mapping rather than blindly
    # trusting the upstream value.
    return SnapSignerStatusResponse(
        public_key=public_key,
        status=result.get("status", "unknown"),
        fid=fid,
    )
