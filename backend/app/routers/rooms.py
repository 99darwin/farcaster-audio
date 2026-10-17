"""
Rooms router — CRUD endpoints for audio room lifecycle.

Endpoints:
  GET  /v1/rooms              List active or scheduled rooms (paginated)
  POST /v1/rooms              Create a new room (immediate or scheduled)
  GET  /v1/rooms/{room_id}   Get room detail with live participants
  POST /v1/rooms/{room_id}/start  Start a scheduled room (host only)
  DELETE /v1/rooms/{room_id} End an active room (host/co-host only)
"""

import asyncio
import contextlib
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx
import redis.asyncio as aioredis
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import (
    get_db,
    get_optional_current_user,
    get_redis,
    pubsub_redis,
    require_first_party_user,
    require_non_demo_user,
)
from app.models.developer import DeveloperApp
from app.models.room import Room
from app.models.user import User
from app.schemas.auth import UserResponse
from app.schemas.common import StatusResponse
from app.schemas.farcaster_spaces import FarcasterSpacesConfigError
from app.schemas.room import (
    CreateNativeRoomRequest,
    EndNativeRoomRequest,
    LinkFarcasterRoomRequest,
    MirrorNativeRoomRequest,
    NativeAcceptSpeakerRequest,
    NativeHeartbeatRequest,
    NativeJoinRequest,
    NativeJoinResponse,
    NativeRaiseHandRequest,
    NativeRemoveSpeakerRequest,
    NativeStageInviteResponseRequest,
    StartNativeRoomRequest,
    RoomCreate,
    RoomCreateResponse,
    RoomDetailResponse,
    RoomEmbedPolicyResponse,
    RoomGoLiveResponse,
    RoomListResponse,
    RoomResponse,
    RsvpResponse,
)
from app.routers.spaces_discovery import (
    _enrich_user_pfps,
    invalidate_participants_cache,
)
from app.services.farcaster_spaces_service import FarcasterSpacesService

# JFS bearer decode/constants live in ``app.services.jfs`` now (shared with
# the managed-signer mint path). Re-exported here under the historical
# private names so existing callers and tests in this module are untouched;
# the constants are re-exported for backwards compatibility (noqa: F401).
from app.services.jfs import (  # noqa: F401
    JFS_EXPECTED_AUDIENCE,
    JFS_MAX_CLOCK_SKEW_SECONDS,
    decode_jfs_bearer as _decode_jfs_bearer,
)
from app.services.livekit_service import LiveKitService
from app.services.push_service import PushService
from app.services.redis_service import RedisService
from app.services.client_ip import client_ip
from app.services.rate_limit import ConnectionLease, try_acquire_connection_lease
from app.services.room_service import RoomService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/rooms", tags=["rooms"])


async def get_room_service(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    redis_service = RedisService(redis)
    livekit_service = LiveKitService()
    # Pull Phase-4 collaborators from app state. Both default to
    # ``None`` when the lifespan hasn't wired them (e.g. tests using
    # ASGI transport that skip lifespan). The native-room recording
    # path raises a 503 when either is missing.
    fcsp = getattr(request.app.state, "farcaster_spaces_service", None)
    recording_agent = getattr(request.app.state, "recording_agent_service", None)
    try:
        yield RoomService(
            db,
            redis_service,
            livekit_service,
            farcaster_spaces=fcsp,
            recording_agent=recording_agent,
        )
    finally:
        await livekit_service.close()


MIN_SCHEDULE_AHEAD = timedelta(minutes=5)
MAX_SCHEDULE_AHEAD = timedelta(days=30)

# Map upstream Farcaster participant roles onto Juke's role vocabulary for the
# native-join response. Farcaster uses ``cohost``; Juke uses ``co_host``.
_NATIVE_JOIN_ROLE_MAP: dict[str, str] = {
    "host": "host",
    "cohost": "co_host",
    "co_host": "co_host",
    "speaker": "speaker",
    "listener": "listener",
}

# Per-user rate limit on Farcaster-native room link calls. Bounds
# how fast a misbehaving client (or a stolen first-party JWT) can
# spam Juke's discovery surface with bogus mappings.
LINK_FARCASTER_RATE_LIMIT_PER_MIN = 10
LINK_FARCASTER_RATE_LIMIT_WINDOW_SECONDS = 60

# Per-user rate limit on backend-orchestrated Farcaster-native room
# creation. Same shape as ``LINK_FARCASTER_*`` — bounds how fast a
# stolen first-party JWT can spam ``client.farcaster.xyz`` via Juke's
# service-FID bearer (which is the high-value secret here).
NATIVE_CREATE_RATE_LIMIT_PER_MIN = 10
NATIVE_CREATE_RATE_LIMIT_WINDOW_SECONDS = 60

# Per-user rate limit on ending a Farcaster-native room. Tighter than
# create because (a) only the host can end one, (b) double-ends are
# idempotent server-side so a runaway client just burns its own quota.
NATIVE_END_RATE_LIMIT_PER_MIN = 5
NATIVE_END_RATE_LIMIT_WINDOW_SECONDS = 60

# Per-user rate limit on requesting LiveKit join creds for a
# Farcaster-native room. Loose ceiling — a flaky client retrying a few
# times on a bad network is fine; a runaway loop is not. Upstream join
# tokens have their own TTL so we don't need to be miserly here.
NATIVE_JOIN_RATE_LIMIT_PER_MIN = 30
NATIVE_JOIN_RATE_LIMIT_WINDOW_SECONDS = 60

# Upstream Farcaster client surfaces tend to truncate display titles
# beyond ~200 chars (matches the cap on
# ``LinkFarcasterRoomRequest.title``). Reserve enough headroom for the
# username prefix so we never blow past that limit.
MAX_UPSTREAM_TITLE_CHARS = 200
MAX_USERNAME_PREFIX_CHARS = 50


async def _enforce_link_farcaster_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    rate_key = f"rooms:link_farcaster:rl:{fid}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, LINK_FARCASTER_RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if int(count) > LINK_FARCASTER_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Farcaster room link rate limit exceeded. Try again later.",
            headers={"Retry-After": str(LINK_FARCASTER_RATE_LIMIT_WINDOW_SECONDS)},
        )


async def _enforce_native_create_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    rate_key = f"rooms:native_create:rl:{fid}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, NATIVE_CREATE_RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if int(count) > NATIVE_CREATE_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Native room create rate limit exceeded. Try again later.",
            headers={"Retry-After": str(NATIVE_CREATE_RATE_LIMIT_WINDOW_SECONDS)},
        )


async def _enforce_native_end_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    rate_key = f"rooms:native_end:rl:{fid}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, NATIVE_END_RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if int(count) > NATIVE_END_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Native room end rate limit exceeded. Try again later.",
            headers={"Retry-After": str(NATIVE_END_RATE_LIMIT_WINDOW_SECONDS)},
        )


async def _enforce_native_join_rate_limit(
    fid: int, room_uuid: uuid.UUID, redis: aioredis.Redis
) -> None:
    # Per-(fid, room) counter — keeps the budget room-scoped so a user
    # hopping between rooms isn't starved by one. The TTL is only set on
    # first increment so the window doesn't slide indefinitely under
    # steady traffic.
    rate_key = f"rooms:native_join:rl:{fid}:{room_uuid}"
    count = await redis.incr(rate_key)
    if int(count) == 1:
        await redis.expire(rate_key, NATIVE_JOIN_RATE_LIMIT_WINDOW_SECONDS)
    if int(count) > NATIVE_JOIN_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Native room join rate limit exceeded. Try again later.",
            headers={"Retry-After": str(NATIVE_JOIN_RATE_LIMIT_WINDOW_SECONDS)},
        )


def _build_upstream_title(*, username: str, user_title: str) -> str:
    """Prefix ``user_title`` with ``@{username}: `` while keeping the
    result within the upstream title cap.

    Edge cases:
      * Very long username — when ``@{username}: `` itself would exceed
        ``MAX_USERNAME_PREFIX_CHARS`` we truncate the username portion
        (preserving the leading ``@`` and trailing ``: ``) so the
        prefix never crowds out the user's actual title.
      * Total over cap — the user title portion is truncated so the
        prefix + title stays at or below ``MAX_UPSTREAM_TITLE_CHARS``.
      * Empty / whitespace title — already rejected upstream by the
        Pydantic ``min_length=1`` validator; this helper is a no-op for
        them.

    The result is always 1..``MAX_UPSTREAM_TITLE_CHARS`` characters.
    """
    # Defensive: trim incidental whitespace on the username (it's
    # stored on ``users.username`` post-Neynar; in practice it never
    # carries surrounding whitespace, but the prefix shape matters and
    # ``@ alice: `` would look wrong).
    username = username.strip()
    prefix = f"@{username}: "
    if len(prefix) > MAX_USERNAME_PREFIX_CHARS:
        # Reserve room for the leading ``@`` and trailing ``: `` (3
        # chars). The truncated username keeps its prefix discriminator
        # so the title still reads as an attribution.
        truncated_username = username[: MAX_USERNAME_PREFIX_CHARS - 3]
        prefix = f"@{truncated_username}: "

    remaining = MAX_UPSTREAM_TITLE_CHARS - len(prefix)
    if remaining <= 0:  # pragma: no cover — defended above
        # Pathological: prefix alone fills the budget. Surface just
        # the prefix (still under cap) rather than blowing up.
        return prefix[:MAX_UPSTREAM_TITLE_CHARS]
    return prefix + user_title[:remaining]


