"""Adapt Hypersnap read payloads to the Neynar-shaped contract clients expect.

Hypersnap's ``/v2/farcaster/*`` endpoints mirror Neynar's response shapes
closely, with three gaps that matter to Juke's clients (all verified live
against haatz):

1. **Hash format.** Cast hashes come back as bare hex (no ``0x``), while
   clients, bookmark storage and route validators all use ``0x``-prefixed
   hashes. :func:`normalize_cast_hashes` fixes that in place.
2. **No ``viewer_fid``.** Casts carry no ``viewer_context`` and users carry no
   follow state. ``POST /batch/cast-interactions`` was meant to fill this but
   on haatz it returns ``{mentions, parent_fid, timestamp}`` per FID, with no
   per-hash liked/recasted flags. Cast flags therefore come from the viewer's
   most recent reactions (``/v1/reactionsByFid``, newest first, cached
   briefly in Redis), plus exact ``/v1/reactionById`` lookups for the few
   casts older than that window; user flags come from ``/v1/linkById``.
3. **Unaggregated notifications.** Each like/recast/follow is its own row with
   a single ``user`` actor; clients expect Neynar's aggregated rows
   (``reactions``/``follows`` lists, ``count``, ``most_recent_timestamp``).

Hydration is best-effort: a flag is only written when it is known. An
upstream failure is logged and the affected flags are left unset, so clients
fall back to their own inference.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.clients import hypersnap
from app.services.cast_bookmark_service import iter_cast_dicts
from app.services.embed_metadata import hydrate_embed_metadata
from app.services.reaction_counts import hydrate_reaction_counts

logger = logging.getLogger(__name__)

CAST_HASH_KEYS = frozenset({"hash", "parent_hash", "thread_hash"})
_BARE_CAST_HASH_RE = re.compile(r"^[0-9a-fA-F]{40}$")

# How many of the viewer's newest likes (and, separately, recasts) are fetched
# to hydrate ``viewer_context``. A reaction is always newer than its target
# cast, so the window answers exactly for every cast newer than its oldest
# reaction. Older casts get an exact ``/v1/reactionById`` lookup (at most
# MAX_EXACT_REACTION_LOOKUPS per payload); past that bound the flag is unset.
VIEWER_REACTION_WINDOW = 500
MAX_EXACT_REACTION_LOOKUPS = 20
# The window only changes when the viewer reacts. Juke's own reaction writes
# drop the key (:func:`invalidate_viewer_reactions`), so the TTL only bounds
# staleness for reactions made from other clients.
VIEWER_REACTIONS_CACHE_TTL_SECONDS = 30
VIEWER_REACTIONS_CACHE_PREFIX = "viewer_reactions:"
HUB_REACTION_TYPE_LIKE = "Like"
HUB_REACTION_TYPE_RECAST = "Recast"
# Hub reaction type -> ``viewer_context`` key.
VIEWER_FLAG_BY_REACTION_TYPE = {
    HUB_REACTION_TYPE_LIKE: "liked",
    HUB_REACTION_TYPE_RECAST: "recasted",
}
HUB_LINK_TYPE_FOLLOW = "follow"
# Hub message timestamps are seconds since the Farcaster epoch (2021-01-01Z).
FARCASTER_EPOCH_UNIX_SECONDS = 1_609_459_200
# ``/v1/linkById`` and ``/v1/reactionById`` answer a missing record with HTTP
# 400 (``status: NotFound`` in the body) rather than 404.
HTTP_BAD_REQUEST = 400
HUB_NOT_FOUND_MARKER = "NotFound"

REACTION_NOTIFICATION_TYPES = frozenset({"likes", "recasts"})
FOLLOW_NOTIFICATION_TYPE = "follows"


# ---------------------------------------------------------------------------
# Hash normalization
# ---------------------------------------------------------------------------


def normalize_cast_hashes(payload: Any) -> Any:
    """Prefix bare 40-hex cast hashes with ``0x``, in place, at any depth."""
    if isinstance(payload, dict):
        for key, value in payload.items():
            if (
                key in CAST_HASH_KEYS
                and isinstance(value, str)
                and _BARE_CAST_HASH_RE.match(value)
            ):
                payload[key] = "0x" + value
            else:
                normalize_cast_hashes(value)
    elif isinstance(payload, list):
        for item in payload:
            normalize_cast_hashes(item)
    return payload


# ---------------------------------------------------------------------------
# Cast viewer context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReactionWindow:
    """The viewer's newest reactions of one type (lowercase target hashes).

    ``is_complete`` means the window holds the viewer's whole history.
    Otherwise it only proves a non-reaction for casts newer than
    ``oldest_unix``, the Unix time of its oldest reaction (``None`` when no
    reaction carried a timestamp, so nothing outside it is proven).
    """

    hashes: frozenset[str]
    is_complete: bool
    oldest_unix: int | None

    def flag_for(self, cast_hash: str, cast_unix: int | None) -> bool | None:
        """Whether the viewer reacted to the cast; ``None`` if unknown."""
        if cast_hash in self.hashes:
            return True
        if self.is_complete:
            return False
        if (
            cast_unix is not None
            and self.oldest_unix is not None
            and cast_unix > self.oldest_unix
        ):
            return False
        return None

    def to_json(self) -> str:
        return json.dumps(
            {
                "hashes": sorted(self.hashes),
                "is_complete": self.is_complete,
                "oldest_unix": self.oldest_unix,
            }
        )

    @classmethod
    def from_json(cls, raw: str) -> ReactionWindow:
        data = json.loads(raw)
        return cls(
            hashes=frozenset(data["hashes"]),
            is_complete=bool(data["is_complete"]),
            oldest_unix=data["oldest_unix"],
        )

    @classmethod
    def from_messages(cls, messages: list[Any]) -> ReactionWindow:
        hashes: set[str] = set()
        timestamps: list[int] = []
        for message in messages:
            data = (message or {}).get("data") or {}
            body = data.get("reactionBody") or {}
            target_hash = (body.get("targetCastId") or {}).get("hash")
            if isinstance(target_hash, str) and target_hash:
                hashes.add(target_hash.lower())
            if isinstance(data.get("timestamp"), int):
                timestamps.append(data["timestamp"])
        return cls(
            hashes=frozenset(hashes),
            is_complete=len(messages) < VIEWER_REACTION_WINDOW,
            oldest_unix=(
                min(timestamps) + FARCASTER_EPOCH_UNIX_SECONDS if timestamps else None
            ),
        )


def _reaction_cache_key(viewer_fid: int, reaction_type: str) -> str:
    return f"{VIEWER_REACTIONS_CACHE_PREFIX}{viewer_fid}:{reaction_type}"


async def invalidate_viewer_reactions(
    redis: aioredis.Redis | None, viewer_fid: int
) -> None:
    """Drop the viewer's cached reaction windows after a like/recast write."""
    if redis is None:
        return
    keys = [_reaction_cache_key(viewer_fid, t) for t in VIEWER_FLAG_BY_REACTION_TYPE]
    try:
        await redis.delete(*keys)
    except RedisError as exc:
        logger.warning("[hydration] reaction cache invalidation failed: %s", exc)


