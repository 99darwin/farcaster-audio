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
import json
from datetime import datetime, timedelta, timezone
from typing import Literal

from app.config import settings
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import (
    get_current_user,
    get_db,
    get_optional_current_user,
    get_redis,
    require_non_demo_user,
)
from app.schemas.common import StatusResponse
from app.schemas.room import (
    RoomCreate,
    RoomCreateResponse,
    RoomDetailResponse,
    RoomGoLiveResponse,
    RoomListResponse,
    RsvpResponse,
)
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService
from app.services.room_service import RoomService

router = APIRouter(prefix="/v1/rooms", tags=["rooms"])


async def get_room_service(
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    redis_service = RedisService(redis)
    livekit_service = LiveKitService()
    try:
        yield RoomService(db, redis_service, livekit_service)
    finally:
        await livekit_service.close()


MIN_SCHEDULE_AHEAD = timedelta(minutes=5)
MAX_SCHEDULE_AHEAD = timedelta(days=30)


def _is_allowed_websocket_origin(origin: str | None) -> bool:
    """Allow native/app clients; enforce CORS origins for browser sockets."""
    if not origin:
        return True
    if not origin.startswith(("http://", "https://")):
        return True
    return origin in settings.CORS_ORIGINS


@router.get("", response_model=RoomListResponse)
async def list_rooms(
    status: Literal["active", "scheduled"] = Query(default="active"),
    limit: int = Query(default=20, ge=1, le=50),
    cursor: int = Query(default=0, ge=0),
    room_service: RoomService = Depends(get_room_service),
) -> RoomListResponse:
    """Return a paginated list of rooms filtered by status."""
    if status == "scheduled":
        return await room_service.list_scheduled_rooms(limit=limit, cursor=cursor)
    return await room_service.list_active_rooms(limit=limit, cursor=cursor)


@router.websocket("/events")
async def room_events(websocket: WebSocket) -> None:
    """Stream global active/scheduled room changes to clients."""
    if not _is_allowed_websocket_origin(websocket.headers.get("origin")):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    redis = websocket.app.state.redis
    pubsub = redis.pubsub()
    await pubsub.subscribe(RedisService.ROOM_DISCOVERY_CHANNEL)

    try:
        while True:
            message = await pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=25,
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
    finally:
        await pubsub.unsubscribe(RedisService.ROOM_DISCOVERY_CHANNEL)
        await pubsub.close()


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


@router.get("/{room_id}", response_model=RoomDetailResponse)
async def get_room(
    room_id: str,
    current_fid: int | None = Depends(get_optional_current_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomDetailResponse:
    """Get room details including the live participant list and hand-raise queue."""
    return await room_service.get_room(room_id=room_id, current_fid=current_fid)


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
    room_service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """End an active room. Only the host or a co-host may call this endpoint."""
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
