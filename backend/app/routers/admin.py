"""
Admin router — privileged endpoints for room and participant management.

Endpoints:
  GET    /v1/admin/rooms                              List all active rooms
  DELETE /v1/admin/rooms/{room_id}                    Force-end any room
  DELETE /v1/admin/rooms/{room_id}/participants/{fid}  Force-kick participant
  POST   /v1/admin/setup-webhooks                     Register Neynar push webhooks
"""

import logging

import httpx
from fastapi import APIRouter, Depends, Path
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_db, get_redis
from app.middleware.auth import get_admin_user
from app.schemas.common import StatusResponse
from app.schemas.room import RoomListResponse
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService
from app.services.room_service import RoomService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/admin", tags=["admin"])


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


@router.get("/rooms", response_model=RoomListResponse)
async def list_active_rooms(
    _admin_fid: int = Depends(get_admin_user),
    room_service: RoomService = Depends(get_room_service),
) -> RoomListResponse:
    """List all active rooms from the database (admin only)."""
    rooms = await room_service.list_active_rooms_from_db()
    return RoomListResponse(rooms=rooms, next_cursor=None)


@router.delete("/rooms/{room_id}", response_model=StatusResponse)
async def force_end_room(
    room_id: str,
    admin_fid: int = Depends(get_admin_user),
    room_service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Force-end any active room (admin only)."""
    await room_service.admin_end_room(room_id, admin_fid)
    return StatusResponse(status="ended")


@router.delete("/rooms/{room_id}/participants/{fid}", response_model=StatusResponse)
async def force_kick_participant(
    room_id: str,
    fid: int = Path(..., ge=1),
    admin_fid: int = Depends(get_admin_user),
    room_service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Force-kick a participant from any room (admin only)."""
    await room_service.admin_kick_participant(room_id, fid, admin_fid)
    return StatusResponse(status="kicked")


NEYNAR_BASE = "https://api.neynar.com/v2"


@router.post("/setup-webhooks")
async def setup_push_webhooks(
    _admin_fid: int = Depends(get_admin_user),
):
    """Register Neynar webhooks for push notifications. Run once on initial setup.

    Returns the webhook IDs and secrets — copy the secrets into your env vars:
      NEYNAR_WEBHOOK_SECRET_CAST, NEYNAR_WEBHOOK_SECRET_REACTION, NEYNAR_WEBHOOK_SECRET_FOLLOW
    """
    webhook_url = f"{settings.API_BASE_URL}/v1/webhooks/neynar/notifications"
    webhooks_to_create = [
        ("juke-push-cast", {"cast.created": {}}, "NEYNAR_WEBHOOK_SECRET_CAST"),
        ("juke-push-reaction", {"reaction.created": {}}, "NEYNAR_WEBHOOK_SECRET_REACTION"),
        ("juke-push-follow", {"follow.created": {}}, "NEYNAR_WEBHOOK_SECRET_FOLLOW"),
    ]

    results = []
    async with httpx.AsyncClient() as client:
        for name, subscription, env_var in webhooks_to_create:
            resp = await client.post(
                f"{NEYNAR_BASE}/farcaster/webhook",
                json={
                    "name": name,
                    "url": webhook_url,
                    "subscription": subscription,
                },
                headers={"x-api-key": settings.NEYNAR_API_KEY},
                timeout=15.0,
            )
            resp.raise_for_status()
            webhook = resp.json().get("webhook", {})
            results.append({
                "env_var": env_var,
                "webhook_id": webhook.get("webhook_id"),
                "secret": webhook.get("secret"),
                "event": list(subscription.keys())[0],
            })
            logger.info("Registered Neynar webhook %s (%s)", webhook.get("webhook_id"), name)

    return {"webhooks": results}