async def _read_cached_window(
    redis: aioredis.Redis | None, cache_key: str
) -> ReactionWindow | None:
    if redis is None:
        return None
    try:
        raw = await redis.get(cache_key)
    except RedisError as exc:
        logger.warning("[hydration] reaction cache read failed: %s", exc)
        return None
    if not isinstance(raw, (str, bytes)):
        return None
    try:
        return ReactionWindow.from_json(raw)
    except (ValueError, KeyError, TypeError):
        return None


async def _write_cached_window(
    redis: aioredis.Redis | None, cache_key: str, window: ReactionWindow
) -> None:
    if redis is None:
        return
    try:
        await redis.set(
            cache_key, window.to_json(), ex=VIEWER_REACTIONS_CACHE_TTL_SECONDS
        )
    except RedisError as exc:
        logger.warning("[hydration] reaction cache write failed: %s", exc)


async def _fetch_viewer_reaction_window(
    viewer_fid: int, reaction_type: str, redis: aioredis.Redis | None
) -> ReactionWindow | None:
    """Return the viewer's newest reactions (cached briefly when ``redis``).

    ``None`` means the lookup failed and the flag should stay unset.
    """
    cache_key = _reaction_cache_key(viewer_fid, reaction_type)
    cached = await _read_cached_window(redis, cache_key)
    if cached is not None:
        return cached
    try:
        data = await hypersnap.get_v1(
            "/reactionsByFid",
            {
                "fid": viewer_fid,
                "reaction_type": reaction_type,
                "pageSize": VIEWER_REACTION_WINDOW,
                "reverse": "true",
            },
        )
    except hypersnap.HypersnapError as exc:
        logger.warning(
            "[hydration] reactionsByFid %s failed for fid=%s: %s",
            reaction_type,
            viewer_fid,
            exc,
        )
        return None
    window = ReactionWindow.from_messages(data.get("messages") or [])
    await _write_cached_window(redis, cache_key, window)
    return window


