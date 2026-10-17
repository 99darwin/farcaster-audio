"""Ancestor chain for a cast thread.

Hypersnap's ``/cast/conversation`` ignores ``include_chronological_parent_casts``,
so the parents above a reply are fetched by walking ``parent_hash`` one
``/cast`` lookup at a time. The result mirrors Neynar's
``chronological_parent_casts``: oldest first, ending at the focused cast's
direct parent.
"""

import asyncio
import json
import logging

import redis.asyncio as aioredis

from app.clients import hypersnap

logger = logging.getLogger(__name__)

# Deep reply chains are rare; past this the oldest context is dropped and the
# client links to the topmost fetched ancestor instead.
MAX_THREAD_ANCESTORS = 10
# The walk is sequential, so bound its total latency; a slow upstream yields a
# shorter chain rather than a slow thread read.
ANCESTOR_WALK_BUDGET_SECONDS = 3.0
# Ancestors are re-read whenever any reply below them is opened. Cache each
# raw hop briefly so popular threads don't refetch the same parents; counts
# may lag by up to this long.
ANCESTOR_CACHE_TTL_SECONDS = 300


def _cache_key(cast_hash: str) -> str:
    return f"thread:ancestor:{cast_hash}"


async def _fetch_cast(cast_hash: str, redis: aioredis.Redis) -> dict | None:
    cached = await redis.get(_cache_key(cast_hash))
    if cached:
        return json.loads(cached)
    data = await hypersnap.get("/cast", {"identifier": cast_hash, "type": "hash"})
    cast = data.get("cast")
    if not isinstance(cast, dict):
        return None
    await redis.set(
        _cache_key(cast_hash), json.dumps(cast), ex=ANCESTOR_CACHE_TTL_SECONDS
    )
    return cast


async def fetch_thread_ancestors(
    cast: dict,
    *,
    redis: aioredis.Redis,
    limit: int = MAX_THREAD_ANCESTORS,
) -> list[dict]:
    """Return ``cast``'s ancestors, oldest first, capped at ``limit``.

    The walk stops early on a missing/deleted parent, an upstream error or the
    time budget; the chain fetched so far is still returned so a single bad
    hop never fails the whole thread read.
    """
    ancestors: list[dict] = []
    seen = {cast.get("hash")}
    parent_hash = cast.get("parent_hash")
    try:
        async with asyncio.timeout(ANCESTOR_WALK_BUDGET_SECONDS):
            while parent_hash and parent_hash not in seen and len(ancestors) < limit:
                parent = await _fetch_cast(parent_hash, redis)
                if parent is None:
                    break
                seen.add(parent_hash)
                ancestors.append(parent)
                parent_hash = parent.get("parent_hash")
    except hypersnap.HypersnapError as exc:
        logger.info("[thread] ancestor %s unavailable: %s", parent_hash, exc)
    except TimeoutError:
        logger.info("[thread] ancestor walk timed out at %s", parent_hash)
    ancestors.reverse()
    return ancestors


def trim_hidden_ancestors(ancestors: list[dict], blocked_fids: set[int]) -> list[dict]:
    """Drop everything at or above the nearest blocked or spam ancestor.

    Removing a single hidden cast would leave the casts around it drawn as if
    one replied to the other, so the chain is cut there instead.
    """
    for index in range(len(ancestors) - 1, -1, -1):
        author = ancestors[index].get("author") or {}
        if author.get("fid") in blocked_fids or author.get("is_spam") is True:
            return ancestors[index + 1 :]
    return ancestors
