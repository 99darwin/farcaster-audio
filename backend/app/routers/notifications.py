"""
Notifications router — proxies Neynar notifications API with spam filtering.
"""

import json
import logging

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_current_user, get_db, get_redis, get_spam_service
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from app.services.block_service import get_blocked_fids
from app.services.spam_service import SpamService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/notifications", tags=["notifications"])

NEYNAR_BASE = "https://api.neynar.com/v2"
CACHE_TTL_SECONDS = 10


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


@router.get("")
async def get_notifications(
    limit: int = Query(default=25, ge=1, le=50),
    cursor: str | None = Query(
        default=None, max_length=500, pattern=r"^[a-zA-Z0-9_\-=.%]+$"
    ),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
    spam_service: SpamService = Depends(get_spam_service),
):
    """Proxy Neynar notifications endpoint with spam filtering."""
    blocked_fids = await get_blocked_fids(db, current_user)
    blocked_key = ",".join(str(fid) for fid in sorted(blocked_fids)) or "none"
    cache_key = f"notif:{current_user}:{limit}:{cursor or 'none'}:{blocked_key}"

    # Try cache first; fall through on any Redis error.
    try:
        cached = await redis.get(cache_key)
        if cached:
            cached_response = json.loads(cached)
            await annotate_bookmarked_casts(db, current_user, cached_response)
            return cached_response
    except Exception as e:
        logger.warning("[notifications] Redis GET failed: %s", e)

    params: dict[str, str | int] = {"fid": current_user, "limit": limit}
    if cursor:
        params["cursor"] = cursor

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/notifications",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        logger.error(
            "[notifications] Neynar %s → %s: %s",
            resp.request.url.path,
            resp.status_code,
            resp.text[:500],
        )
        status = 502 if resp.status_code >= 500 else resp.status_code
        raise HTTPException(status_code=status, detail="Upstream service error")

    data = resp.json()

    # Filter out spam actors from notifications
    notifications = data.get("notifications", [])
    filtered = []
    for n in notifications:
        ntype = n.get("type")
        if ntype in ("likes", "recasts"):
            # Strip spam reactors; drop notification if none remain
            good = [
                r
                for r in n.get("reactions", [])
                if r.get("user", {}).get("fid") not in blocked_fids
                if not await spam_service.is_spam(
                    r.get("user", {}).get("fid", 0),
                    r.get("user", {}).get("experimental", {}).get("neynar_user_score"),
                )
            ]
            if not good:
                continue
            n = {**n, "reactions": good, "count": len(good)}
        elif ntype == "follows":
            good = [
                f
                for f in n.get("follows", [])
                if f.get("user", {}).get("fid") not in blocked_fids
                if not await spam_service.is_spam(
                    f.get("user", {}).get("fid", 0),
                    f.get("user", {}).get("experimental", {}).get("neynar_user_score"),
                )
            ]
            if not good:
                continue
            n = {**n, "follows": good, "count": len(good)}
        elif ntype in ("reply", "mention", "quote"):
            author = n.get("cast", {}).get("author", {})
            fid = author.get("fid", 0)
            if fid in blocked_fids:
                continue
            neynar_score = author.get("experimental", {}).get("neynar_user_score")
            if await spam_service.is_spam(fid, neynar_score):
                continue
        filtered.append(n)

    response = {
        "notifications": filtered,
        "next": data.get("next", {"cursor": None}),
    }

    # Cache filtered response to absorb bursty duplicate calls.
    try:
        await redis.setex(cache_key, CACHE_TTL_SECONDS, json.dumps(response))
    except Exception as e:
        logger.warning("[notifications] Redis SETEX failed: %s", e)

    await annotate_bookmarked_casts(db, current_user, response)
    return response
