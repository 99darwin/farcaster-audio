"""Attach each reply's parent cast to feed payloads.

Hypersnap's feeds return replies with only ``parent_hash`` and
``parent_author.fid``, so a reply in the following feed renders with no
context. :func:`attach_parent_casts` looks up each distinct parent and sets
the full cast as ``parent_cast`` on the reply, so clients can render the
parent as a complete post above it (X's conversation layout). Callers hydrate
the attached parents' viewer state and reaction counts per request.

Hypersnap's bulk ``/casts`` lookup hangs when any requested cast is deleted
(verified on haatz), so parents are fetched one by one, each bounded by its own
timeout, and cached in Redis. Attachment is best-effort: a parent that cannot
be fetched leaves its replies without ``parent_cast``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.clients import hypersnap
from app.services.block_service import cast_author_fid
from app.services.farcaster_hydration import normalize_cast_hashes

logger = logging.getLogger(__name__)

# A live cast answers in well under a second; Hypersnap hangs on a deleted one.
PARENT_LOOKUP_TIMEOUT_SECONDS = 2.0
# Bounds upstream fan-out for one page (feeds allow up to 100 casts).
MAX_PARENT_LOOKUPS = 50
PARENT_CACHE_PREFIX = "parent_cast:v2:"
# Cast text is immutable and reaction counts are re-hydrated per request; the
# TTL only bounds author profile and embed staleness.
PARENT_CACHE_TTL_SECONDS = 10 * 60
# Deleted parents are cached as missing so they do not cost a timeout on
# every page load.
MISSING_PARENT_CACHE_TTL_SECONDS = 5 * 60
MISSING_PARENT_SENTINEL = "null"
_CAST_HASH_RE = re.compile(r"^0x[0-9a-f]{40}$")


def _parent_hash(cast: dict) -> str | None:
    """The reply's lowercased parent hash, or ``None`` if absent or malformed."""
    parent_hash = str(cast.get("parent_hash") or "").lower()
    return parent_hash if _CAST_HASH_RE.match(parent_hash) else None


def _cache_key(cast_hash: str) -> str:
    return PARENT_CACHE_PREFIX + cast_hash


async def _read_cached_parents(
    redis: aioredis.Redis | None, hashes: list[str]
) -> dict[str, dict | None]:
    """Return cached parents by hash; a ``None`` value means known-missing."""
    if redis is None or not hashes:
        return {}
    try:
        raw_values = await redis.mget([_cache_key(h) for h in hashes])
    except RedisError as exc:
        logger.warning("[parent_casts] cache read failed: %s", exc)
        return {}
    cached: dict[str, dict | None] = {}
    for cast_hash, raw in zip(hashes, raw_values):
        if not isinstance(raw, (str, bytes)):
            continue
        try:
            cached[cast_hash] = json.loads(raw)
        except ValueError:
            continue
    return cached


async def _write_cached_parents(
    redis: aioredis.Redis | None, fetched: dict[str, dict | None]
) -> None:
    if redis is None or not fetched:
        return
    try:
        pipe = redis.pipeline()
        for cast_hash, parent in fetched.items():
            if parent is None:
                pipe.set(
                    _cache_key(cast_hash),
                    MISSING_PARENT_SENTINEL,
                    ex=MISSING_PARENT_CACHE_TTL_SECONDS,
                )
            else:
                pipe.set(
                    _cache_key(cast_hash),
                    json.dumps(parent),
                    ex=PARENT_CACHE_TTL_SECONDS,
                )
        await pipe.execute()
    except RedisError as exc:
        logger.warning("[parent_casts] cache write failed: %s", exc)


async def _fetch_parent(cast_hash: str) -> tuple[bool, dict | None]:
    """Look up one parent; return ``(is_known, cast)``.

    ``is_known`` is false for transient failures, which are not cached. A
    timeout is treated as a deleted cast, since that is how Hypersnap answers
    one.
    """
    try:
        data = await asyncio.wait_for(
            hypersnap.get("/cast", {"identifier": cast_hash, "type": "hash"}),
            PARENT_LOOKUP_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        logger.info("[parent_casts] parent %s lookup timed out", cast_hash)
        return True, None
    except hypersnap.HypersnapNotFound:
        return True, None
    except hypersnap.HypersnapError as exc:
        logger.warning("[parent_casts] parent %s lookup failed: %s", cast_hash, exc)
        return False, None

    cast = data.get("cast", data)
    if not isinstance(cast, dict):
        return True, None
    normalize_cast_hashes(cast)
    if str(cast.get("hash", "")).lower() != cast_hash:
        return True, None
    return True, cast


async def attach_parent_casts(
    casts: list[dict],
    *,
    blocked_fids: set[int],
    redis: aioredis.Redis | None,
) -> list[dict]:
    """Set ``parent_cast`` on each reply in ``casts``, in place.

    Parents authored by a blocked user are not attached. Returns the distinct
    parents attached, for the caller to hydrate.
    """
    reply_parents = [(cast, _parent_hash(cast)) for cast in casts]
    parent_hashes = list(dict.fromkeys(h for _, h in reply_parents if h is not None))[
        :MAX_PARENT_LOOKUPS
    ]
    if not parent_hashes:
        return []

    parents = await _read_cached_parents(redis, parent_hashes)
    misses = [h for h in parent_hashes if h not in parents]
    if misses:
        results = await asyncio.gather(*(_fetch_parent(h) for h in misses))
        fetched = {
            cast_hash: parent
            for cast_hash, (is_known, parent) in zip(misses, results)
            if is_known
        }
        await _write_cached_parents(redis, fetched)
        parents.update(fetched)

    attached: dict[str, dict] = {}
    for cast, parent_hash in reply_parents:
        parent = parents.get(parent_hash) if parent_hash else None
        if parent is None or cast_author_fid(parent) in blocked_fids:
            continue
        cast["parent_cast"] = parent
        attached[parent_hash] = parent
    return list(attached.values())
