"""Farcaster sync opt-in handshake routes.

After workers B1/B2 land a Warpcast bearer in the iOS Keychain, the
client posts the minimal opt-in record here: just ``{fid}``. **No
bearer secret crosses the wire** — these endpoints record opt-in
state only.

Endpoints:

* ``POST   /v1/farcaster-sync/link``    — record opt-in for ``fid``.
* ``DELETE /v1/farcaster-sync``         — revoke opt-in.
* ``GET    /v1/farcaster-sync``         — current opt-in status.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import (
    get_current_user,
    get_db,
    get_redis,
    require_first_party_user,
)
from app.models.user import User
from app.schemas.farcaster_sync import LinkRequest, SyncStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/farcaster-sync", tags=["farcaster-sync"])

LINK_RATE_LIMIT_PER_MIN = 5
LINK_RATE_LIMIT_WINDOW_SECONDS = 60


async def _enforce_link_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    """Bound link/revoke churn per authenticated user.

    Keeps a misbehaving client (or a stolen bearer) from flapping the
    opt-in flag in a tight loop. The window mirrors the other per-user
    rate limiters in the codebase (60s rolling).
    """
    rate_key = f"farcaster_sync:rl:{fid}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, LINK_RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if int(count) > LINK_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Farcaster sync rate limit exceeded. Try again later.",
            headers={"Retry-After": str(LINK_RATE_LIMIT_WINDOW_SECONDS)},
        )


async def _load_user(db: AsyncSession, fid: int) -> User:
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is None:
        # JWT validates, but the user row is gone — fail closed.
        raise HTTPException(status_code=401, detail="User not found.")
    return user


@router.post("/link", response_model=SyncStatus)
async def link_farcaster_sync(
    body: LinkRequest,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> SyncStatus:
    """Opt the authenticated user in to Farcaster sync.

    Idempotent: calling again refreshes ``farcaster_sync_linked_at``.

    ``body.fid`` must equal the authenticated user's fid. Juke sessions
    are Farcaster-authenticated, so the caller's verified fid IS their
    Farcaster account; accepting any other value would let a user
    self-attest someone else's fid and then claim that account's
    upstream spaces (``/v1/rooms/link-farcaster``).

    Requires a first-party sign-in: partner-minted JWTs (e.g. iframe
    host bearers) cannot mutate a user's Warpcast linkage on their
    behalf, even with a valid token. The user must have signed in
    directly with Farcaster on Juke.
    """
    await _enforce_link_rate_limit(fid, redis)
    if body.fid != fid:
        raise HTTPException(
            status_code=403,
            detail="fid must match the signed-in Farcaster account.",
        )
    user = await _load_user(db, fid)

    # Debug-level on purpose: we never want a steady stream of opt-in
    # FIDs in INFO logs (those are PII-adjacent for our purposes).
    logger.debug("[farcaster-sync] user=%d linking sync", fid)

    user.farcaster_fid = fid
    user.farcaster_sync_enabled = True
    user.farcaster_sync_linked_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)

    return SyncStatus(
        enabled=user.farcaster_sync_enabled,
        fid=user.farcaster_fid,
        linked_at=user.farcaster_sync_linked_at,
    )


@router.delete("", response_model=SyncStatus)
async def revoke_farcaster_sync(
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> SyncStatus:
    """Clear the user's Farcaster sync opt-in.

    Requires a first-party sign-in for the same reason as ``/link``:
    revocation is account-state mutation a partner JWT must not be
    able to silently perform.
    """
    await _enforce_link_rate_limit(fid, redis)
    user = await _load_user(db, fid)

    logger.debug("[farcaster-sync] user=%d revoking sync", fid)

    user.farcaster_fid = None
    user.farcaster_sync_enabled = False
    user.farcaster_sync_linked_at = None
    await db.commit()
    await db.refresh(user)

    return SyncStatus(enabled=False, fid=None, linked_at=None)


@router.get("", response_model=SyncStatus)
async def get_farcaster_sync_status(
    fid: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SyncStatus:
    """Return the current Farcaster sync opt-in state."""
    user = await _load_user(db, fid)
    return SyncStatus(
        enabled=user.farcaster_sync_enabled,
        fid=user.farcaster_fid,
        linked_at=user.farcaster_sync_linked_at,
    )
