"""Read-only Farcaster-native audio-spaces discovery routes.

Thin authenticated proxy over `FarcasterSpacesService`. Adds a 5-minute
per-(route,query) Redis cache on successful responses to absorb the
Farcaster client's discovery-strip polling pattern and to bound the
upstream call rate.

All endpoints require a Juke JWT (via ``get_current_user``). Returns:

  - 503 if the service-FID is unconfigured (custody key empty).
  - 502 on any upstream / network / parsing failure (with a redacted
    ``detail`` — the upstream body is never forwarded).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request

from app.clients import hypersnap
from app.config import settings
from app.dependencies import get_current_user, get_redis
from app.schemas.farcaster_spaces import (
    AudioRoom,
    AudioRoomChatMessage,
    AudioRoomParticipant,
    FarcasterSpacesConfigError,
)
from app.services.farcaster_spaces_service import FarcasterSpacesService
from app.services.rate_limit import RateLimit, enforce_rate_limits

logger = logging.getLogger(__name__)

# Every route proxies the service-FID bearer upstream, so one account must
# not be able to burn the shared upstream budget. Sized well above normal
# use (in-room participant polling every 5 s plus chat and list refreshes).
DISCOVERY_RATE_LIMIT = RateLimit(limit=240, window_seconds=60)
DISCOVERY_RATE_KEY = "farcaster_spaces:rl:{fid}"


async def enforce_discovery_rate_limit(
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
) -> None:
    """Per-fid budget shared by every discovery route."""
    await enforce_rate_limits(
        redis, [(DISCOVERY_RATE_KEY.format(fid=fid), DISCOVERY_RATE_LIMIT)]
    )


router = APIRouter(
    prefix="/v1/farcaster-spaces",
    tags=["farcaster-spaces"],
    dependencies=[Depends(enforce_discovery_rate_limit)],
)


def _future_scheduled_rooms(rooms: list[AudioRoom] | list[dict[str, Any]]) -> list:
    """Keep only upstream scheduled rows with an authoritative future time.

    Applied to cached and fresh payloads so an upstream/cache lag cannot keep a
    past event in clients' Upcoming sections.
    """
    now = datetime.now(tz=timezone.utc)
    future = []
    for room in rooms:
        value = (
            room.scheduled_at
            if isinstance(room, AudioRoom)
            else (
                room.get("scheduled_at", room.get("scheduledAt"))
                if isinstance(room, dict)
                else None
            )
        )
        if isinstance(value, str):
            try:
                value = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                value = None
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            if value > now:
                future.append(room)
    return future


CACHE_TTL_SECONDS = 5 * 60
# Participants is a special case: the iOS client polls it every 5s to
# detect pending stage invites. The default 5-min TTL on the discovery
# cache made the poll see snapshots up to 5 minutes stale → invitee
# saw the banner, tapped Accept, upstream said "No pending stage
# invite found". 10s is short enough that the poll catches invites
# within one tick of upstream creating them.
PARTICIPANTS_CACHE_TTL_SECONDS = 10
# Bumped from `fcsp:disc:` → v2 (#231, pfp_url enrichment) → v3
# (#233 — response shape changed from camelCase to snake_case after
# we set `response_model_by_alias=False`). The version bump bypasses
# old cached payloads instantly on deploy instead of waiting for them
# to TTL out.
CACHE_PREFIX = "fcsp:disc:v3:"
# Defensive cap on path-segment length when used in cache keys.
MAX_ROOM_ID_LEN = 128

# Bulk-by-fids enrichment for participants whose upstream
# payload is missing pfp_url / display_name. Upstream's
# /v1/audio-room/participants returns participants with `fid` and
# `username` but inconsistently populates pfp / displayName — so we
# backfill via Hypersnap's user/bulk. Per-fid result cached for 1h; bulk
# request size capped to one call (up to 100 fids per bulk call, so a
# reasonable spaces participant count fits in a single fetch).
# Bumped to v2 alongside the null-pfp-no-longer-cached change —
# previously a response without a pfp_url got cached for 1h and served
# as "no pfp" forever, even after upstream started returning one.
PFP_CACHE_PREFIX = "fcsp:pfp:v2:"
PFP_CACHE_TTL_SECONDS = 60 * 60
USER_BULK_MAX_FIDS_PER_CALL = 100


async def _enrich_user_pfps(
    user_dicts: list[dict[str, Any]], redis: aioredis.Redis
) -> None:
    """Backfill ``pfp_url`` and ``display_name`` on a flat list of user
    dicts using Hypersnap's user/bulk endpoint.

    The input is a list of mutable SpaceUser dicts — same shape whether
    they came from a room ``host`` or a ``participant.user``. The
    caller normalizes both shapes to this flat list.

    Idempotent on already-populated fields — only writes when the
    upstream payload left them blank/null. Cached per-fid in Redis to
    bound the upstream call rate across discovery polls.

    Best-effort: any cache or Hypersnap error is swallowed. Never raises.
    """
    if not user_dicts:
        return

    needed: list[int] = []
    by_fid: dict[int, list[dict[str, Any]]] = {}
    for user in user_dicts:
        if not isinstance(user, dict):
            continue
        fid = user.get("fid")
        if not isinstance(fid, int) or fid <= 0:
            continue
        # Only enrich rows that need it. If both pfp_url and
        # display_name are non-empty, skip the lookup entirely.
        has_pfp = isinstance(user.get("pfp_url"), str) and user["pfp_url"]
        has_name = isinstance(user.get("display_name"), str) and user["display_name"]
        if has_pfp and has_name:
            continue
        bucket = by_fid.setdefault(fid, [])
        if not bucket:
            needed.append(fid)
        bucket.append(user)

    if not needed:
        return

    # Cap to a single bulk call. If the room has >100 participants
    # we accept partial enrichment rather than fan out.
    needed = needed[:USER_BULK_MAX_FIDS_PER_CALL]

    # Read from cache first to avoid re-fetching frequently-seen fids.
    cache_keys = [f"{PFP_CACHE_PREFIX}{f}" for f in needed]
    cached_vals: list[Any] = []
    try:
        cached_vals = await redis.mget(*cache_keys)
    except Exception as exc:  # pragma: no cover — redis flakiness
        logger.debug("[fcsp-participants] redis mget failed: %s", type(exc).__name__)
        cached_vals = [None] * len(needed)

    missing: list[int] = []
    for fid, raw in zip(needed, cached_vals):
        if raw is None:
            missing.append(fid)
            continue
        try:
            obj = json.loads(raw if isinstance(raw, str) else raw.decode())
        except Exception:
            obj = None
        if isinstance(obj, dict):
            for user in by_fid[fid]:
                if not user.get("pfp_url") and isinstance(obj.get("pfp_url"), str):
                    user["pfp_url"] = obj["pfp_url"]
                if not user.get("display_name") and isinstance(
                    obj.get("display_name"), str
                ):
                    user["display_name"] = obj["display_name"]

    if not missing:
        return

    try:
        data = await hypersnap.get(
            "/user/bulk", {"fids": ",".join(str(f) for f in missing)}
        )
    except hypersnap.HypersnapError as exc:
        # WARNING-level so rate-limiting (429) or 5xx upstreams show up.
        logger.warning(
            "[fcsp-enrich] hypersnap bulk failed: status=%s %s",
            exc.status_code,
            type(exc).__name__,
        )
        return

    users = data.get("users")
    if not isinstance(users, list):
        logger.warning("[fcsp-enrich] hypersnap bulk returned non-list users payload")
        return

    pipe = None
    try:
        pipe = redis.pipeline()
    except Exception:  # pragma: no cover
        pipe = None

    n_pfp = 0
    n_name = 0
    n_cached = 0
    for nu in users:
        if not isinstance(nu, dict):
            continue
        fid = nu.get("fid")
        if not isinstance(fid, int):
            continue
        bucket = by_fid.get(fid)
        if not bucket:
            continue
        pfp = nu.get("pfp_url")
        display = nu.get("display_name")
        # Only cache rows where upstream returned at least a pfp_url —
        # caching a null result poisons the per-fid cache for an hour
        # and we'd re-serve initials even after upstream starts returning
        # real data for that fid.
        cacheable = isinstance(pfp, str) and pfp
        for user in bucket:
            if isinstance(pfp, str) and pfp and not user.get("pfp_url"):
                user["pfp_url"] = pfp
                n_pfp += 1
            if isinstance(display, str) and display and not user.get("display_name"):
                user["display_name"] = display
                n_name += 1
        if cacheable and pipe is not None:
            try:
                pipe.set(
                    f"{PFP_CACHE_PREFIX}{fid}",
                    json.dumps(
                        {
                            "pfp_url": pfp,
                            "display_name": (
                                display if isinstance(display, str) else None
                            ),
                        }
                    ),
                    ex=PFP_CACHE_TTL_SECONDS,
                )
                n_cached += 1
            except Exception:  # pragma: no cover
                pass

    logger.info(
        "[fcsp-enrich] hypersnap bulk: requested=%d returned=%d "
        "pfp_writes=%d name_writes=%d cached=%d",
        len(missing),
        len(users),
        n_pfp,
        n_name,
        n_cached,
    )

    if pipe is not None:
        try:
            await pipe.execute()
        except Exception as exc:  # pragma: no cover
            logger.debug(
                "[fcsp-participants] redis pipeline exec failed: %s",
                type(exc).__name__,
            )


def _collect_room_user_dicts(rooms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten the `host` dict out of a list of AudioRoom dicts for
    bulk enrichment."""
    out: list[dict[str, Any]] = []
    for r in rooms:
        if not isinstance(r, dict):
            continue
        host = r.get("host")
        if isinstance(host, dict):
            out.append(host)
    return out


