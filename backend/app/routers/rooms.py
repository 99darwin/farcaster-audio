"""
Rooms router — CRUD endpoints for audio room lifecycle.

Endpoints:
  GET  /v1/rooms              List active rooms (paginated)
  POST /v1/rooms              Create a new room
  GET  /v1/rooms/{room_id}   Get room detail with live participants
  DELETE /v1/rooms/{room_id} End an active room (host/co-host only)
"""

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_redis
from app.schemas.common import StatusResponse
from app.schemas.room import RoomCreate, RoomCreateResponse, RoomDetailResponse, RoomListResponse
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


@router.get("", response_model=RoomListResponse)
async def list_rooms(
    status: str = Query(default="active"),
    limit: int = Query(default=20, ge=1, le=50),
    cursor: int = Query(default=0, ge=0),
    room_service: RoomService = Depends(get_room_service),
) -> RoomListResponse:
    """Return a paginated list of active rooms sorted by recency (newest first)."""
    return await room_service.list_active_rooms(limit=limit, cursor=cursor)


@router.post("", response_model=RoomCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_room(
    body: RoomCreate,
    current_user_fid: int = Depends(get_current_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomCreateResponse:
    """Create a new audio room. The authenticated user becomes the host."""
    return await room_service.create_room(
        fid=current_user_fid,
        title=body.title,
        announce_cast=body.announce_cast,
    )


@router.get("/{room_id}", response_model=RoomDetailResponse)
async def get_room(
    room_id: str,
    room_service: RoomService = Depends(get_room_service),
) -> RoomDetailResponse:
    """Get room details including the live participant list and hand-raise queue."""
    return await room_service.get_room(room_id=room_id)


@router.delete("/{room_id}", response_model=StatusResponse)
async def end_room(
    room_id: str,
    current_user_fid: int = Depends(get_current_user),
    room_service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """End an active room. Only the host or a co-host may call this endpoint."""
    await room_service.end_room(room_id=room_id, fid=current_user_fid)
    return StatusResponse(status="ended")
