import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from livekit import api as livekit_api

from app.config import settings
from app.dependencies import get_db, get_redis
from app.models.miniapp_notification import MiniAppNotification
from app.models.participant import Participant
from app.models.room import Room
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService

logger = logging.getLogger(__name__)

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
    except Exception as exc:
        logger.warning("LiveKit webhook verification failed: %s", exc)
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

    # Fetch room before updating so we can clean up the Neynar webhook
    result = await db.execute(
        select(Room).where(Room.id == room_name, Room.status == "active")
    )
    room = result.scalar_one_or_none()

    await db.execute(
        update(Room)
        .where(Room.id == room_name, Room.status == "active")
        .values(status="ended", ended_at=datetime.now(timezone.utc))
    )
    await db.commit()

    # Clean up Neynar webhook (best-effort)
    if room and room.neynar_webhook_id:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.delete(
                    "https://api.neynar.com/v2/farcaster/webhook",
                    params={"webhook_id": room.neynar_webhook_id},
                    headers={"x-api-key": settings.NEYNAR_API_KEY},
                )
                resp.raise_for_status()
                logger.info("Deleted Neynar webhook %s (room auto-closed)", room.neynar_webhook_id)
        except Exception as e:
            logger.warning("Failed to delete Neynar webhook %s: %s", room.neynar_webhook_id, e)

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

    # Notify any still-connected participants that the recording is fully
    # finalized so their UI can clear the REC badge. Best-effort; room may
    # already have been torn down by this point.
    livekit = LiveKitService()
    try:
        payload = json.dumps(
            {"type": "recording_state", "recording": False}
        ).encode()
        await livekit.send_data(room_name, payload, topic="space_state")
    except Exception as exc:
        logger.warning(
            "Failed to broadcast recording_state=false after egress_ended for %s: %s",
            room_name,
            exc,
        )
    finally:
        try:
            await livekit.close()
        except Exception:
            pass


def _verify_neynar_signature(body: bytes, secret: str, signature: str) -> bool:
    """Verify Neynar webhook HMAC-SHA512 signature."""
    expected = hmac.new(
        secret.encode(),
        body,
        hashlib.sha512,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


@router.post("/neynar")
async def neynar_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Receive Neynar webhook events for cast replies and broadcast via LiveKit data channel."""
    body = await request.body()
    signature = request.headers.get("x-neynar-signature", "")

    if not signature:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing signature")

    payload = json.loads(body)
    event_type = payload.get("type")

    if event_type != "cast.created":
        return {"status": "ok"}

    parent_hash = payload.get("data", {}).get("parent_hash")
    if not parent_hash:
        return {"status": "ok"}

    # Find the active room whose announcement cast matches this parent_hash
    result = await db.execute(
        select(Room).where(Room.cast_hash == parent_hash, Room.status == "active")
    )
    room = result.scalar_one_or_none()

    # Uniform 401 for no room, missing secret, or bad signature — prevents oracle
    if (
        not room
        or not room.neynar_webhook_secret
        or not _verify_neynar_signature(body, room.neynar_webhook_secret, signature)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook signature",
        )

    # Broadcast a "new_reply" data message to all participants in the LiveKit room
    room_id = str(room.id)
    livekit = LiveKitService()
    try:
        message = json.dumps({
            "type": "new_reply",
            "cast_hash": parent_hash,
        }).encode()
        await livekit.send_data(room_id, message, topic="space_chat")
    except Exception as e:
        logger.warning("Failed to broadcast new_reply to room %s: %s", room_id, e)
    finally:
        await livekit.close()

    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Farcaster miniapp webhook (forwarded from Next.js at juke.audio/api/webhook)
# ---------------------------------------------------------------------------


class MiniAppWebhookRequest(BaseModel):
    fid: int
    event: str
    notification_url: str | None = None
    notification_token: str | None = None


ALLOWED_NOTIFICATION_HOSTS = {
    "api.warpcast.com",
    "api.warpcast.xyz",
    "notifs.warpcast.com",
}


def _validate_notification_url(url: str) -> bool:
    """Only allow notification URLs from known Farcaster client domains."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return parsed.scheme == "https" and parsed.hostname in ALLOWED_NOTIFICATION_HOSTS
    except Exception:
        return False


@router.post("/miniapp")
async def miniapp_webhook(
    body: MiniAppWebhookRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Handle Farcaster miniapp server events forwarded from the Next.js webhook.

    Protected by a shared secret in the X-Webhook-Secret header. Only the
    Next.js proxy at juke.audio/api/webhook should call this endpoint.
    """
    webhook_secret = request.headers.get("x-webhook-secret", "")
    if not settings.MINIAPP_WEBHOOK_SECRET or webhook_secret != settings.MINIAPP_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook secret",
        )

    match body.event:
        case "miniapp_added" | "notifications_enabled":
            if (
                body.notification_url
                and body.notification_token
                and _validate_notification_url(body.notification_url)
            ):
                result = await db.execute(
                    select(MiniAppNotification).where(
                        MiniAppNotification.fid == body.fid
                    )
                )
                existing = result.scalar_one_or_none()
                if existing:
                    existing.notification_url = body.notification_url
                    existing.notification_token = body.notification_token
                    existing.is_active = True
                else:
                    db.add(
                        MiniAppNotification(
                            fid=body.fid,
                            notification_url=body.notification_url,
                            notification_token=body.notification_token,
                            is_active=True,
                        )
                    )
                await db.commit()

        case "miniapp_removed" | "notifications_disabled":
            await db.execute(
                update(MiniAppNotification)
                .where(MiniAppNotification.fid == body.fid)
                .values(is_active=False)
            )
            await db.commit()

    return {"status": "ok"}


@router.post("/neynar/notifications")
async def neynar_notification_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Receive global Neynar webhook events for push notifications (follows, likes, replies, recasts)."""
    body = await request.body()
    signature = request.headers.get("x-neynar-signature", "")

    if not signature:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing signature")

    payload = json.loads(body)
    event_type = payload.get("type", "")

    # Select the correct secret based on event type
    secret_map = {
        "cast.created": settings.NEYNAR_WEBHOOK_SECRET_CAST,
        "reaction.created": settings.NEYNAR_WEBHOOK_SECRET_REACTION,
        "follow.created": settings.NEYNAR_WEBHOOK_SECRET_FOLLOW,
    }
    webhook_secret = secret_map.get(event_type, "")
    if not webhook_secret or not _verify_neynar_signature(body, webhook_secret, signature):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid webhook signature")

    from app.services.push_service import PushService
    push_service = PushService(db, redis)
    await push_service.handle_notification_event(event_type, payload)

    return {"status": "ok"}