def _is_hub_not_found(exc: hypersnap.HypersnapError) -> bool:
    if isinstance(exc, hypersnap.HypersnapNotFound):
        return True
    return exc.status_code == HTTP_BAD_REQUEST and HUB_NOT_FOUND_MARKER in exc.body


async def _reaction_exists(
    viewer_fid: int, cast: dict, reaction_type: str
) -> bool | None:
    """Exact check for one reaction; ``None`` if it cannot be determined."""
    author_fid = (cast.get("author") or {}).get("fid")
    if not isinstance(author_fid, int):
        return None
    try:
        await hypersnap.get_v1(
            "/reactionById",
            {
                "fid": viewer_fid,
                "reaction_type": reaction_type,
                "target_fid": author_fid,
                "target_hash": cast["hash"],
            },
        )
    except hypersnap.HypersnapError as exc:
        if _is_hub_not_found(exc):
            return False
        logger.warning("[hydration] reactionById %s failed: %s", reaction_type, exc)
        return None
    return True


def _cast_unix_seconds(cast: dict) -> int | None:
    timestamp = cast.get("timestamp")
    if not isinstance(timestamp, str):
        return None
    try:
        return int(datetime.fromisoformat(timestamp).timestamp())
    except ValueError:
        return None


async def hydrate_cast_viewer_context(
    payload: Any, viewer_fid: int, *, redis: aioredis.Redis | None = None
) -> Any:
    """Set ``viewer_context.liked``/``recasted`` on every cast in ``payload``.

    A flag is written only when known: from the viewer's reaction window for
    casts it covers, else from an exact lookup (bounded per payload). Unknown
    flags stay unset so clients fall back to their own inference.
    ``payload`` must already have ``0x``-prefixed hashes
    (:func:`normalize_cast_hashes`). Mutates in place and returns it.
    """
    casts = list(iter_cast_dicts(payload))
    if not casts:
        return payload
    reaction_types = list(VIEWER_FLAG_BY_REACTION_TYPE)
    windows = await asyncio.gather(
        *(_fetch_viewer_reaction_window(viewer_fid, t, redis) for t in reaction_types)
    )

    # Keyed by (lowercase hash, reaction type); a cast can appear twice.
    flags: dict[tuple[str, str], bool | None] = {}
    lookups: dict[tuple[str, str], dict] = {}
    for cast in casts:
        cast_hash = cast["hash"].lower()
        cast_unix = _cast_unix_seconds(cast)
        for reaction_type, window in zip(reaction_types, windows):
            key = (cast_hash, reaction_type)
            if window is None or key in flags:
                continue
            flags[key] = window.flag_for(cast_hash, cast_unix)
            if flags[key] is None and len(lookups) < MAX_EXACT_REACTION_LOOKUPS:
                lookups[key] = cast
    results = await asyncio.gather(
        *(_reaction_exists(viewer_fid, cast, t) for (_, t), cast in lookups.items())
    )
    flags.update(zip(lookups, results))

    for cast in casts:
        cast_hash = cast["hash"].lower()
        viewer_context = dict(cast.get("viewer_context") or {})
        for reaction_type, context_key in VIEWER_FLAG_BY_REACTION_TYPE.items():
            flag = flags.get((cast_hash, reaction_type))
            if flag is not None:
                viewer_context[context_key] = flag
        cast["viewer_context"] = viewer_context
    return payload


async def prepare_cast_payload(
    payload: Any,
    viewer_fid: int,
    *,
    redis: aioredis.Redis | None = None,
    backfill_reaction_counts: bool = False,
) -> Any:
    """Normalize hashes, then hydrate viewer flags and embed metadata — the
    standard read path.

    Set ``backfill_reaction_counts`` for payloads from Hypersnap reads that
    report zero reaction counts (see :mod:`app.services.reaction_counts`).
    """
    normalize_cast_hashes(payload)
    hydrations = [
        hydrate_cast_viewer_context(payload, viewer_fid, redis=redis),
        hydrate_embed_metadata(payload, redis=redis),
    ]
    if backfill_reaction_counts:
        hydrations.append(hydrate_reaction_counts(payload, redis=redis))
    await asyncio.gather(*hydrations)
    return payload


