"""
Notifications router — Hypersnap notifications with spam filtering.
"""

import json
import logging

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.dependencies import get_current_user, get_db, get_redis, get_spam_service
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from app.services.block_service import get_blocked_fids
from app.services.farcaster_hydration import adapt_notifications, prepare_cast_payload
from app.services.spam_service import SpamService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/notifications", tags=["notifications"])

CACHE_TTL_SECONDS = 10


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
    """Return the viewer's notifications (Hypersnap) with spam filtering."""
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

    try:
        data = await hypersnap.get(
            "/notifications",
            {"fid": current_user, "limit": limit, "cursor": cursor},
        )
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="notifications")

    # Hypersnap emits one row per actor; regroup into Neynar's aggregated
    # rows, then fix hashes and hydrate viewer flags on the embedded casts.
    notifications = adapt_notifications(data.get("notifications") or [])
    await prepare_cast_payload(
        notifications, current_user, redis=redis, backfill_reaction_counts=True
    )

    # Filter out spam actors from notifications
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
                    r.get("user"),
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
                    f.get("user"),
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
            if await spam_service.is_spam(fid, author):
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
