"""
Participants router — all endpoints scoped to a room participant lifecycle.

Dependency pattern:
  - `get_room_service` composes db + redis into a RoomService instance.
  - `get_current_user` extracts the authenticated caller's FID from the JWT.
  - `room_id` is always a path parameter (string UUID).
"""

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_redis
from app.schemas.common import StatusResponse
from app.schemas.participant import (
    BanRequest,
    BanResponse,
    JoinResponse,
    PromoteResponse,
    RaiseHandRequest,
    RaiseHandResponse,
    TokenRefreshResponse,
)
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService
from app.services.room_service import RoomService

router = APIRouter(prefix="/v1/rooms", tags=["participants"])


async def get_room_service(
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    livekit = LiveKitService()
    try:
        yield RoomService(db=db, redis=RedisService(redis), livekit=livekit)
    finally:
        await livekit.close()


# ---------------------------------------------------------------------------
# Join / Leave
# ---------------------------------------------------------------------------


@router.post("/{room_id}/join", response_model=JoinResponse)
async def join_room(
    room_id: str,
    fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> JoinResponse:
    """Join a room as a listener. Returns LiveKit token, WS URL, and current room state."""
    return await service.join_room(room_id=room_id, fid=fid)


@router.post("/{room_id}/leave", response_model=StatusResponse)
async def leave_room(
    room_id: str,
    fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Leave a room. Removes the caller from Redis and marks left_at in the DB."""
    await service.leave_room(room_id=room_id, fid=fid)
    return StatusResponse(status="ok")


# ---------------------------------------------------------------------------
# Hand raise
# ---------------------------------------------------------------------------


@router.post("/{room_id}/raise-hand", response_model=RaiseHandResponse)
async def raise_hand(
    room_id: str,
    body: RaiseHandRequest,
    fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> RaiseHandResponse:
    """Toggle hand-raise state for the authenticated listener."""
    return await service.raise_hand(room_id=room_id, fid=fid, raised=body.raised)


# ---------------------------------------------------------------------------
# Moderation — promote / demote / mute / kick / ban
# ---------------------------------------------------------------------------


@router.post("/{room_id}/participants/{fid}/promote", response_model=PromoteResponse)
async def promote_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> PromoteResponse:
    """Promote a listener to speaker. Requires host or co-host role."""
    return await service.promote_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )


@router.post("/{room_id}/participants/{fid}/demote", response_model=PromoteResponse)
async def demote_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> PromoteResponse:
    """Demote a speaker or co-host back to listener. Requires host or co-host role."""
    return await service.demote_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )


@router.post("/{room_id}/participants/{fid}/mute", response_model=StatusResponse)
async def mute_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Server-side mute a speaker. Hosts and co-hosts only."""
    await service.mute_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )
    return StatusResponse(status="ok")


@router.post("/{room_id}/participants/{fid}/kick", response_model=StatusResponse)
async def kick_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Forcibly remove a participant from the room."""
    await service.kick_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )
    return StatusResponse(status="ok")


@router.post("/{room_id}/participants/{fid}/ban", response_model=BanResponse)
async def ban_participant(
    room_id: str,
    fid: int,
    body: BanRequest,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> BanResponse:
    """Kick and ban a participant. Optionally specify reason and duration."""
    return await service.ban_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
        reason=body.reason,
        duration_hours=body.duration_hours,
    )


# ---------------------------------------------------------------------------
# Token refresh
# ---------------------------------------------------------------------------


@router.post("/{room_id}/token", response_model=TokenRefreshResponse)
async def refresh_token(
    room_id: str,
    fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> TokenRefreshResponse:
    """Issue a fresh LiveKit token for an active participant."""
    return await service.refresh_token(room_id=room_id, fid=fid)