@router.get("", response_model=RoomListResponse)
async def list_rooms(
    status: Literal["active", "scheduled"] = Query(default="active"),
    limit: int = Query(default=20, ge=1, le=50),
    cursor: int = Query(default=0, ge=0),
    current_fid: int | None = Depends(get_optional_current_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomListResponse:
    """Return a paginated list of rooms filtered by status."""
    if status == "scheduled":
        return await room_service.list_scheduled_rooms(
            limit=limit, cursor=cursor, current_fid=current_fid
        )
    return await room_service.list_active_rooms(
        limit=limit, cursor=cursor, current_fid=current_fid
    )


ROOM_EVENTS_CONNECTION_KEY_PREFIX = "rooms:events_ws:"
ROOM_EVENTS_LEASE_TTL_SECONDS = 90
ROOM_EVENTS_LEASE_RENEW_SECONDS = 30
ROOM_EVENTS_PING_SECONDS = 25
WS_CLOSE_TOO_MANY_CONNECTIONS = 4429


@router.websocket("/events")
async def room_events(websocket: WebSocket) -> None:
    """Stream global active/scheduled room changes to clients.

    Unauthenticated, so concurrent sockets are capped per client IP
    (``settings.ROOM_EVENTS_WS_MAX_PER_IP``): each one pins a Redis pubsub
    connection. Over the cap the handshake is refused before ``accept`` so
    clients never see an "open" and keep backing off.
    """
    redis = websocket.app.state.redis
    try:
        lease = await try_acquire_connection_lease(
            redis,
            f"{ROOM_EVENTS_CONNECTION_KEY_PREFIX}{client_ip(websocket)}",
            limit=settings.ROOM_EVENTS_WS_MAX_PER_IP,
            ttl_seconds=ROOM_EVENTS_LEASE_TTL_SECONDS,
        )
    except (aioredis.RedisError, OSError) as exc:
        logger.warning("[rooms] events lease failed (%s)", type(exc).__name__)
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return
    if lease is None:
        await websocket.close(code=WS_CLOSE_TOO_MANY_CONNECTIONS)
        return

    try:
        await websocket.accept()
        pubsub = pubsub_redis(websocket.app).pubsub()
        try:
            await pubsub.subscribe(RedisService.ROOM_DISCOVERY_CHANNEL)
        except (aioredis.RedisError, OSError) as exc:
            # e.g. pubsub pool exhausted: refuse this socket quietly.
            logger.warning("[rooms] events subscribe failed (%s)", type(exc).__name__)
            with contextlib.suppress(aioredis.RedisError, OSError):
                await pubsub.aclose()
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
            return
        try:
            await _relay_room_events(websocket, pubsub, lease)
        finally:
            # aclose() alone resets the pubsub and returns its connection to
            # the pool even when Redis is unreachable (an explicit
            # unsubscribe could raise first and leak the connection).
            with contextlib.suppress(aioredis.RedisError, OSError):
                await pubsub.aclose()
    finally:
        try:
            await lease.release()
        except (aioredis.RedisError, OSError):
            pass  # lapses after ROOM_EVENTS_LEASE_TTL_SECONDS


async def _relay_room_events(
    websocket: WebSocket, pubsub: Any, lease: ConnectionLease
) -> None:
    loop = asyncio.get_running_loop()
    renew_at = loop.time() + ROOM_EVENTS_LEASE_RENEW_SECONDS
    try:
        while True:
            if loop.time() >= renew_at:
                renew_at = loop.time() + ROOM_EVENTS_LEASE_RENEW_SECONDS
                try:
                    await lease.renew()
                except (aioredis.RedisError, OSError):
                    pass
            message = await pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=ROOM_EVENTS_PING_SECONDS,
            )
            if not message:
                await websocket.send_json({"type": "ping"})
                continue

            raw_data = message.get("data")
            if isinstance(raw_data, bytes):
                raw_data = raw_data.decode("utf-8")
            try:
                payload = json.loads(raw_data)
            except (TypeError, json.JSONDecodeError):
                continue
            await websocket.send_json(payload)
            await asyncio.sleep(0)
    except WebSocketDisconnect:
        pass


@router.post("", response_model=RoomCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_room(
    body: RoomCreate,
    current_user_fid: int = Depends(require_non_demo_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomCreateResponse:
    """Create a new audio room. The authenticated user becomes the host."""
    scheduled_at = None
    if body.scheduled_at:
        try:
            scheduled_at = datetime.fromisoformat(body.scheduled_at)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="Invalid scheduled_at format (use ISO 8601)"
            ) from exc
        if scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        now = datetime.now(tz=timezone.utc)
        if scheduled_at < now + MIN_SCHEDULE_AHEAD:
            raise HTTPException(
                status_code=400,
                detail="Scheduled time must be at least 5 minutes in the future",
            )
        if scheduled_at > now + MAX_SCHEDULE_AHEAD:
            raise HTTPException(
                status_code=400, detail="Cannot schedule more than 30 days in advance"
            )

    return await room_service.create_room(
        fid=current_user_fid,
        title=body.title,
        announce_cast=body.announce_cast,
        scheduled_at=scheduled_at,
        allow_agents=body.allow_agents,
    )


@router.post(
    "/link-farcaster",
    response_model=RoomResponse,
    status_code=status.HTTP_201_CREATED,
)
async def link_farcaster_room(
    body: LinkFarcasterRoomRequest,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
    room_service: RoomService = Depends(get_room_service),
) -> RoomResponse:
    """Register a Farcaster-native room (created on client.farcaster.xyz).

    Sync-enabled users spawn their rooms directly on
    ``client.farcaster.xyz`` — the Warpcast bearer that authorized the
    upstream create never crosses the wire. This endpoint records the
    Juke-side mapping so discovery, partner SSO, and the recording
    agent can reference the upstream room id.

    Requires:

      * A first-party Juke JWT. Partner-minted JWTs are rejected to
        prevent a third-party app from silently creating
        host-attributed rooms on the user's behalf. (Mirrors the
        ``farcaster_sync`` link/revoke gating that worker B3
        established.)
      * ``user.farcaster_sync_enabled == True``. Users who have not
        opted in to the Warpcast handshake cannot register native
        rooms — there's no FID to attribute them to.

    Returns a ``RoomResponse`` with ``is_farcaster_native = True``
    and ``farcaster_room_id`` set. Idempotent for the same
    ``(host_fid, farcaster_room_id)`` pair.
    """
    await _enforce_link_farcaster_rate_limit(fid, redis)

    # Re-check sync state at the router so we 403 before touching the
    # RoomService. ``require_first_party_user`` already proved the
    # caller controls a JWT for this fid; this proves they also
    # consented to the Warpcast handshake. Defense-in-depth — the
    # service layer enforces the same invariant.
    user_row = await db.execute(
        select(User.farcaster_sync_enabled, User.farcaster_fid).where(User.fid == fid)
    )
    user = user_row.first()
    if user is None or not user.farcaster_sync_enabled or user.farcaster_fid is None:
        raise HTTPException(
            status_code=403,
            detail="Farcaster sync not enabled",
        )

    scheduled_at = body.scheduled_at
    if scheduled_at is not None and scheduled_at.tzinfo is None:
        scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)

    return await room_service.link_farcaster_room(
        fid=fid,
        farcaster_room_id=body.farcaster_room_id,
        title=body.title,
        scheduled_at=scheduled_at,
        description=body.description,
    )


@router.post(
    "/native",
    response_model=RoomResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_native_room(
    body: CreateNativeRoomRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> RoomResponse:
    """Create a Farcaster-native audio room hosted by Juke's service FID.

    Backend-orchestrated alternative to ``POST /v1/rooms/link-farcaster``.
    Where ``link-farcaster`` requires the caller to have already spawned
    the upstream room (e.g. via a Mini App custody bearer), this
    endpoint mints the upstream room *server-side* using Juke's service
    FID's bearer. The actual human host is attributed via a
    ``@{username}: `` prefix on the upstream title — Warpcast clients
    render this prefix verbatim so the room reads as user-authored.

    Auth posture:
      * Requires a first-party Juke JWT. Partner-minted JWTs MUST NOT
        be able to spawn rooms attributed to other users — same
        precedent as ``link-farcaster`` and C3's link-farcaster flow.
      * Caller must have a ``users.username`` set (which every
        SIWN/SIWF user does post-onboarding). Demo / placeholder users
        without a username get a 400 — the title prefix would be
        meaningless without one.

    Side effects:
      * One upstream ``POST /v1/audio-rooms`` call via the service-FID
        bearer.
      * One ``Room`` row insert with ``is_farcaster_native=True`` and
        ``host_fid = fid`` (the caller's Juke FID — preserves the FK).
        ``metadata_`` stores the host username, upstream title, and
        the service FID for later operational lookups.

    Failure modes:
      * 400 — title constraints violated, no username, or invalid
        scheduled_at.
      * 401 — partner JWT.
      * 429 — rate limit (10/min per caller).
      * 502 — upstream upstream call failed (network or 4xx/5xx). No
        Juke ``Room`` row is created in this case; the operation
        rolls back cleanly.
      * 503 — service FID not configured (env missing).
    """
    await _enforce_native_create_rate_limit(fid, redis)

    # Look up the host user. ``username`` is required because we build
    # the upstream title as ``@{username}: ...``; without a username the
    # attribution would be lost. SIWN/SIWF users always have one set
    # post-Neynar lookup — a missing username here means the caller is
    # an edge-case (demo signer, placeholder row from an unsynced
    # webhook) we don't support for native creation.
    user_row = await db.execute(
        select(User.username, User.display_name).where(User.fid == fid)
    )
    user = user_row.first()
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="User not found",
        )
    username = (user.username or "").strip()
    if not username:
        raise HTTPException(
            status_code=400,
            detail="Set your Farcaster username first",
        )

    # Dispatch path: when the caller signs a JFS Bearer with their own
    # Ed25519 app key, the upstream room is hosted by THEIR FID — no
    # ``@username:`` prefix needed, and no post-create stage-invite
    # dance (they're already the host). When the bearer is absent we
    # fall back to the service-FID legacy path (kept for users who
    # haven't approved an app key yet).
    user_bearer: str | None = body.user_jfs_bearer
    if user_bearer is not None:
        try:
            bearer_fid = _decode_jfs_bearer(user_bearer)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail="Invalid user_jfs_bearer header",
            ) from exc
        # Cross-check: the JFS-claimed FID must match the Juke JWT FID.
        # Without this, a partner-minted JWT for FID A could submit a
        # bearer signed by FID B and the Juke row + upstream room would
        # disagree about who owns the space.
        if bearer_fid != fid:
            logger.warning(
                "[rooms-native] bearer fid mismatch (jwt=%s bearer=%s)",
                fid,
                bearer_fid,
            )
            raise HTTPException(
                status_code=400,
                detail="user_jfs_bearer fid does not match caller",
            )

    # Build the upstream title. Service-FID path needs the ``@username:``
    # attribution prefix so Warpcast clients can tell who the human host
    # is; user-FID path skips it (the upstream host IS the user).
    upstream_title = (
        body.title
        if user_bearer is not None
        else _build_upstream_title(username=username, user_title=body.title)
    )

    scheduled_at = body.scheduled_at
    if scheduled_at is not None:
        if scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        now = datetime.now(tz=timezone.utc)
        if scheduled_at < now + MIN_SCHEDULE_AHEAD:
            raise HTTPException(
                status_code=400,
                detail="Scheduled time must be at least 5 minutes in the future",
            )
        if scheduled_at > now + MAX_SCHEDULE_AHEAD:
            raise HTTPException(
                status_code=400,
                detail="Cannot schedule more than 30 days in advance",
            )

    # Pull the FarcasterSpacesService off app state — the lifespan
    # wires it once per process so its bearer cache and httpx client
    # are shared. When the lifespan didn't run (e.g. raw ASGI transport
    # in some tests) we 503; the service-FID bearer is the high-value
    # primitive here, refusing rather than minting fresh on every call.
    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    # Upstream create. Any failure (config missing, network, 4xx, 5xx,
    # malformed envelope) translates to 502/503 without persisting a
    # Juke row — we never want a Juke ``Room`` whose upstream
    # counterpart doesn't exist.
    try:
        upstream_room = await spaces_service.create_audio_room(
            title=upstream_title,
            description=body.description,
            scheduled_at=scheduled_at,
            channel_key=body.channel_key,
            as_user_bearer=user_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        # Don't echo the underlying reason — that would leak which
        # env var / key ref is misconfigured.
        logger.warning(
            "[rooms-native] service FID misconfigured (fid=%s): %s",
            fid,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(
            "[rooms-native] upstream create failed for fid=%s err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't create on Farcaster",
        ) from exc

    farcaster_room_id = upstream_room.id

    # Persist the Juke row. We mirror the developer-API path's pattern
    # rather than reusing ``RoomService.link_farcaster_room`` because
    # that path requires ``user.farcaster_sync_enabled`` (the Mini App
    # bearer path) — which doesn't apply here. The whole point of
    # backend-orchestrated create is that no client-side Farcaster
    # bearer is needed.
    is_scheduled = scheduled_at is not None
    now = datetime.now(tz=timezone.utc)
    room = Room(
        title=body.title,
        host_fid=fid,
        status="scheduled" if is_scheduled else "active",
        scheduled_at=scheduled_at,
        started_at=None if is_scheduled else now,
        livekit_room_id=None,
        # Native rooms can't host Juke-side agents (no Juke LiveKit
        # room exists for them to dial into).
        allow_agents=False,
        recording=False,
        is_farcaster_native=True,
        farcaster_room_id=farcaster_room_id,
        # Capture the upstream root cast hash if upstream returned one
        # on create — it's the FIP-2 conversation anchor that Juke's
        # chat surface keys off (``Room.cast_hash``). Falls back to
        # ``None`` for rooms upstream creates without a root cast.
        cast_hash=getattr(upstream_room, "root_cast_hash", None),
        metadata_={
            "farcaster_host_username": username,
            "farcaster_upstream_title": upstream_title,
            "farcaster_service_fid": settings.juke_farcaster_fid_resolved(),
            "source": "backend-orchestrated",
            # ``host_mode`` records which bearer minted the upstream
            # room so the end / lifecycle paths can dispatch correctly
            # later: ``user_fid`` rooms can only be ended by the user
            # (service bearer 404s); ``service_fid`` rooms must be
            # ended via the service bearer (the human host has no
            # upstream end primitive).
            "host_mode": "user_fid" if user_bearer is not None else "service_fid",
            **({"description": body.description} if body.description else {}),
        },
    )
    db.add(room)
    await db.commit()
    await db.refresh(room)

    # Add to the Redis "active rooms" sorted set so ``list_active_rooms``
    # surfaces native rooms alongside Juke-hosted ones. Scheduled rooms
    # come from Postgres directly so they don't need this. Best-effort:
    # any redis error just delays the row appearing until the next
    # background reconciler / poll refresh.
    if not is_scheduled:
        try:
            await redis.add_active_room(str(room.id), now.timestamp())
        except Exception as exc:  # pragma: no cover — best-effort
            logger.debug(
                "redis add_active_room failed for native room %s: %s",
                room.id,
                type(exc).__name__,
            )

    # Discovery pub/sub — keep backend-orchestrated native rooms
    # surfacing alongside Juke-hosted rooms. Best-effort: any redis
    # error here just delays the row showing in the live rail until
    # the next polling refresh, so swallow + log.
    try:
        await redis.publish(
            RedisService.ROOM_DISCOVERY_CHANNEL,
            json.dumps(
                {
                    "type": "rooms_changed",
                    "reason": ("room_scheduled" if is_scheduled else "room_started"),
                    "room_id": str(room.id),
                    "status": room.status,
                }
            ),
        )
    except Exception as exc:  # pragma: no cover — pubsub best-effort
        logger.debug(
            "discovery publish failed for native room %s: %s",
            room.id,
            type(exc).__name__,
        )

    # Fire-and-forget upstream stage-invite for the human host —
    # service-FID path only. When the user signed the bearer themselves
    # the upstream room is already hosted by their FID, so they land on
    # stage directly with no invite needed.
    #
    # The upstream room's technical host is Juke's service FID — so when
    # the human host taps "Open in Warpcast" they'd otherwise land as a
    # plain listener. Pre-queuing an ``accept-speaker`` invite means the
    # upstream surfaces a stage-invite prompt the instant they join
    # (per Quorum's reverse-engineering of the endpoint).
    #
    # The naive single-shot invite drops because the upstream often
    # rejects (or no-ops) when the target FID isn't yet a participant
    # — there's no record to flip to ``speaker``. We instead schedule a
    # bounded retry loop (~6 attempts over ~60s) that bails out as soon
    # as the target lands on stage or the host cancels. Loop body
    # swallows every error — the create response has already been sent.
    juke_room_id = room.id
    # Import the session factory once at handler scope, not inside the
    # callback — Python's import cache makes inline imports cheap but
    # they obscure the dependency graph and make the callback slightly
    # harder to test in isolation.
    from app.database import async_session as _session_factory

    async def _is_room_ended() -> bool:
        # Use a fresh session — the request-scoped ``db`` closes the
        # moment the handler returns and would raise on the next access.
        # Keep the query cheap (single column lookup) since this runs
        # before every retry attempt.
        try:
            async with _session_factory() as fresh_db:
                row = await fresh_db.execute(
                    select(Room.status).where(Room.id == juke_room_id)
                )
                status_value = row.scalar_one_or_none()
                return status_value == "ended"
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.debug(
                "[rooms-native] is_room_ended probe error room=%s: %s",
                juke_room_id,
                type(exc).__name__,
            )
            return False

    if user_bearer is None:
        try:
            asyncio.create_task(
                spaces_service.invite_speaker_with_retry(
                    farcaster_room_id,
                    fid,
                    is_room_ended=_is_room_ended,
                )
            )
        except RuntimeError:  # pragma: no cover — no running loop
            logger.debug(
                "[rooms-native] invite_speaker schedule failed for room=%s",
                farcaster_room_id,
            )

    # Construct the response payload. We can't reuse RoomService here
    # without pulling in its full constructor (LiveKit / Redis clients
    # which the lifespan tests don't always wire). Build the response
    # directly — counts are always (0, 0) for a freshly created native
    # room because participants live on the upstream SFU we don't
    # observe.
    display_user_row = await db.execute(
        select(
            User.fid,
            User.username,
            User.display_name,
            User.pfp_url,
        ).where(User.fid == fid)
    )
    display_user = display_user_row.first()
    # Enrich `pfp_url` and `display_name` via Neynar when our local
    # `users` row is missing them — the row is whatever Neynar gave us
    # at signup and is never refreshed. Without this, a host whose
    # signup-time pfp_url was null sees initials-only in their own
    # space while everyone else (rail / ongoing spaces) renders the
    # enriched pfp via the discovery cache. Mutates `host_dict` in
    # place; best-effort (Neynar errors leave the dict alone).
    host_dict: dict[str, Any] = {
        "fid": fid,
        "username": username,
        "display_name": (
            (display_user.display_name if display_user else None) or username
        ),
        "pfp_url": (display_user.pfp_url if display_user else None),
    }
    await _enrich_user_pfps([host_dict], redis)
    host_response = UserResponse(
        fid=fid,
        username=username,
        display_name=host_dict.get("display_name") or username,
        pfp_url=host_dict.get("pfp_url"),
        custody_address=None,  # never published in room payloads (L11a)
    )

    return RoomResponse(
        id=str(room.id),
        title=room.title,
        host_fid=room.host_fid,
        host=host_response,
        status=room.status,
        started_at=room.started_at.isoformat() if room.started_at else "",
        ended_at=None,
        scheduled_at=(room.scheduled_at.isoformat() if room.scheduled_at else None),
        speaker_count=0,
        listener_count=0,
        recording=False,
        cast_hash=None,
        allow_agents=False,
        rsvp_summary=None,
        farcaster_room_id=farcaster_room_id,
        is_farcaster_native=True,
    )


@router.post(
    "/{room_id}/end",
    response_model=RoomResponse,
)
async def end_native_room(
    room_id: str,
    request: Request,
    body: EndNativeRoomRequest | None = None,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> RoomResponse:
    """End a Farcaster-native room hosted by Juke's service FID.

    The upstream room's technical host is Juke's service FID, so the
    human host can't call ``client.farcaster.xyz/v1/audio-room/end``
    directly. This endpoint dispatches the upstream end through
    :py:meth:`FarcasterSpacesService.end_audio_room` (which carries
    the service-FID bearer), flips the Juke ``Room`` row to
    ``status='ended'``, and stamps ``ended_at``.

    Auth posture:
      * First-party Juke JWT required. Partner-minted JWTs MUST NOT be
        able to end a room they didn't create — same precedent as
        create-native.
      * Only the Juke ``Room.host_fid`` (the human host attribution
        recorded at create time) may end the room. Anyone else gets a
        403 — this is the host-only authorization gate.

    Idempotency: re-ending an already-ended room returns 200 with
    ``status='ended'`` and does NOT issue another upstream call. This
    matches the iOS pattern where the host taps End, then taps it
    again on a flaky network — the second tap shouldn't bounce.

    Failure modes:
      * 400 — room is not a Farcaster-native room (use ``DELETE
        /v1/rooms/{id}`` for Juke-hosted rooms).
      * 401 — partner JWT.
      * 403 — caller isn't the recorded host_fid.
      * 404 — room not found.
      * 429 — rate limit (5/min per caller).
      * 502 — upstream end failed after retries. The Juke row stays
        ``active`` so a retry from the client is meaningful.
      * 503 — service FID not configured.
    """
    await _enforce_native_end_rate_limit(fid, redis)

    try:
        room_uuid = uuid.UUID(room_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Room not found") from exc

    row = await db.execute(select(Room).where(Room.id == room_uuid))
    room: Room | None = row.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    if not room.is_farcaster_native:
        # Juke-hosted rooms route through DELETE /v1/rooms/{id} so the
        # full LiveKit / Redis teardown fires. This endpoint is only
        # for native rooms — fail loudly rather than silently doing
        # the wrong thing.
        raise HTTPException(
            status_code=400,
            detail="Not a Farcaster-native room",
        )

    # Host-only authorization. The Juke ``host_fid`` is the human host
    # we attribute the room to at create time — that's the only FID
    # allowed to end. Co-hosts / speakers cannot end native rooms from
    # Juke (they have no upstream end primitive available either).
    if room.host_fid != fid:
        raise HTTPException(
            status_code=403,
            detail="Only the host can end this space",
        )

    # Idempotent: if already ended, short-circuit. No upstream call,
    # no row update, return the current state. Prevents a double-tap
    # from issuing a second upstream end (which is also idempotent
    # server-side, but we'd rather not burn the rate budget).
    if room.status in ("ended", "cancelled"):
        return await _build_native_room_response(db, room, fid)

    # Pull the spaces service. Same posture as create-native — when the
    # lifespan didn't wire it (raw ASGI transport tests) we 503.
    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    if not room.farcaster_room_id:
        # Defense-in-depth: a row marked is_farcaster_native MUST have
        # the upstream id. If it doesn't, refuse to call upstream
        # rather than guessing — this would indicate a bug at create
        # time, not a runtime condition we can recover from.
        logger.warning(
            "[rooms-native-end] native row missing farcaster_room_id "
            "(room=%s host_fid=%d)",
            room.id,
            fid,
        )
        raise HTTPException(
            status_code=500,
            detail="Native room missing upstream id",
        )

    # Pick the upstream bearer based on which FID minted the room.
    # ``user_fid`` rooms were spawned with the caller's JFS bearer and
    # are upstream-hosted by the user — service-FID 403s on end. The
    # client must supply a freshly-signed bearer in the request body.
    # ``service_fid`` rooms keep the legacy path (service bearer).
    host_mode = (room.metadata_ or {}).get("host_mode", "service_fid")
    upstream_bearer: str | None = None
    if host_mode == "user_fid":
        user_bearer = body.user_jfs_bearer if body is not None else None
        if not user_bearer:
            raise HTTPException(
                status_code=400,
                detail=("user_jfs_bearer required to end a user-hosted " "native room"),
            )
        try:
            bearer_fid = _decode_jfs_bearer(user_bearer)
        except ValueError as exc:
            logger.warning(
                "[rooms-native-end] invalid JFS bearer fid=%d reason=%s",
                fid,
                exc,
            )
            raise HTTPException(
                status_code=403,
                detail="Invalid JFS bearer",
            ) from exc
        if bearer_fid != fid:
            # JWT proves the caller controls account A; a bearer signed by
            # B would let a partner with a stolen JWT for A end B's room.
            logger.warning(
                "[rooms-native-end] fid mismatch jwt=%d jfs=%d room=%s",
                fid,
                bearer_fid,
                room.id,
            )
            raise HTTPException(
                status_code=403,
                detail="JFS bearer fid does not match authenticated user",
            )
        upstream_bearer = user_bearer

    # If the host is recording, stop the recording BEFORE ending the
    # upstream room — gives the worker time to finalize ffmpeg + S3
    # while the LiveKit room is still alive. Otherwise upstream ends,
    # LiveKit kicks the agent abruptly, and the multipart S3 upload is
    # left in a half-finished state with no `recording_url` persisted.
    # Failures here are non-fatal to the end flow: log + continue. We
    # never want a stuck worker to block the host from ending their
    # space.
    if room.recording and room.recording_id:
        recording_agent_svc = getattr(
            request.app.state, "recording_agent_service", None
        )
        if recording_agent_svc is not None:
            try:
                inline_room_service = RoomService(
                    db,
                    RedisService(redis),
                    LiveKitService(),
                    farcaster_spaces=spaces_service,
                    recording_agent=recording_agent_svc,
                )
                try:
                    await inline_room_service.stop_recording(
                        room_id=str(room.id), fid=fid
                    )
                finally:
                    await inline_room_service.livekit.close()
                # Re-read the row so the rest of this handler sees
                # `recording=False` + the new `recording_url`.
                refreshed = await db.execute(select(Room).where(Room.id == room_uuid))
                row = refreshed.scalar_one_or_none()
                if row is not None:
                    room = row
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[rooms-native-end] auto-stop recording failed for "
                    "room=%s recording_id=%s err=%s — continuing with end",
                    room.id,
                    (room.recording_id or "")[:8],
                    type(exc).__name__,
                )

    # Upstream end. 4xx is swallowed inside the service (None return) —
    # most commonly "room already ended" or "room not found" upstream,
    # both fine here. 5xx + network errors surface as HTTPError and
    # translate to a 502 so the client can retry. The Juke row stays
    # ``active`` on 5xx so retries make sense.
    try:
        await spaces_service.end_audio_room(
            room.farcaster_room_id, bearer=upstream_bearer
        )
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "[rooms-native-end] service FID misconfigured (fid=%s): %s",
            fid,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-end] upstream end failed for fid=%s err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't end on Farcaster",
        ) from exc

    # Mark the Juke row ended. Done AFTER the upstream call so a
    # transient upstream failure leaves the row in a consistent state
    # the host can retry from.
    now = datetime.now(tz=timezone.utc)
    room.status = "ended"
    room.ended_at = now
    await db.commit()
    await db.refresh(room)

    # Discovery pub/sub so the live rail removes the room promptly.
    try:
        await redis.publish(
            RedisService.ROOM_DISCOVERY_CHANNEL,
            json.dumps(
                {
                    "type": "rooms_changed",
                    "reason": "room_ended",
                    "room_id": str(room.id),
                    "status": room.status,
                }
            ),
        )
    except Exception as exc:  # pragma: no cover — pubsub best-effort
        logger.debug(
            "discovery publish failed for native room end %s: %s",
            room.id,
            type(exc).__name__,
        )

    return await _build_native_room_response(db, room, fid)


@router.post(
    "/{room_id}/native-start",
    response_model=RoomResponse,
)
async def start_native_room(
    room_id: str,
    request: Request,
    body: StartNativeRoomRequest | None = None,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> RoomResponse:
    """Go live on a *scheduled* Farcaster-native room.

    The Farcaster-native counterpart to ``POST /v1/rooms/{id}/start``
    (which only handles Juke-hosted rooms — see
    :py:meth:`RoomService.start_scheduled_room`, which 400s native
    rooms). Dispatches the upstream
    ``client.farcaster.xyz/v1/audio-room/start-scheduled`` call to flip
    the room ``scheduled -> live``, then flips the Juke ``Room`` row to
    ``status='active'`` and stamps ``started_at``. The host connects to
    the now-live room via the normal native-join path afterwards — this
    endpoint allocates NO Juke LiveKit resources.

    Auth posture mirrors :py:func:`end_native_room`:
      * First-party Juke JWT required (partner JWTs cannot go live on a
        room they didn't create).
      * Only the recorded ``Room.host_fid`` may go live.
      * ``user_fid`` host mode requires a fresh ``user_jfs_bearer`` whose
        FID matches the caller; ``service_fid`` uses the service bearer.

    Idempotency: a room already ``active`` returns 200 with its current
    state and issues no upstream call (handles a double-tap on a flaky
    network).

    Failure modes:
      * 400 — not a native room, not in scheduled state, or missing
        ``user_jfs_bearer`` for a user_fid room.
      * 401 — partner JWT.
      * 403 — caller isn't the host, or bearer fid mismatch.
      * 404 — room not found.
      * 429 — rate limit (shares the native-create budget).
      * 502 — upstream start failed after retries. The Juke row stays
        ``scheduled`` so a client retry is meaningful.
      * 503 — service FID not configured.
    """
    await _enforce_native_create_rate_limit(fid, redis)

    try:
        room_uuid = uuid.UUID(room_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Room not found") from exc

    row = await db.execute(select(Room).where(Room.id == room_uuid))
    room: Room | None = row.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    if not room.is_farcaster_native:
        # Juke-hosted rooms go live via POST /v1/rooms/{id}/start so the
        # full LiveKit / Redis setup fires. This endpoint is native-only.
        raise HTTPException(
            status_code=400,
            detail="Not a Farcaster-native room",
        )

    # Host-only authorization — same gate as create / end.
    if room.host_fid != fid:
        raise HTTPException(
            status_code=403,
            detail="Only the host can start this space",
        )

    # Idempotent: already live → return current state, no upstream call.
    if room.status == "active":
        return await _build_native_room_response(db, room, fid)

    if room.status != "scheduled":
        # ended / cancelled — there's nothing to go live to.
        raise HTTPException(
            status_code=400,
            detail="Room is not in scheduled state",
        )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    if not room.farcaster_room_id:
        # Defense-in-depth: a native row MUST carry the upstream id. A
        # missing id is a create-time bug, not a recoverable runtime
        # condition — refuse rather than guess.
        logger.warning(
            "[rooms-native-start] native row missing farcaster_room_id "
            "(room=%s host_fid=%d)",
            room.id,
            fid,
        )
        raise HTTPException(
            status_code=500,
            detail="Native room missing upstream id",
        )

    # Bearer dispatch — identical posture to end_native_room. ``user_fid``
    # rooms are upstream-hosted by the human, so start-scheduled needs the
    # caller's freshly-signed bearer (service bearer 403s); ``service_fid``
    # rooms use the cached service bearer.
    host_mode = (room.metadata_ or {}).get("host_mode", "service_fid")
    upstream_bearer: str | None = None
    if host_mode == "user_fid":
        user_bearer = body.user_jfs_bearer if body is not None else None
        if not user_bearer:
            raise HTTPException(
                status_code=400,
                detail=(
                    "user_jfs_bearer required to start a user-hosted " "native room"
                ),
            )
        try:
            bearer_fid = _decode_jfs_bearer(user_bearer)
        except ValueError as exc:
            logger.warning(
                "[rooms-native-start] invalid JFS bearer fid=%d reason=%s",
                fid,
                exc,
            )
            raise HTTPException(
                status_code=403,
                detail="Invalid JFS bearer",
            ) from exc
        if bearer_fid != fid:
            # JWT proves the caller controls account A; a bearer signed by
            # B would let a stolen JWT for A go live on B's room.
            logger.warning(
                "[rooms-native-start] fid mismatch jwt=%d jfs=%d room=%s",
                fid,
                bearer_fid,
                room.id,
            )
            raise HTTPException(
                status_code=403,
                detail="JFS bearer fid does not match authenticated user",
            )
        upstream_bearer = user_bearer

    # Upstream go-live. 4xx surfaces as HTTPStatusError → 502 (the Juke
    # row stays ``scheduled`` so a retry is meaningful); 5xx + network
    # errors retry inside the service before surfacing.
    try:
        await spaces_service.start_scheduled_audio_room(
            room.farcaster_room_id, bearer=upstream_bearer
        )
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "[rooms-native-start] service FID misconfigured (fid=%s): %s",
            fid,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPStatusError as exc:
        # An upstream 4xx is a permanent rejection (not the host, not in
        # scheduled state, already ended) — map it to 400 so the client
        # stops rather than hammering a doomed retry. 5xx is already
        # retried inside the service before surfacing, so it maps to 502
        # (a later retry is still meaningful). The body was logged +
        # redacted in the service; we log only the status here.
        upstream_status = exc.response.status_code if exc.response is not None else None
        logger.warning(
            "[rooms-native-start] upstream start rejected for fid=%s status=%s",
            fid,
            upstream_status,
        )
        if upstream_status is not None and 400 <= upstream_status < 500:
            raise HTTPException(
                status_code=400,
                detail="Couldn't start on Farcaster",
            ) from exc
        raise HTTPException(
            status_code=502,
            detail="Couldn't start on Farcaster",
        ) from exc
    except httpx.HTTPError as exc:
        # Network / transport error (no HTTP response) — transient, 502.
        logger.warning(
            "[rooms-native-start] upstream start failed for fid=%s err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't start on Farcaster",
        ) from exc

    # Flip the Juke row live AFTER the upstream call succeeds so a
    # transient upstream failure leaves the row in a consistent state the
    # host can retry from.
    now = datetime.now(tz=timezone.utc)
    room.status = "active"
    room.started_at = now
    await db.commit()
    await db.refresh(room)

    # Surface in discovery + the active-rooms set, mirroring the
    # immediate-create path. Best-effort: a redis blip just delays the
    # room appearing until the next reconciler / poll refresh.
    redis_service = RedisService(redis)
    try:
        await redis_service.add_active_room(str(room.id), now.timestamp())
    except Exception as exc:  # pragma: no cover — best-effort
        logger.debug(
            "redis add_active_room failed for native start %s: %s",
            room.id,
            type(exc).__name__,
        )
    try:
        await redis_service.publish_room_discovery_event(
            {
                "type": "rooms_changed",
                "reason": "room_started",
                "room_id": str(room.id),
                "status": room.status,
            }
        )
    except Exception as exc:  # pragma: no cover — pubsub best-effort
        logger.debug(
            "discovery publish failed for native start %s: %s",
            room.id,
            type(exc).__name__,
        )

    # Notify RSVP'd users the space is live. Best-effort — a push failure
    # must never block the host going live.
    try:
        push = PushService(db, redis)
        await push.notify_space_started_rsvps(
            room_id=str(room.id),
            room_uuid=room.id,
            title=room.title,
            host_fid=fid,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning(
            "[rooms-native-start] RSVP go-live push failed room=%s err=%s",
            room.id,
            type(exc).__name__,
        )

    return await _build_native_room_response(db, room, fid)


async def _build_native_room_response(
    db: AsyncSession, room: Room, fid: int
) -> RoomResponse:
    """Shared response builder for the native-room end endpoint.

    Mirrors the response shape constructed by ``create_native_room``:
    pulls the host user once, derives the username from metadata
    (more reliable than re-reading the user row, which could have
    changed since create time), and lets the rest of the fields fall
    out of the Juke row.
    """
    display_user_row = await db.execute(
        select(
            User.fid,
            User.username,
            User.display_name,
            User.pfp_url,
        ).where(User.fid == room.host_fid)
    )
    display_user = display_user_row.first()
    metadata = room.metadata_ or {}
    username = (
        (
            metadata.get("farcaster_host_username")
            if isinstance(metadata, dict)
            else None
        )
        or (display_user.username if display_user else None)
        or str(room.host_fid)
    )
    host_response = UserResponse(
        fid=room.host_fid,
        username=username,
        display_name=(
            (display_user.display_name if display_user else None) or username
        ),
        pfp_url=(display_user.pfp_url if display_user else None),
        custody_address=None,  # never published in room payloads (L11a)
    )
    return RoomResponse(
        id=str(room.id),
        title=room.title,
        host_fid=room.host_fid,
        host=host_response,
        status=room.status,
        started_at=room.started_at.isoformat() if room.started_at else "",
        ended_at=room.ended_at.isoformat() if room.ended_at else None,
        scheduled_at=(room.scheduled_at.isoformat() if room.scheduled_at else None),
        speaker_count=0,
        listener_count=0,
        recording=False,
        cast_hash=None,
        allow_agents=False,
        rsvp_summary=None,
        farcaster_room_id=room.farcaster_room_id,
        is_farcaster_native=True,
    )


@router.post(
    "/{room_id}/native-join",
    response_model=NativeJoinResponse,
)
async def native_join_room(
    room_id: str,
    body: NativeJoinRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> NativeJoinResponse:
    """Trade a user JFS bearer for upstream LiveKit join creds.

    This is the bridge that makes Farcaster-native rooms feel native
    inside Juke. The caller signs a JFS bearer with their on-device
    Ed25519 app key (same key used by ``POST /v1/rooms/native``); the
    backend proxies it to ``client.farcaster.xyz/v1/audio-room/join``
    and returns the LiveKit signaling URL + token. The iOS client then
    connects directly to Farcaster's LiveKit project using Juke's
    existing LiveKit player — no deep-link bounce.

    LiveKit quota note: the returned ``ws_url`` points at Farcaster's
    LiveKit project, not Juke's. Juke's ``LIVEKIT_API_KEY`` /
    ``LIVEKIT_WS_URL`` are not used and not exposed.

    Auth posture:
      * First-party Juke JWT required. Partner JWTs are rejected —
        same precedent as ``POST /v1/rooms/native``.
      * The JFS header's ``fid`` MUST equal the JWT fid. Otherwise a
        partner with a first-party JWT for user A could hand us a JFS
        signed by user B and pivot the connection. The JWT is the
        identity anchor; the JFS is the per-request capability.

    Failure modes:
      * 400 — room is not a Farcaster-native room.
      * 401 — partner JWT.
      * 403 — JFS fid does not match JWT fid, or JFS shape/claim invalid.
      * 404 — room not found, or Farcaster reports "not live" (room is
        auto-closed in Juke's DB on this path so the rail self-heals).
      * 429 — rate limit (30/min per caller).
      * 500 — native row missing ``farcaster_room_id`` (data invariant
        violation; logged for investigation).
      * 502 — upstream join failed (network or non-400 upstream error).
      * 503 — Farcaster spaces service not wired.
    """
    try:
        room_uuid = uuid.UUID(room_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Room not found") from exc

    row = await db.execute(select(Room).where(Room.id == room_uuid))
    room: Room | None = row.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    if not room.is_farcaster_native:
        raise HTTPException(
            status_code=400,
            detail="Not a Farcaster-native room",
        )

    if not room.farcaster_room_id:
        logger.warning(
            "[rooms-native-join] native row missing farcaster_room_id "
            "(room=%s caller_fid=%d)",
            room.id,
            fid,
        )
        raise HTTPException(
            status_code=500,
            detail="Native room missing upstream id",
        )

    # Rate-limit per (caller, room) — keyed after the room lookup so
    # 404 probes can't burn the budget for legitimate joins.
    await _enforce_native_join_rate_limit(fid, room_uuid, redis)

    # JFS structural + claim validation. ``_decode_jfs_bearer`` returns
    # the fid embedded in the bearer's header — we cross-check it
    # against the JWT fid before forwarding anything upstream. The
    # structured reason is kept in the warning log only; the response
    # uses a generic detail so a bad actor can't iterate against the
    # specific failure mode.
    try:
        bearer_fid = _decode_jfs_bearer(body.user_jfs_bearer)
    except ValueError as exc:
        logger.warning(
            "[rooms-native-join] invalid JFS bearer fid=%d reason=%s",
            fid,
            exc,
        )
        raise HTTPException(
            status_code=403,
            detail="Invalid JFS bearer",
        ) from exc

    if bearer_fid != fid:
        # The JWT proves the caller controls account A; the JFS being
        # signed by B's key means B authorized the join, not A. Refuse
        # to bridge them — that's how a partner with a stolen first-party
        # JWT for one user pivots to host as a different user.
        logger.warning(
            "[rooms-native-join] fid mismatch jwt=%d jfs=%d room=%s",
            fid,
            bearer_fid,
            room.id,
        )
        raise HTTPException(
            status_code=403,
            detail="JFS bearer fid does not match authenticated user",
        )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    try:
        result = await spaces_service.join_room_as_listener(
            room_id=room.farcaster_room_id,
            bearer=body.user_jfs_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "[rooms-native-join] service misconfigured (fid=%d): %s",
            fid,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPStatusError as exc:
        body = exc.response.text if exc.response is not None else ""
        if (
            exc.response is not None
            and exc.response.status_code == 400
            and "not live" in body.lower()
        ):
            # Room ended on Farcaster but Juke DB still shows it active.
            # Close it now so the rail stops surfacing it.
            now = datetime.now(tz=timezone.utc)
            await db.execute(
                update(Room)
                .where(Room.id == room_uuid)
                .values(status="ended", ended_at=now)
            )
            await db.commit()
            raise HTTPException(status_code=404, detail="Space has ended") from exc
        logger.warning(
            "[rooms-native-join] upstream join failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't join on Farcaster",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-join] upstream join failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't join on Farcaster",
        ) from exc
    except ValueError as exc:
        # Upstream returned a shape we don't recognize (missing
        # ``result`` dict). Surface as 502 — the joiner can retry.
        logger.warning(
            "[rooms-native-join] unexpected upstream shape fid=%d: %s",
            fid,
            exc,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't join on Farcaster",
        ) from exc

    token = result.get("token") if isinstance(result, dict) else None
    ws_url = (
        result.get("wsUrl") or result.get("url") or result.get("ws_url")
        if isinstance(result, dict)
        else None
    )
    if not isinstance(token, str) or not isinstance(ws_url, str):
        logger.warning("[rooms-native-join] upstream missing token/ws_url fid=%d", fid)
        raise HTTPException(
            status_code=502,
            detail="Couldn't join on Farcaster",
        )

    # Resolve the caller's authoritative role so the client renders the right
    # controls instead of guessing from host_fid. The Juke row is authoritative
    # for the host; co-host/speaker come from the upstream participant list.
    # Best-effort — a lookup failure never blocks a successful join.
    role = "host" if fid == room.host_fid else "listener"
    if role != "host":
        try:
            participants = await spaces_service.get_participants(room.farcaster_room_id)
            for p in participants:
                if p.user.fid == fid:
                    role = _NATIVE_JOIN_ROLE_MAP.get(p.role, "listener")
                    break
        except Exception as exc:  # noqa: BLE001 — role is a best-effort overlay
            logger.debug(
                "[rooms-native-join] role lookup failed fid=%d: %s",
                fid,
                type(exc).__name__,
            )

    return NativeJoinResponse(ws_url=ws_url, token=token, role=role)


# Rate limits for the stage-control endpoints. Defensive — these are
# proxy POSTs to upstream Farcaster, so we want to catch a runaway
# client before it hammers their API.
NATIVE_STAGE_RATE_LIMIT_PER_MIN = 30
NATIVE_STAGE_RATE_LIMIT_WINDOW_SECONDS = 60
# Heartbeat has a fixed ~30s cadence (~2/min); keep a tight bucket so a runaway
# or abusive client can't fan out upstream heartbeat POSTs.
NATIVE_HEARTBEAT_RATE_LIMIT_PER_MIN = 6


async def _enforce_native_stage_rate_limit(
    fid: int,
    room_uuid: uuid.UUID,
    op: str,
    redis: aioredis.Redis,
    limit: int = NATIVE_STAGE_RATE_LIMIT_PER_MIN,
) -> None:
    """Per-(caller, room, op) rate limit shared by the stage-control
    endpoints (raise-hand, accept-speaker, remove-speaker) and the
    activity heartbeat. ``limit`` overrides the per-minute cap per op."""
    rate_key = f"rooms:native_stage:rl:{op}:{fid}:{room_uuid}"
    count = await redis.incr(rate_key)
    if int(count) == 1:
        await redis.expire(rate_key, NATIVE_STAGE_RATE_LIMIT_WINDOW_SECONDS)
    if int(count) > limit:
        raise HTTPException(
            status_code=429,
            detail="Stage control rate limit exceeded. Try again later.",
            headers={
                "Retry-After": str(NATIVE_STAGE_RATE_LIMIT_WINDOW_SECONDS),
            },
        )


async def _load_native_room_for_stage(
    room_id: str, db: AsyncSession, fid: int
) -> tuple[Room, uuid.UUID]:
    """Common lookup for the three stage-control endpoints: validates
    the room id, fetches the row, asserts it's a native room with an
    upstream id. Returns ``(room, room_uuid)``."""
    try:
        room_uuid = uuid.UUID(room_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Room not found") from exc
    row = await db.execute(select(Room).where(Room.id == room_uuid))
    room: Room | None = row.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if not room.is_farcaster_native:
        raise HTTPException(status_code=400, detail="Not a Farcaster-native room")
    if not room.farcaster_room_id:
        logger.warning(
            "[rooms-native-stage] native row missing farcaster_room_id "
            "(room=%s caller_fid=%d)",
            room.id,
            fid,
        )
        raise HTTPException(status_code=500, detail="Native room missing upstream id")
    return room, room_uuid


def _decode_and_cross_check_bearer(
    bearer: str, expected_fid: int, log_tag: str, room_id: uuid.UUID
) -> None:
    """Decode + shape-validate a JFS bearer and assert the embedded fid
    matches ``expected_fid``. Raises HTTPException on any failure."""
    try:
        bearer_fid = _decode_jfs_bearer(bearer)
    except ValueError as exc:
        logger.warning("[%s] invalid JFS bearer reason=%s", log_tag, exc)
        raise HTTPException(status_code=403, detail="Invalid JFS bearer") from exc
    if bearer_fid != expected_fid:
        logger.warning(
            "[%s] fid mismatch expected=%d jfs=%d room=%s",
            log_tag,
            expected_fid,
            bearer_fid,
            room_id,
        )
        raise HTTPException(
            status_code=403,
            detail="JFS bearer fid does not match expected user",
        )


async def _notify_host_hand_raised_native(
    db: AsyncSession,
    redis: aioredis.Redis,
    room: Room,
    raiser_fid: int,
) -> None:
    """Fire-and-forget push notification to the host after a native hand-raise.

    Farcaster sends its own push to the host's Farcaster app; this call
    mirrors that for hosts who are active in the Juke app instead.
    Swallows all errors — a failed push must never block the raise-hand
    proxy response.
    """
    try:
        raiser_row = await db.execute(
            select(User.display_name, User.username, User.pfp_url).where(
                User.fid == raiser_fid
            )
        )
        raiser = raiser_row.first()
        raiser_name = (
            (raiser.display_name or raiser.username or None) if raiser else None
        ) or "Someone"
        raiser_pfp_url = raiser.pfp_url if raiser else None
        push = PushService(db, redis)
        await push.notify_hand_raised(
            host_fid=room.host_fid,
            raiser_name=raiser_name,
            room_id=str(room.id),
            raiser_pfp_url=raiser_pfp_url,
            raiser_fid=raiser_fid,
        )
    except Exception as exc:
        logger.debug(
            "[rooms-native-raise-hand] push notification failed raiser_fid=%d err=%s",
            raiser_fid,
            type(exc).__name__,
        )


@router.post(
    "/{room_id}/native-raise-hand",
    response_model=StatusResponse,
)
async def native_raise_hand(
    room_id: str,
    body: NativeRaiseHandRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> StatusResponse:
    """Raise (or lower) the caller's hand on a Farcaster-native room.

    The caller supplies their own JFS bearer. We cross-check that the
    JFS-claimed fid matches the JWT fid (listeners can't raise someone
    else's hand) and proxy to ``POST /v1/audio-room/raise-hand``.

    Failure modes:
      * 400 — room is not a Farcaster-native room.
      * 401 — partner JWT.
      * 403 — JFS shape invalid or fid mismatch.
      * 404 — room not found.
      * 429 — rate limit.
      * 502 — upstream call failed.
      * 503 — Farcaster spaces service not wired.
    """
    room, room_uuid = await _load_native_room_for_stage(room_id, db, fid)
    await _enforce_native_stage_rate_limit(fid, room_uuid, "rh", redis)
    _decode_and_cross_check_bearer(
        body.user_jfs_bearer, fid, "rooms-native-raise-hand", room.id
    )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    try:
        await spaces_service.raise_hand(
            room_id=room.farcaster_room_id,
            raised=body.raised,
            bearer=body.user_jfs_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-raise-hand] upstream failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502, detail="Couldn't update hand on Farcaster"
        ) from exc

    await invalidate_participants_cache(redis, room.farcaster_room_id)
    if body.raised:
        await _notify_host_hand_raised_native(db, redis, room, fid)
    return StatusResponse(status="ok")


@router.post(
    "/{room_id}/native-heartbeat",
    response_model=StatusResponse,
)
async def native_heartbeat(
    room_id: str,
    body: NativeHeartbeatRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> StatusResponse:
    """Report the caller as an active speaker on a Farcaster-native room,
    resetting the room's host-inactivity timer.

    Farcaster auto-ends a space when no authenticated host/cohost/speaker
    activity has been reported for 10 minutes. Audio published through a
    third-party LiveKit client (e.g. Juke's web mixer piping external audio)
    isn't automatically credited to a FID upstream, so a publishing caller
    sends this every ~30s while producing audio. We credit ONLY the signer's
    own fid — never a client-supplied list — so a caller cannot report
    someone else as active.

    Failure modes:
      * 400 — room is not a Farcaster-native room.
      * 401 — partner JWT.
      * 403 — JFS shape invalid or fid mismatch.
      * 404 — room not found.
      * 429 — rate limit.
      * 502 — upstream call failed.
      * 503 — Farcaster spaces service not wired.
    """
    room, room_uuid = await _load_native_room_for_stage(room_id, db, fid)
    await _enforce_native_stage_rate_limit(
        fid, room_uuid, "hb", redis, limit=NATIVE_HEARTBEAT_RATE_LIMIT_PER_MIN
    )
    _decode_and_cross_check_bearer(
        body.user_jfs_bearer, fid, "rooms-native-heartbeat", room.id
    )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    try:
        await spaces_service.heartbeat(
            room_id=room.farcaster_room_id,
            active_speaker_fids=[fid],
            bearer=body.user_jfs_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-heartbeat] upstream failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502, detail="Couldn't report activity to Farcaster"
        ) from exc

    return StatusResponse(status="ok")


@router.post(
    "/{room_id}/native-accept-speaker",
    response_model=StatusResponse,
)
async def native_accept_speaker(
    room_id: str,
    body: NativeAcceptSpeakerRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> StatusResponse:
    """Host-only: promote ``target_fid`` to speaker.

    Cross-checks the JFS-claimed fid against ``Room.host_fid`` so only
    the recorded host can promote.

    Failure modes mirror raise-hand, with one extra:
      * 403 — caller is not the recorded host.
    """
    room, room_uuid = await _load_native_room_for_stage(room_id, db, fid)
    if room.host_fid != fid:
        raise HTTPException(
            status_code=403, detail="Only the host can promote speakers"
        )
    await _enforce_native_stage_rate_limit(fid, room_uuid, "acc", redis)
    _decode_and_cross_check_bearer(
        body.user_jfs_bearer, fid, "rooms-native-accept-speaker", room.id
    )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    try:
        await spaces_service.accept_speaker_as_user(
            room_id=room.farcaster_room_id,
            target_fid=body.target_fid,
            bearer=body.user_jfs_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-accept-speaker] upstream failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502, detail="Couldn't promote on Farcaster"
        ) from exc

    # Host's promote upstream sets a pending_invite on the target — the
    # invitee polls the participants endpoint to see it, so drop the
    # cache so they pick it up within one tick instead of waiting up to
    # 10s for the TTL.
    await invalidate_participants_cache(redis, room.farcaster_room_id)
    return StatusResponse(status="ok")


@router.post(
    "/{room_id}/native-remove-speaker",
    response_model=StatusResponse,
)
async def native_remove_speaker(
    room_id: str,
    body: NativeRemoveSpeakerRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> StatusResponse:
    """Host-only: demote ``target_fid`` back to listener.

    Same auth posture as ``native_accept_speaker``.
    """
    room, room_uuid = await _load_native_room_for_stage(room_id, db, fid)
    if room.host_fid != fid:
        raise HTTPException(status_code=403, detail="Only the host can remove speakers")
    await _enforce_native_stage_rate_limit(fid, room_uuid, "rm", redis)
    _decode_and_cross_check_bearer(
        body.user_jfs_bearer, fid, "rooms-native-remove-speaker", room.id
    )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    try:
        await spaces_service.remove_speaker_as_user(
            room_id=room.farcaster_room_id,
            target_fid=body.target_fid,
            bearer=body.user_jfs_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-remove-speaker] upstream failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502, detail="Couldn't demote on Farcaster"
        ) from exc

    await invalidate_participants_cache(redis, room.farcaster_room_id)
    return StatusResponse(status="ok")


@router.post(
    "/{room_id}/native-accept-stage-invite",
    response_model=StatusResponse,
)
async def native_accept_stage_invite(
    room_id: str,
    body: NativeStageInviteResponseRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> StatusResponse:
    """Invitee-initiated: accept a pending stage invite.

    The caller (the invited user) signs a JFS bearer. We cross-check
    the JFS fid against the JWT fid — only the actual invitee can
    accept their own invite. Proxies to upstream
    ``/v1/audio-room/accept-stage-invite``.
    """
    room, room_uuid = await _load_native_room_for_stage(room_id, db, fid)
    await _enforce_native_stage_rate_limit(fid, room_uuid, "acc-inv", redis)
    _decode_and_cross_check_bearer(
        body.user_jfs_bearer,
        fid,
        "rooms-native-accept-stage-invite",
        room.id,
    )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    try:
        await spaces_service.accept_stage_invite_as_user(
            room_id=room.farcaster_room_id,
            bearer=body.user_jfs_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-accept-stage-invite] upstream failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't accept invite on Farcaster",
        ) from exc

    # Drop the participants cache so the next iOS poll sees the post-
    # accept state instead of a stale snapshot still showing the
    # pending invite.
    await invalidate_participants_cache(redis, room.farcaster_room_id)
    return StatusResponse(status="ok")


@router.post(
    "/{room_id}/native-decline-stage-invite",
    response_model=StatusResponse,
)
async def native_decline_stage_invite(
    room_id: str,
    body: NativeStageInviteResponseRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> StatusResponse:
    """Invitee-initiated: decline a pending stage invite.

    Same auth posture as accept — only the invitee can decline their
    own invite. Proxies to upstream
    ``/v1/audio-room/decline-stage-invite``.
    """
    room, room_uuid = await _load_native_room_for_stage(room_id, db, fid)
    await _enforce_native_stage_rate_limit(fid, room_uuid, "dec-inv", redis)
    _decode_and_cross_check_bearer(
        body.user_jfs_bearer,
        fid,
        "rooms-native-decline-stage-invite",
        room.id,
    )

    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        )

    try:
        await spaces_service.decline_stage_invite_as_user(
            room_id=room.farcaster_room_id,
            bearer=body.user_jfs_bearer,
        )
    except FarcasterSpacesConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail="Farcaster spaces service unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "[rooms-native-decline-stage-invite] upstream failed fid=%d err=%s",
            fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Couldn't decline invite on Farcaster",
        ) from exc

    await invalidate_participants_cache(redis, room.farcaster_room_id)
    return StatusResponse(status="ok")


# Rate limit for the mirror upsert. The endpoint is cheap (two SQL
# round-trips, no upstream call) but it does write to the DB, so cap it
# the same way as the other native endpoints to defend against a chatty
# client looping the rail.
NATIVE_MIRROR_RATE_LIMIT_PER_MIN = 60
NATIVE_MIRROR_RATE_LIMIT_WINDOW_SECONDS = 60


async def _enforce_native_mirror_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    rate_key = f"rooms:native_mirror:rl:{fid}"
    count = await redis.incr(rate_key)
    if int(count) == 1:
        await redis.expire(rate_key, NATIVE_MIRROR_RATE_LIMIT_WINDOW_SECONDS)
    if int(count) > NATIVE_MIRROR_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Native room mirror rate limit exceeded. Try again later.",
            headers={
                "Retry-After": str(NATIVE_MIRROR_RATE_LIMIT_WINDOW_SECONDS),
            },
        )


def _trusted_mirror_cast_hash(
    *,
    claimed: str | None,
    caller_fid: int,
    host_fid: int,
    upstream_hash: str | None,
) -> str | None:
    """Return ``claimed`` only if the host sent it or it matches upstream."""
    if not claimed:
        return None
    if caller_fid == host_fid:
        return claimed
    if upstream_hash and upstream_hash.lower() == claimed.lower():
        return upstream_hash
    return None


async def _fetch_upstream_root_cast_hash(
    request: Request, farcaster_room_id: str
) -> str | None:
    """Best-effort upstream root cast hash; ``None`` on any failure so the
    idempotent mirror path never fails just because the backfill can't be
    verified."""
    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        return None
    try:
        upstream = await spaces_service.get_room(farcaster_room_id)
    except (FarcasterSpacesConfigError, httpx.HTTPError, ValueError) as exc:
        logger.debug("mirror cast_hash verification skipped: %s", type(exc).__name__)
        return None
    return upstream.root_cast_hash if upstream is not None else None


@router.post(
    "/native/mirror",
    response_model=RoomResponse,
    status_code=status.HTTP_200_OK,
)
async def mirror_native_room(
    body: MirrorNativeRoomRequest,
    request: Request,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> RoomResponse:
    """Upsert a Juke ``Room`` mirror for an upstream-discovered Farcaster
    space so the in-app player can render and join it.

    The discovery rail surfaces Farcaster-native spaces fetched from
    ``client.farcaster.xyz`` that were not created via Juke. These have
    no ``Room`` row in the Juke DB, so the player (which expects one)
    can't render them. This endpoint creates that mirror on demand:

      * If a ``Room`` with the supplied ``farcaster_room_id`` already
        exists, it is returned untouched (idempotent).
      * Otherwise we upsert a ``User`` row for the host (the FK on
        ``Room.host_fid`` requires it) and insert a new ``Room`` with
        ``is_farcaster_native=True``, ``livekit_room_id=NULL``.

    Auth posture:
      * First-party Juke JWT required. Partner JWTs would otherwise be
        able to spam-create mirror rows attributed to arbitrary hosts.
      * Host attribution is derived from the AUTHORITATIVE upstream
        Farcaster space (fetched by ``farcaster_room_id``), NOT from the
        client-supplied ``host_fid``/profile — a caller cannot mint a
        mirror attributing a space to an arbitrary host. Any signed-in
        Juke user may mirror a space they can see; joining still requires
        a JFS bearer signed by the joiner's own app key. Already-mirrored
        rooms keep their at-creation host and stay openable even after the
        upstream space ends (no re-fetch on the idempotent path).

    Failure modes:
      * 401 — partner JWT.
      * 404 — the upstream space can't be found (can't verify the host).
      * 429 — rate limit (60/min per caller).
      * 503 — Farcaster spaces service unavailable.
    """
    await _enforce_native_mirror_rate_limit(fid, redis)

    def _build_response(
        room: Room,
        *,
        username: str | None,
        display_name: str | None,
        pfp_url: str | None,
    ) -> RoomResponse:
        # The host profile here is display-only (the client already has its own
        # copy). These values can arrive null — a viewer mirroring a space they
        # don't have the host cached for, or a host with no Farcaster username —
        # so coerce to safe fallbacks. `UserResponse.username`/`display_name` are
        # required non-null strings; passing None 500s the whole mirror call and
        # makes the space un-openable for everyone.
        safe_username = username or str(room.host_fid)
        safe_display_name = display_name or username or f"User {room.host_fid}"
        host_response = UserResponse(
            fid=room.host_fid,
            username=safe_username,
            display_name=safe_display_name,
            pfp_url=pfp_url,
            custody_address=None,
        )
        return RoomResponse(
            id=str(room.id),
            title=room.title,
            host_fid=room.host_fid,
            host=host_response,
            status=room.status,
            started_at=room.started_at.isoformat() if room.started_at else "",
            ended_at=room.ended_at.isoformat() if room.ended_at else None,
            scheduled_at=(room.scheduled_at.isoformat() if room.scheduled_at else None),
            speaker_count=0,
            listener_count=0,
            recording=False,
            cast_hash=room.cast_hash,
            allow_agents=False,
            rsvp_summary=None,
            farcaster_room_id=room.farcaster_room_id,
            is_farcaster_native=True,
        )

    existing_row = await db.execute(
        select(Room).where(Room.farcaster_room_id == body.farcaster_room_id)
    )
    existing: Room | None = existing_row.scalar_one_or_none()
    if existing is not None:
        # Backfill the FIP-2 root cast hash if a prior mirror call (made
        # before this field existed) left it null. Never overwrite an
        # existing cast_hash — it's the chat-conversation anchor and
        # stomping it would orphan the in-app chat thread. SECURITY: the
        # client value is only trusted from the host or when it matches
        # upstream, otherwise any viewer could anchor the room's chat to
        # an arbitrary cast.
        if body.root_cast_hash and not existing.cast_hash:
            upstream_hash: str | None = None
            if fid != existing.host_fid:
                upstream_hash = await _fetch_upstream_root_cast_hash(
                    request, body.farcaster_room_id
                )
            trusted_hash = _trusted_mirror_cast_hash(
                claimed=body.root_cast_hash,
                caller_fid=fid,
                host_fid=existing.host_fid,
                upstream_hash=upstream_hash,
            )
            if trusted_hash:
                existing.cast_hash = trusted_hash
                await db.commit()
                await db.refresh(existing)
        # Already mirrored: host_fid was set authoritatively at creation.
        # The response profile is display-only; the client already has it.
        return _build_response(
            existing,
            username=body.host_username,
            display_name=body.host_display_name,
            pfp_url=body.host_pfp_url,
        )

    # SECURITY: resolve the host (and title/state) from the AUTHORITATIVE
    # upstream Farcaster space, never from the client-supplied values, so a
    # caller can't mint a mirror attributing a space to an arbitrary host.
    # Only NEW mirrors hit upstream — already-mirrored rooms returned above
    # keep their at-creation host and stay openable after the space ends.
    spaces_service: FarcasterSpacesService | None = getattr(
        request.app.state, "farcaster_spaces_service", None
    )
    if spaces_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Farcaster spaces are unavailable.",
        )
    upstream = await spaces_service.get_room(body.farcaster_room_id)
    if upstream is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Upstream Farcaster space not found.",
        )
    host_fid = upstream.host.fid
    host_username = upstream.host.username
    host_display_name = upstream.host.display_name
    host_pfp_url = upstream.host.pfp_url
    room_title = upstream.title or body.title or ""
    upstream_state = upstream.state

    # Upsert host User row so the Room.host_fid FK is satisfied. Profile
    # fields come from the upstream space; we only fill blanks on an
    # existing row — never blank out a real value with None.
    host_row = await db.execute(select(User).where(User.fid == host_fid))
    host: User | None = host_row.scalar_one_or_none()
    if host is None:
        # `signer_uuid` is NOT NULL on the User table but we don't have
        # a real Neynar signer for a never-signed-in host. Use a stable
        # sentinel — the SIWF flow uses the same approach for users
        # without a signer.
        host = User(
            fid=host_fid,
            signer_uuid="mirror-only",
            username=host_username,
            display_name=host_display_name,
            pfp_url=host_pfp_url,
        )
        db.add(host)
        await db.flush()
    else:
        if host_username and not host.username:
            host.username = host_username
        if host_display_name and not host.display_name:
            host.display_name = host_display_name
        if host_pfp_url and not host.pfp_url:
            host.pfp_url = host_pfp_url

    # Map upstream state → Juke status. "live" → active; everything else
    # collapses to "scheduled" if scheduled_at is set, otherwise "ended".
    scheduled_at = upstream.scheduled_at or body.scheduled_at
    if scheduled_at is not None and scheduled_at.tzinfo is None:
        scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)

    if upstream_state == "live":
        juke_status = "active"
    elif upstream_state == "scheduled" and scheduled_at is not None:
        juke_status = "scheduled"
    elif upstream_state == "ended":
        juke_status = "ended"
    else:
        juke_status = "active"

    started_at = upstream.started_at or body.started_at
    if started_at is not None and started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    if started_at is None and juke_status == "active":
        started_at = datetime.now(tz=timezone.utc)

    room = Room(
        title=room_title,
        host_fid=host_fid,
        status=juke_status,
        started_at=started_at,
        scheduled_at=scheduled_at,
        is_farcaster_native=True,
        farcaster_room_id=body.farcaster_room_id,
        livekit_room_id=None,
        cast_hash=_trusted_mirror_cast_hash(
            claimed=body.root_cast_hash,
            caller_fid=fid,
            host_fid=host_fid,
            upstream_hash=upstream.root_cast_hash,
        )
        or upstream.root_cast_hash,
    )
    db.add(room)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        # Race: another caller created the same mirror between our
        # SELECT and INSERT. Re-query and return the winner.
        existing_row = await db.execute(
            select(Room).where(Room.farcaster_room_id == body.farcaster_room_id)
        )
        existing = existing_row.scalar_one_or_none()
        if existing is not None:
            return _build_response(
                existing,
                username=host_username,
                display_name=host_display_name,
                pfp_url=host_pfp_url,
            )
        raise
    await db.refresh(room)
    return _build_response(
        room,
        username=host_username,
        display_name=host_display_name,
        pfp_url=host_pfp_url,
    )


@router.get("/{room_id}", response_model=RoomDetailResponse)
async def get_room(
    room_id: str,
    current_fid: int | None = Depends(get_optional_current_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomDetailResponse:
    """Get room details including the live participant list and hand-raise queue."""
    return await room_service.get_room(room_id=room_id, current_fid=current_fid)


@router.get(
    "/{room_id}/embed-policy",
    response_model=RoomEmbedPolicyResponse,
)
async def get_room_embed_policy(
    room_id: str,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> RoomEmbedPolicyResponse:
    """Per-room iframe embedding policy for `landing/middleware.ts`.

    Returns the owning developer app's `allowed_origins` when the room
    was created via `POST /v1/developer/spaces` and the app is still
    active. Returns `allowed_origins=null` for unlinked rooms (legacy
    rooms predating the SDK that have no enforcement intent), and
    `allowed_origins=[]` when the owning app exists but has been
    suspended/deleted — an explicit block so a suspended developer's
    rooms aren't made *more* permissive than the admin intended.

    Cache TTL is kept short (~2 min worst-case) so suspension or origin
    changes propagate quickly to the edge.
    """
    cache_control = "public, max-age=30, s-maxage=60, stale-while-revalidate=120"

    try:
        room_uuid = uuid.UUID(room_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Room not found")

    row = await db.execute(select(Room.created_by_app_id).where(Room.id == room_uuid))
    app_id = row.scalar_one_or_none()
    if app_id is None:
        # Either room doesn't exist or has no owning app. We deliberately
        # don't distinguish so a 404 here can't be used as an existence
        # oracle for arbitrary UUIDs. `null` here means "no enforcement
        # intent" — these are legacy rooms predating the SDK.
        response.headers["Cache-Control"] = cache_control
        return RoomEmbedPolicyResponse(allowed_origins=None)

    app_row = await db.execute(
        select(DeveloperApp.allowed_origins, DeveloperApp.status).where(
            DeveloperApp.id == app_id
        )
    )
    app = app_row.first()
    if app is None or app.status != "active":
        # The app was deleted or suspended. Block all embedding — a
        # suspended developer's rooms must not silently become *more*
        # permissive than the admin intended.
        response.headers["Cache-Control"] = cache_control
        return RoomEmbedPolicyResponse(allowed_origins=[])

    response.headers["Cache-Control"] = cache_control
    return RoomEmbedPolicyResponse(allowed_origins=list(app.allowed_origins or []))


@router.post("/{room_id}/chat-target", response_model=RoomResponse)
async def ensure_room_chat_target(
    room_id: str,
    current_user_fid: int = Depends(require_non_demo_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomResponse:
    """Create or return the Farcaster cast hash used as this room's chat target."""
    return await room_service.ensure_chat_target(room_id=room_id, fid=current_user_fid)


@router.post("/{room_id}/rsvp", response_model=RsvpResponse)
async def rsvp_room(
    room_id: str,
    current_user_fid: int = Depends(require_non_demo_user),
    room_service: RoomService = Depends(get_room_service),
) -> RsvpResponse:
    """RSVP to a scheduled room."""
    return await room_service.register_rsvp(room_id, current_user_fid)


@router.delete("/{room_id}/rsvp", response_model=RsvpResponse)
async def unrsvp_room(
    room_id: str,
    current_user_fid: int = Depends(require_non_demo_user),
    room_service: RoomService = Depends(get_room_service),
) -> RsvpResponse:
    """Remove RSVP from a scheduled room."""
    return await room_service.unregister_rsvp(room_id, current_user_fid)


@router.post("/{room_id}/start", response_model=RoomGoLiveResponse)
async def start_room(
    room_id: str,
    current_user_fid: int = Depends(require_non_demo_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomGoLiveResponse:
    """Start a scheduled room. Only the host can go live."""
    return await room_service.start_scheduled_room(
        room_id=room_id, fid=current_user_fid
    )


@router.delete("/{room_id}", response_model=StatusResponse)
async def end_room(
    room_id: str,
    current_user_fid: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    room_service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """End an active room or cancel a scheduled one. Host/co-host only.

    Native Farcaster rooms are NOT accepted here: their upstream
    counterpart on ``client.farcaster.xyz`` would stay alive even after
    we flipped the local row, leaving discovery and the upstream out
    of sync. Native rooms must end via
    ``POST /v1/rooms/{room_id}/end`` which dispatches the upstream
    end through the service-FID bearer.
    """
    # Defense-in-depth: refuse native rooms before touching the
    # RoomService. Avoids the legacy code path silently flipping the
    # Juke row to "cancelled" (for scheduled) or 403ing (for active,
    # because Redis has no participant state for native rooms) while
    # the upstream Farcaster room stays live.
    try:
        room_uuid = uuid.UUID(room_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Room not found") from exc

    row = await db.execute(select(Room.is_farcaster_native).where(Room.id == room_uuid))
    is_native = row.scalar_one_or_none()
    if is_native is True:
        raise HTTPException(
            status_code=400,
            detail="Use POST /v1/rooms/{id}/end for Farcaster-native rooms",
        )

    await room_service.end_room(room_id=room_id, fid=current_user_fid)
    return StatusResponse(status="ended")


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------


@router.post("/{room_id}/recording/start")
async def start_recording(
    room_id: str,
    current_user_fid: int = Depends(require_non_demo_user),
    room_service: RoomService = Depends(get_room_service),
) -> dict:
    """Start recording the room. Host/co-host only.

    Returns ``{egress_id, status: "recording"}``. The recording URL is
    populated asynchronously when LiveKit emits the ``egress_ended`` webhook.
    """
    return await room_service.start_recording(room_id=room_id, fid=current_user_fid)


@router.post("/{room_id}/recording/stop")
async def stop_recording(
    room_id: str,
    current_user_fid: int = Depends(require_non_demo_user),
    room_service: RoomService = Depends(get_room_service),
) -> dict:
    """Stop the active recording. Host/co-host only."""
    return await room_service.stop_recording(room_id=room_id, fid=current_user_fid)
