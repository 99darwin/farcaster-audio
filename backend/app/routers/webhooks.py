from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from livekit import api as livekit_api

from app.config import settings
from app.dependencies import get_db, get_redis
from app.models.participant import Participant
from app.models.room import Room
from app.services.redis_service import RedisService

router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])


@router.post("/livekit")
async def livekit_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Receive and process LiveKit webhook events."""
    body = await request.body()
    auth_header = request.headers.get("Authorization", "")

    try:
        token_verifier = livekit_api.TokenVerifier(
            api_key=settings.LIVEKIT_API_KEY,
            api_secret=settings.LIVEKIT_API_SECRET,
        )
        receiver = livekit_api.WebhookReceiver(token_verifier)
        event = receiver.receive(body.decode(), auth_header)
    except (ValueError, Exception):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Webhook verification failed",
        )

    redis_service = RedisService(redis)

    match event.event:
        case "participant_joined":
            await _handle_participant_joined(event, redis_service)
        case "participant_left":
            await _handle_participant_left(event, db, redis_service)
        case "room_finished":
            await _handle_room_finished(event, db, redis_service)
        case "track_published":
            pass  # No action needed for MVP
        case "egress_ended":
            await _handle_egress_ended(event, db)

    return {"status": "ok"}


async def _handle_participant_joined(event, redis_service: RedisService):
    """Log participant join — actual join is handled by POST /join endpoint."""
    # The /join endpoint already handles Redis state.
    # This webhook is for reconciliation / logging only.
    pass


async def _handle_participant_left(
    event, db: AsyncSession, redis_service: RedisService
):
    """Clean up participant state when LiveKit reports they left."""
    room_name = event.room.name  # UUID string used as room_id
    identity = event.participant.identity  # FID as string
    fid = int(identity)

    # Remove participant from Redis
    await redis_service.remove_participant(room_name, fid)
    await redis_service.remove_from_hand_queue(room_name, fid)
    await redis_service.clear_user_active_room(fid)

    # Refresh aggregate counts in room state
    room_state = await redis_service.get_room_state(room_name)
    if room_state:
        room_state["speaker_count"] = await redis_service.get_speaker_count(room_name)
        room_state["listener_count"] = await redis_service.get_listener_count(room_name)
        await redis_service.set_room_state(room_name, room_state)

    # Stamp left_at in the DB for the active participant row
    await db.execute(
        update(Participant)
        .where(
            Participant.room_id == room_name,
            Participant.fid == fid,
            Participant.left_at.is_(None),
        )
        .values(left_at=datetime.now(timezone.utc))
    )
    await db.commit()

    await redis_service.publish_room_event(room_name, {
        "type": "participant_left",
        "fid": fid,
    })


async def _handle_room_finished(
    event, db: AsyncSession, redis_service: RedisService
):
    """Handle LiveKit room auto-close (empty_timeout reached)."""
    room_name = event.room.name

    await db.execute(
        update(Room)
        .where(Room.id == room_name, Room.status == "active")
        .values(status="ended", ended_at=datetime.now(timezone.utc))
    )
    await db.commit()

    await redis_service.clear_room_state(room_name)

    await redis_service.publish_room_event(room_name, {"type": "room_ended"})


async def _handle_egress_ended(event, db: AsyncSession):
    """Store recording URL when egress completes."""
    egress_info = getattr(event, "egress_info", None)
    if not egress_info:
        return

    room_name = getattr(egress_info, "room_name", None)
    if not room_name:
        return

    file_url = None
    for result in getattr(egress_info, "file_results", []):
        location = getattr(result, "location", None)
        if location:
            file_url = location
            break

    if not file_url:
        return

    await db.execute(
        update(Room)
        .where(Room.id == room_name)
        .values(recording_url=file_url, recording=False)
    )
    await db.commit()