def _collect_participant_user_dicts(
    participants: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Flatten the `user` dict out of a list of AudioRoomParticipant dicts."""
    out: list[dict[str, Any]] = []
    for p in participants:
        if not isinstance(p, dict):
            continue
        user = p.get("user")
        if isinstance(user, dict):
            out.append(user)
    return out


# Backwards-compatible alias for the participants-shaped helper used by
# the existing test file. The new generic implementation lives in
# `_enrich_user_pfps`.
async def _enrich_participant_pfps(
    participants: list[dict[str, Any]], redis: aioredis.Redis
) -> None:
    await _enrich_user_pfps(_collect_participant_user_dicts(participants), redis)


def _service(request: Request) -> FarcasterSpacesService:
    """Return the shared FarcasterSpacesService.

    The instance is constructed eagerly at lifespan startup so that the
    bearer-mint asyncio.Lock + httpx.AsyncClient are a single per-process
    singleton. We fall back to a fresh instance only when the lifespan
    hook didn't run (e.g. ASGITransport-based tests that mount the app
    without the startup hook) — this keeps unit tests of unrelated
    routers from crashing on import.
    """
    svc = getattr(request.app.state, "farcaster_spaces_service", None)
    if svc is None:
        svc = FarcasterSpacesService(settings)
        request.app.state.farcaster_spaces_service = svc
    return svc


def _cache_key(route: str, **params: Any) -> str:
    parts = [route]
    for k in sorted(params.keys()):
        parts.append(f"{k}={params[k]}")
    return CACHE_PREFIX + "|".join(parts)


async def _cache_get(redis: aioredis.Redis, key: str) -> Any | None:
    try:
        raw = await redis.get(key)
    except Exception as e:
        logger.warning("[farcaster-spaces] cache GET %s failed: %s", key, e)
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


async def _cache_set(
    redis: aioredis.Redis,
    key: str,
    value: Any,
    *,
    ttl_seconds: int = CACHE_TTL_SECONDS,
) -> None:
    try:
        await redis.setex(key, ttl_seconds, json.dumps(value))
    except Exception as e:
        logger.warning("[farcaster-spaces] cache SETEX %s failed: %s", key, e)


async def invalidate_participants_cache(redis: aioredis.Redis, room_id: str) -> None:
    """Drop the cached participants response for a room.

    Called after writes that change the participants payload (accept /
    decline stage-invite, accept-speaker, etc.) so the next poll picks
    up fresh data instead of waiting for the 10s TTL to expire.
    Best-effort — Redis errors are logged and swallowed.
    """
    key = _cache_key("participants", room_id=room_id)
    try:
        await redis.delete(key)
    except Exception as e:  # pragma: no cover — best-effort
        logger.warning(
            "[farcaster-spaces] participants cache DEL %s failed: %s", key, e
        )


def _validate_room_id(room_id: str) -> str:
    """Cheap path-input hygiene before it hits the upstream / cache key."""
    if not room_id or len(room_id) > MAX_ROOM_ID_LEN:
        raise HTTPException(status_code=400, detail="Invalid room_id")
    # Disallow control characters and obvious URL-injection bytes.
    if any(c in room_id for c in ("\n", "\r", " ", "?", "#", "/")):
        raise HTTPException(status_code=400, detail="Invalid room_id")
    return room_id


# ---------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------


@router.get(
    "/live",
    response_model=list[AudioRoom],
    response_model_by_alias=False,
)
async def list_live(
    request: Request,
    limit: int = Query(default=30, ge=1, le=100),
    _fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    key = _cache_key("live", limit=limit)
    cached = await _cache_get(redis, key)
    if cached is not None:
        return cached
    svc = _service(request)
    try:
        rooms = await svc.list_live_rooms(limit=limit)
    except FarcasterSpacesConfigError:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces discovery not configured",
        )
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("[farcaster-spaces] /live upstream error: %s", type(e).__name__)
        raise HTTPException(status_code=502, detail="Upstream Farcaster API error")
    payload = [r.model_dump(mode="json") for r in rooms]
    await _enrich_user_pfps(_collect_room_user_dicts(payload), redis)
    await _cache_set(redis, key, payload)
    return payload


@router.get(
    "/scheduled",
    response_model=list[AudioRoom],
    response_model_by_alias=False,
)
async def list_scheduled(
    request: Request,
    limit: int = Query(default=30, ge=1, le=100),
    _fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    key = _cache_key("scheduled", limit=limit)
    cached = await _cache_get(redis, key)
    if cached is not None:
        return _future_scheduled_rooms(cached)
    svc = _service(request)
    try:
        rooms = _future_scheduled_rooms(await svc.list_scheduled_rooms(limit=limit))
    except FarcasterSpacesConfigError:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces discovery not configured",
        )
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "[farcaster-spaces] /scheduled upstream error: %s",
            type(e).__name__,
        )
        raise HTTPException(status_code=502, detail="Upstream Farcaster API error")
    payload = [r.model_dump(mode="json") for r in rooms]
    await _enrich_user_pfps(_collect_room_user_dicts(payload), redis)
    await _cache_set(redis, key, payload)
    return payload


@router.get(
    "/{room_id}",
    response_model=AudioRoom,
    response_model_by_alias=False,
)
async def get_room(
    request: Request,
    room_id: str = Path(..., max_length=MAX_ROOM_ID_LEN),
    _fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    rid = _validate_room_id(room_id)
    key = _cache_key("room", room_id=rid)
    cached = await _cache_get(redis, key)
    if cached is not None:
        return cached
    svc = _service(request)
    try:
        room = await svc.get_room(rid)
    except FarcasterSpacesConfigError:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces discovery not configured",
        )
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "[farcaster-spaces] /{room} upstream error: %s", type(e).__name__
        )
        raise HTTPException(status_code=502, detail="Upstream Farcaster API error")
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    payload = room.model_dump(mode="json")
    await _enrich_user_pfps(_collect_room_user_dicts([payload]), redis)
    await _cache_set(redis, key, payload)
    return payload


@router.get(
    "/{room_id}/participants",
    response_model=list[AudioRoomParticipant],
    response_model_by_alias=False,
)
async def get_participants(
    request: Request,
    room_id: str = Path(..., max_length=MAX_ROOM_ID_LEN),
    _fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    rid = _validate_room_id(room_id)
    key = _cache_key("participants", room_id=rid)
    cached = await _cache_get(redis, key)
    if cached is not None:
        return cached
    svc = _service(request)
    try:
        participants = await svc.get_participants(rid)
    except FarcasterSpacesConfigError:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces discovery not configured",
        )
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "[farcaster-spaces] /participants upstream error: %s",
            type(e).__name__,
        )
        raise HTTPException(status_code=502, detail="Upstream Farcaster API error")
    payload = [p.model_dump(mode="json") for p in participants]
    # Upstream's participant payload is inconsistent about pfp_url and
    # display_name — leaves them null for many speakers/listeners.
    # Backfill via Hypersnap so the in-app player can render real PFPs +
    # display names instead of initials-only fallbacks. Best-effort —
    # cache misses fall through; upstream errors leave the payload alone.
    await _enrich_user_pfps(_collect_participant_user_dicts(payload), redis)
    # Shorter TTL than the rest of the discovery cache — iOS polls this
    # endpoint every 5s to detect pending stage invites and a stale
    # snapshot causes the invitee to tap Accept on an already-cleared
    # invite (upstream → 400 "No pending stage invite found").
    await _cache_set(
        redis,
        key,
        payload,
        ttl_seconds=PARTICIPANTS_CACHE_TTL_SECONDS,
    )
    return payload


@router.get(
    "/{room_id}/chat",
    response_model=list[AudioRoomChatMessage],
    response_model_by_alias=False,
)
async def get_chat(
    request: Request,
    room_id: str = Path(..., max_length=MAX_ROOM_ID_LEN),
    _fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    rid = _validate_room_id(room_id)
    key = _cache_key("chat", room_id=rid)
    cached = await _cache_get(redis, key)
    if cached is not None:
        return cached
    svc = _service(request)
    try:
        messages = await svc.get_chat(rid)
    except FarcasterSpacesConfigError:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces discovery not configured",
        )
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("[farcaster-spaces] /chat upstream error: %s", type(e).__name__)
        raise HTTPException(status_code=502, detail="Upstream Farcaster API error")
    payload = [m.model_dump(mode="json") for m in messages]
    await _cache_set(redis, key, payload)
    return payload