# ---------------------------------------------------------------------------
# User viewer context
# ---------------------------------------------------------------------------


async def _follow_exists(fid: int, target_fid: int) -> bool | None:
    """Whether ``fid`` follows ``target_fid``; ``None`` if the lookup failed."""
    try:
        await hypersnap.get_v1(
            "/linkById",
            {
                "fid": fid,
                "link_type": HUB_LINK_TYPE_FOLLOW,
                "target_fid": target_fid,
            },
        )
    except hypersnap.HypersnapNotFound:
        return False
    except hypersnap.HypersnapError as exc:
        if exc.status_code == HTTP_BAD_REQUEST:
            return False
        logger.warning("[hydration] linkById %s->%s failed: %s", fid, target_fid, exc)
        return None
    return True


async def hydrate_user_viewer_context(user: dict, viewer_fid: int) -> dict:
    """Set ``viewer_context.following``/``followed_by`` on one user dict."""
    target_fid = user.get("fid")
    if not isinstance(target_fid, int) or target_fid == viewer_fid:
        return user
    following, followed_by = await asyncio.gather(
        _follow_exists(viewer_fid, target_fid),
        _follow_exists(target_fid, viewer_fid),
    )
    viewer_context = dict(user.get("viewer_context") or {})
    if following is not None:
        viewer_context["following"] = following
    if followed_by is not None:
        viewer_context["followed_by"] = followed_by
    user["viewer_context"] = viewer_context
    return user


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


def _actor_entry(notification: dict) -> dict:
    return {"object": notification.get("type"), "user": notification.get("user")}


def _actor_fid(entry: dict) -> object:
    return (entry.get("user") or {}).get("fid")


def _append_actor(group: dict, list_key: str, notification: dict) -> None:
    entry = _actor_entry(notification)
    if any(_actor_fid(e) == _actor_fid(entry) for e in group[list_key]):
        return
    group[list_key].append(entry)
    group["count"] = len(group[list_key])


def _new_group(notification: dict, list_key: str) -> dict:
    group = {
        "object": "notification",
        "type": notification.get("type"),
        "most_recent_timestamp": notification.get("timestamp"),
        list_key: [],
        "count": 0,
    }
    if notification.get("cast") is not None:
        group["cast"] = notification["cast"]
    _append_actor(group, list_key, notification)
    return group


def adapt_notifications(notifications: Iterable[Any]) -> list[dict]:
    """Aggregate Hypersnap's per-actor notification rows Neynar-style.

    Likes/recasts on the same cast collapse into one row with a
    ``reactions`` list; all follows on the page collapse into one row with a
    ``follows`` list. Each group sits where its newest row was. Other types
    (reply, mention, quote) pass through with ``most_recent_timestamp``.
    Rows that already carry ``reactions``/``follows`` pass through untouched.
    """
    adapted: list[dict] = []
    reaction_groups: dict[tuple[str, str], dict] = {}
    follow_group: dict | None = None
    for notification in notifications:
        if not isinstance(notification, dict):
            continue
        ntype = notification.get("type")
        already_aggregated = "reactions" in notification or "follows" in notification
        if ntype in REACTION_NOTIFICATION_TYPES and not already_aggregated:
            cast_hash = (notification.get("cast") or {}).get("hash") or ""
            key = (ntype, cast_hash)
            group = reaction_groups.get(key)
            if group is None:
                group = reaction_groups[key] = _new_group(notification, "reactions")
                adapted.append(group)
            else:
                _append_actor(group, "reactions", notification)
            continue
        if ntype == FOLLOW_NOTIFICATION_TYPE and not already_aggregated:
            if follow_group is None:
                follow_group = _new_group(notification, "follows")
                adapted.append(follow_group)
            else:
                _append_actor(follow_group, "follows", notification)
            continue
        passthrough = dict(notification)
        passthrough.setdefault("most_recent_timestamp", notification.get("timestamp"))
        adapted.append(passthrough)
    return adapted
