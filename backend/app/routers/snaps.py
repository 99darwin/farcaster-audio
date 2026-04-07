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


@router.post("/register-signer", response_model=RegisterSnapSignerResponse)
async def register_snap_signer(
    body: RegisterSnapSignerRequest,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Register an Ed25519 public key for snap interactivity."""
    # Rate limit: max 3 registrations per hour per user
    rate_key = f"snap_signer_rate:{fid}"
    attempts = await redis.incr(rate_key)
    if attempts == 1:
        await redis.expire(rate_key, 3600)
    if attempts > 3:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registration attempts. Try again later.",
        )

    try:
        signature, deadline = generate_signed_key_request_for_ed25519(body.public_key)
    except ValueError as exc:
        logger.error("Ed25519 signed key request failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    try:
        result = await register_ed25519_signer_with_neynar(
            public_key_hex=body.public_key,
            signature=signature,
            deadline=deadline,
        )
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Neynar snap signer registration failed for fid=%s: %s",
            fid,
            exc.response.text,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Snap signer registration failed",
        )

    # Store pubkey -> FID mapping so status checks can verify ownership
    await redis.set(f"snap_signer:{body.public_key.lower()}", str(fid))

    return RegisterSnapSignerResponse(
        public_key=result.get("public_key", body.public_key),
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
    if not PUBKEY_PATTERN.match(public_key):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Ed25519 public key",
        )

    owner_fid = await redis.get(f"snap_signer:{public_key.lower()}")
    if owner_fid is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Unknown snap signer",
        )
    if int(owner_fid) != fid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Snap signer does not belong to this user",
        )

    try:
        result = await check_ed25519_signer_status(public_key)
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Neynar snap signer status check failed for fid=%s: %s",
            fid,
            exc.response.text,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to check snap signer status",
        )

    return SnapSignerStatusResponse(
        public_key=result.get("public_key", public_key),
        status=result.get("status", "unknown"),
        fid=result.get("fid"),
    )
