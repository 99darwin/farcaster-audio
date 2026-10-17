"""Backfill cast reaction counts that Hypersnap's by-hash reads leave at zero.

Hypersnap's feed reads (``/feed/following``, ``/feed/user/casts``) carry
indexer-backed ``reactions.likes_count``/``recasts_count``, but ``/cast``,
``/casts``, ``/cast/conversation``, ``/cast/search`` and ``/notifications``
report 0 for both (verified on haatz 0.13.5). :func:`hydrate_reaction_counts`
counts each cast's reactions on the hub (``/v1/reactionsByCast``) instead.

The hub only holds reactions still in their author's storage, so a popular
cast can count lower there than the indexer reports; the larger of the
upstream and hub counts is kept. Counts are cached briefly in Redis and
dropped by Juke's own reaction writes (:func:`invalidate_reaction_counts`).
Best-effort: a cast whose count lookup fails keeps its upstream counts.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.clients import hypersnap
from app.services.cast_bookmark_service import iter_cast_dicts

logger = logging.getLogger(__name__)

# One hub page answers exactly for nearly every cast; past the page cap the
# count is a lower bound (still kept only if larger than upstream's).
REACTION_COUNT_PAGE_SIZE = 1000
MAX_REACTION_COUNT_PAGES = 3
# Bounds upstream fan-out for one payload (threads can hold dozens of casts).
MAX_COUNTED_CASTS = 50
REACTION_COUNT_CONCURRENCY = 8
# Juke's own writes drop the key, so the TTL only bounds staleness for
# reactions made from other clients.
REACTION_COUNTS_CACHE_TTL_SECONDS = 30
REACTION_COUNTS_CACHE_PREFIX = "cast_reaction_counts:"
HUB_REACTION_TYPE_LIKE = "Like"
HUB_REACTION_TYPE_RECAST = "Recast"


@dataclass(frozen=True)
class ReactionCounts:
    likes: int
    recasts: int

    def to_json(self) -> str:
        return json.dumps({"likes": self.likes, "recasts": self.recasts})

    @classmethod
    def from_json(cls, raw: str | bytes) -> ReactionCounts:
        data = json.loads(raw)
        return cls(likes=int(data["likes"]), recasts=int(data["recasts"]))


def _cache_key(cast_hash: str) -> str:
    return REACTION_COUNTS_CACHE_PREFIX + cast_hash


async def invalidate_reaction_counts(
    redis: aioredis.Redis | None, cast_hash: str
) -> None:
    """Drop one cast's cached counts after a like/recast write."""
    if redis is None:
        return
    try:
        await redis.delete(_cache_key(cast_hash.lower()))
    except RedisError as exc:
        logger.warning("[reaction_counts] cache invalidation failed: %s", exc)


async def _read_cached_counts(
    redis: aioredis.Redis | None, hashes: list[str]
) -> dict[str, ReactionCounts]:
    if redis is None or not hashes:
        return {}
    try:
        raw_values = await redis.mget([_cache_key(h) for h in hashes])
    except RedisError as exc:
        logger.warning("[reaction_counts] cache read failed: %s", exc)
        return {}
    cached: dict[str, ReactionCounts] = {}
    for cast_hash, raw in zip(hashes, raw_values):
        if not isinstance(raw, (str, bytes)):
            continue
        try:
            cached[cast_hash] = ReactionCounts.from_json(raw)
        except (ValueError, KeyError, TypeError):
            continue
    return cached


async def _write_cached_counts(
    redis: aioredis.Redis | None, fetched: dict[str, ReactionCounts]
) -> None:
    if redis is None or not fetched:
        return
    try:
        pipe = redis.pipeline()
        for cast_hash, counts in fetched.items():
            pipe.set(
                _cache_key(cast_hash),
                counts.to_json(),
                ex=REACTION_COUNTS_CACHE_TTL_SECONDS,
            )
        await pipe.execute()
    except RedisError as exc:
        logger.warning("[reaction_counts] cache write failed: %s", exc)


async def _count_reactions(author_fid: int, cast_hash: str, reaction_type: str) -> int:
    """Count one cast's hub reactions of ``reaction_type`` (may raise)."""
    total = 0
    page_token: str | None = None
    for _ in range(MAX_REACTION_COUNT_PAGES):
        params: dict[str, Any] = {
            "target_fid": author_fid,
            "target_hash": cast_hash,
            "reaction_type": reaction_type,
            "pageSize": REACTION_COUNT_PAGE_SIZE,
        }
        if page_token:
            params["pageToken"] = page_token
        data = await hypersnap.get_v1("/reactionsByCast", params)
        messages = data.get("messages") or []
        total += len(messages)
        page_token = data.get("nextPageToken")
        if not page_token or not messages:
            break
    return total


async def _fetch_counts(cast: dict) -> ReactionCounts | None:
    """Hub counts for one cast; ``None`` when they cannot be determined."""
    author_fid = (cast.get("author") or {}).get("fid")
    if not isinstance(author_fid, int):
        return None
    cast_hash = cast["hash"]
    try:
        likes, recasts = await asyncio.gather(
            _count_reactions(author_fid, cast_hash, HUB_REACTION_TYPE_LIKE),
            _count_reactions(author_fid, cast_hash, HUB_REACTION_TYPE_RECAST),
        )
    except hypersnap.HypersnapError as exc:
        logger.warning("[reaction_counts] %s count failed: %s", cast_hash, exc)
        return None
    return ReactionCounts(likes=likes, recasts=recasts)


def _apply_counts(cast: dict, counts: ReactionCounts) -> None:
    reactions = cast.get("reactions")
    if not isinstance(reactions, dict):
        return
    reactions["likes_count"] = max(int(reactions.get("likes_count") or 0), counts.likes)
    reactions["recasts_count"] = max(
        int(reactions.get("recasts_count") or 0), counts.recasts
    )


async def hydrate_reaction_counts(
    payload: Any, *, redis: aioredis.Redis | None = None
) -> Any:
    """Raise ``likes_count``/``recasts_count`` on every cast to hub counts.

    ``payload`` must already have ``0x``-prefixed hashes. At most
    :data:`MAX_COUNTED_CASTS` distinct casts are counted, in payload order.
    Mutates in place and returns it.
    """
    casts_by_hash: dict[str, list[dict]] = {}
    for cast in iter_cast_dicts(payload):
        casts_by_hash.setdefault(cast["hash"].lower(), []).append(cast)
    hashes = list(casts_by_hash)[:MAX_COUNTED_CASTS]
    if not hashes:
        return payload

    counts = await _read_cached_counts(redis, hashes)
    misses = [h for h in hashes if h not in counts]
    if misses:
        semaphore = asyncio.Semaphore(REACTION_COUNT_CONCURRENCY)

        async def _bounded(cast: dict) -> ReactionCounts | None:
            async with semaphore:
                return await _fetch_counts(cast)

        results = await asyncio.gather(*(_bounded(casts_by_hash[h][0]) for h in misses))
        fetched = {h: c for h, c in zip(misses, results) if c is not None}
        await _write_cached_counts(redis, fetched)
        counts.update(fetched)

    for cast_hash, cast_counts in counts.items():
        for cast in casts_by_hash[cast_hash]:
            _apply_counts(cast, cast_counts)
    return payload
