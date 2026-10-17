"""The viewer's follow graph, read from Hypersnap and cached in Redis."""

from __future__ import annotations

import json
import logging

import redis.asyncio as aioredis

from app.clients import hypersnap

logger = logging.getLogger(__name__)

FOLLOWING_CACHE_PREFIX = "following_fids:"
FOLLOWING_CACHE_TTL = 300  # 5 minutes
FOLLOWING_PAGE_SIZE = 100
FOLLOWING_MAX_PAGES = 50  # caps the scan at 5,000 followed accounts


async def get_following_fids(redis: aioredis.Redis, fid: int) -> list[int]:
    """Fetch the FIDs ``fid`` follows from Hypersnap, with Redis caching.

    Bounded at ``FOLLOWING_MAX_PAGES`` pages; an upstream failure keeps the
    FIDs gathered so far (best-effort).
    """
    cache_key = f"{FOLLOWING_CACHE_PREFIX}{fid}"
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    following_fids: list[int] = []
    try:
        async for page in hypersnap.paginate(
            "/user/following",
            {"fid": fid, "limit": FOLLOWING_PAGE_SIZE},
            max_pages=FOLLOWING_MAX_PAGES,
        ):
            for item in page.get("users", []):
                # Hypersnap returns flat user objects; Neynar wrapped them in
                # {"user": {...}}. Accept both.
                user = item.get("user", item)
                if "fid" in user:
                    following_fids.append(user["fid"])
    except hypersnap.HypersnapError as exc:
        logger.error("[social_graph] Hypersnap following fetch failed: %s", exc)

    await redis.set(cache_key, json.dumps(following_fids), ex=FOLLOWING_CACHE_TTL)
    return following_fids
