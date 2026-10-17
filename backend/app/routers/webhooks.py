import hmac
import ipaddress
import json
import logging
from datetime import datetime, timezone
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import DataError
from sqlalchemy.ext.asyncio import AsyncSession

from livekit import api as livekit_api

from app.clients.hypersnap_webhooks import (
    HEADER_SIGNATURE as HYPERSNAP_SIGNATURE_HEADER,
    verify_delivery_signature,
)
from app.clients.hypersnap import HypersnapError
from app.config import settings
from app.dependencies import get_db, get_redis
from app.models.miniapp_notification import MiniAppNotification
from app.models.participant import Participant
from app.models.recording import Recording
from app.models.room import Room
from app.services.client_ip import client_ip as _client_ip
from app.services.dev_webhook_service import dispatch as dispatch_dev_webhook
from app.services.hypersnap_webhook_service import (
    EVENT_CAST_CREATED,
    ROOM_REPLY_WEBHOOK,
    cast_of,
    dedupe_key,
    normalize_cast_hash,
    schedule_room_reply_sync,
    secrets_by_event_type,
    to_push_payload,
)
from app.services.livekit_admission_service import (
    AdmissionAction,
    enforce_admission,
)
from app.services.livekit_service import LiveKitService
from app.services.miniapp_webhook_service import (
    JfsEnvelope,
    JfsVerificationError,
    is_app_key_active_for_fid,
    verify_jfs_signature,
)
from app.services.redis_service import RedisService
from app.services.storage_service import (
    StorageService,
    extract_recording_s3_key,
)
from app.services.webhook_guard import (
    enforce_ip_rate_limit,
    ensure_auth_failure_budget,
    read_capped_body,
    record_auth_failure,
)

logger = logging.getLogger(__name__)

SYSTEM_ACTOR_FID = 0  # sentinel for system-initiated actions (not a real Farcaster FID)

# At-least-once delivery dedupe for Hypersnap events. Hypersnap deliveries
# carry no timestamp header to bound freshness, so the dedupe window is the
# replay window: keep it long enough that a captured delivery can't be
# replayed once its key expires.
WEBHOOK_SEEN_KEY_PREFIX = "hypersnap:webhook:seen:"
ROOM_REPLY_SEEN_KEY_PREFIX = "hypersnap:webhook:seen:room_reply:"
WEBHOOK_SEEN_TTL_SECONDS = 14 * 24 * 60 * 60

# Per-IP volume caps per route. Senders are a handful of upstream IPs, so
# these are sized well above their legitimate burst rate.
RATE_LIMIT_WINDOW_SECONDS = 60
LIVEKIT_RATE_LIMIT = 1200
HYPERSNAP_RATE_LIMIT = 3000
MINIAPP_RATE_LIMIT = 300

ROUTE_LIVEKIT = "livekit"
ROUTE_HYPERSNAP_ROOM_REPLY = "hypersnap"
ROUTE_HYPERSNAP_NOTIFICATIONS = "hypersnap_notifications"
ROUTE_MINIAPP = "miniapp"
ROUTE_MINIAPP_PROXY = "miniapp_proxy"
# Set by landing/app/api/webhook/route.ts; trusted only with a valid secret.
MINIAPP_SENDER_IP_HEADER = "x-juke-sender-ip"

router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])


async def _guard_unauthenticated(
    request: Request, redis, *, route: str, limit: int
) -> str:
    """Per-IP volume + failed-auth budget, checked before any body/crypto work.

    Returns the client IP so the caller can record auth failures against it.
    """
    client_ip = _client_ip(request)
    await enforce_ip_rate_limit(
        redis,
        route=route,
        client_ip=client_ip,
        limit=limit,
        window_seconds=RATE_LIMIT_WINDOW_SECONDS,
    )
    await ensure_auth_failure_budget(redis, route=route, client_ip=client_ip)
    return client_ip


@router.post("/livekit")
async def livekit_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Receive and process LiveKit webhook events."""
    client_ip = await _guard_unauthenticated(
        request, redis, route=ROUTE_LIVEKIT, limit=LIVEKIT_RATE_LIMIT
    )
    body = await read_capped_body(request)
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
        await record_auth_failure(redis, route=ROUTE_LIVEKIT, client_ip=client_ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Webhook verification failed",
        )

    redis_service = RedisService(redis)
    recording_agent = getattr(request.app.state, "recording_agent_service", None)
    farcaster_spaces = getattr(request.app.state, "farcaster_spaces_service", None)

    match event.event:
        case "participant_joined":
            await _handle_participant_joined(event, db, redis_service)
        case "participant_left":
            await _handle_participant_left(event, db, redis_service)
        case "room_finished":
            await _handle_room_finished(
                event, db, redis_service, recording_agent, farcaster_spaces
            )
        case "track_published":
            pass  # No action needed for MVP
        case "egress_ended":
            await _handle_egress_ended(event, db, redis_service)

    return {"status": "ok"}


async def _load_room_for_dev_webhook(db: AsyncSession, room_id: str) -> Room | None:
    """Fetch the Room row keyed by id string, tolerating UUID parse errors.

    Returns ``None`` only for the known-benign cases — malformed UUIDs and
    nonexistent rooms. Real DB outages (``OperationalError``,
    ``DisconnectionError``, etc.) intentionally propagate so LiveKit's
    webhook retry kicks in instead of silently dropping the event.
    """
    try:
        result = await db.execute(select(Room).where(Room.id == room_id))
    except (DataError, ValueError):
        logger.info("Ignoring dev webhook dispatch for non-UUID room id %r", room_id)
        return None
    return result.scalar_one_or_none()


async def _handle_participant_joined(
    event, db: AsyncSession, redis_service: RedisService
):
    """Dispatch ``participant.joined`` to outbound developer webhooks.

    The /join endpoint owns Redis state; this hook fires after LiveKit
    confirms the participant is actually connected. Anonymous listeners
    and LiveKit virtual participants (egress workers, etc.) are skipped
    so dev webhooks only see real humans + agents.
    """
    room_name = event.room.name
    identity = event.participant.identity

    if isinstance(identity, str) and identity.startswith("anon:"):
        return
    try:
        fid = int(identity)
    except (TypeError, ValueError):
        return

    # Join tokens can't be revoked, so re-validate every (re)connect
    # against bans, kick/demote markers and the authoritative Redis role.
    livekit_svc = LiveKitService()
    try:
        action = await enforce_admission(
            db=db,
            redis_service=redis_service,
            livekit=livekit_svc,
            room_id=room_name,
            fid=fid,
            participant=event.participant,
        )
    finally:
        await livekit_svc.close()
    if action is AdmissionAction.REMOVE:
        return

    room = await _load_room_for_dev_webhook(db, room_name)
    if room is None or room.created_by_app_id is None:
        return

    participant_data = await redis_service.get_participant(room_name, fid)
    role = (participant_data or {}).get("role", "listener")
    display_name = (participant_data or {}).get("display_name")

    await dispatch_dev_webhook(
        db,
        app_id=room.created_by_app_id,
        event_type="participant.joined",
        data={
            "room_id": room_name,
            "fid": fid,
            "role": role,
            "display_name": display_name,
        },
    )


async def _handle_participant_left(
    event, db: AsyncSession, redis_service: RedisService
):
    """Clean up participant state when LiveKit reports they left."""
    room_name = event.room.name  # UUID string used as room_id
    identity = event.participant.identity  # FID as string for humans

    if isinstance(identity, str) and identity.startswith("anon:"):
        await redis_service.remove_anonymous_listener(
            room_name, identity.removeprefix("anon:")
        )
        return

    # Egress workers and other LiveKit virtual participants join with
    # non-numeric identities (e.g. "EG_iKSbVaXFu383"). Skip those — they
    # have no Participant row, no fid-keyed Redis state, and trigger no
    # client-facing event. We only care about real users here.
    try:
        fid = int(identity)
    except (TypeError, ValueError):
        return

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

    await redis_service.publish_room_event(
        room_name,
        {
            "type": "participant_left",
            "fid": fid,
        },
    )

    room = await _load_room_for_dev_webhook(db, room_name)
    if room is not None and room.created_by_app_id is not None:
        await dispatch_dev_webhook(
            db,
            app_id=room.created_by_app_id,
            event_type="participant.left",
            data={
                "room_id": room_name,
                "fid": fid,
            },
        )


async def _handle_room_finished(
    event,
    db: AsyncSession,
    redis_service: RedisService,
    recording_agent=None,
    farcaster_spaces=None,
):
    """Handle LiveKit room auto-close (empty_timeout reached)."""
    room_name = event.room.name

    # Fetch room before updating so end-of-room cleanup can use it
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

    # Auto-stop any active native recording so the file is saved even when
    # the space ends on Farcaster's side without the host pressing Stop.
    if (
        room is not None
        and room.recording
        and room.recording_id
        and recording_agent
        and farcaster_spaces
    ):
        livekit_svc = LiveKitService()
        try:
            from app.services.room_service import RoomService

            rs = RoomService(
                db,
                redis_service,
                livekit_svc,
                farcaster_spaces=farcaster_spaces,
                recording_agent=recording_agent,
            )
            await rs.admin_stop_native_recording(
                str(room.id), admin_fid=SYSTEM_ACTOR_FID
            )
            logger.info(
                "Auto-stopped native recording for room %s on room_finished",
                room_name,
            )
        except Exception as exc:
            logger.warning(
                "Auto-stop native recording failed for room %s: %s", room_name, exc
            )
        finally:
            await livekit_svc.close()

    # Drop the room's announcement cast from the global room-reply webhook.
    if room is not None and room.cast_hash:
        schedule_room_reply_sync(redis_service.redis)

    await redis_service.clear_room_state(room_name)

    await redis_service.publish_room_event(room_name, {"type": "room_ended"})
    await redis_service.publish_room_discovery_event(
        {
            "type": "rooms_changed",
            "reason": "room_ended",
            "room_id": room_name,
            "status": "ended",
        }
    )

    if room is not None and room.created_by_app_id is not None:
        await dispatch_dev_webhook(
            db,
            app_id=room.created_by_app_id,
            event_type="room.finished",
            data={
                "room_id": room_name,
                "host_fid": room.host_fid,
                "started_at": room.started_at.isoformat() if room.started_at else None,
                "ended_at": datetime.now(timezone.utc).isoformat(),
            },
        )


async def _handle_egress_ended(event, db: AsyncSession, redis_service: RedisService):
    """Store recording URL when egress completes.

    Security: LiveKit webhook auth proves the payload came from LiveKit but
    does NOT prove which of our rooms owns a given egress. We therefore:
      1. Require the reported ``egress_id`` to match the one we stashed in
         Redis when we started the recording (``room:{room_id}:egress_id``).
         A mismatch or missing Redis entry means we never started this
         egress (or it was rotated) — refuse to record the URL.
      2. Validate ``file_url`` host+scheme against our configured storage
         (``extract_recording_s3_key``) so a spoofed webhook can't convince
         us to save an attacker-controlled URL that we'd later serve as a
         signed recording. A URL we can't trust is dropped with a warning.
    """
    egress_info = getattr(event, "egress_info", None)
    if not egress_info:
        return

    room_name = getattr(egress_info, "room_name", None)
    if not room_name:
        return

    egress_id = getattr(egress_info, "egress_id", None)
    if not egress_id:
        logger.warning(
            "egress_ended for room %s missing egress_id — refusing to write recording_url",
            room_name,
        )
        return

    expected_egress_id = await redis_service.redis.get(f"room:{room_name}:egress_id")
    if not expected_egress_id or expected_egress_id != egress_id:
        # Security event — the egress_id in the webhook doesn't match the
        # one we stashed when we kicked off the recording. Either a stale
        # worker, a LiveKit bug, or a forged/replayed webhook body.
        logger.warning(
            "Rejecting egress_ended for room=%s: egress_id mismatch "
            "(expected=%s, got=%s)",
            room_name,
            (expected_egress_id[:8] + "...") if expected_egress_id else None,
            (egress_id[:8] + "...") if egress_id else None,
        )
        return

    file_url = None
    for result in getattr(egress_info, "file_results", []):
        location = getattr(result, "location", None)
        if location:
            file_url = location
            break

    if not file_url:
        return

    # Validate the file URL belongs to our configured storage before
    # persisting it. Dropping the URL is safer than trusting a webhook
    # payload we couldn't verify.
    recording_key = extract_recording_s3_key(file_url)
    if not recording_key:
        logger.warning(
            "Rejecting egress_ended for room=%s: file_url failed storage "
            "host/key validation",
            room_name,
        )
        return

    await db.execute(
        update(Room)
        .where(Room.id == room_name)
        .values(
            recording_url=file_url,
            recording_key=recording_key,
            recording=False,
        )
    )

    # Insert a per-segment row in `recordings` so re-recording the
    # same space doesn't overwrite the prior segment. The rooms
    # columns above still get updated (always pointing at the latest
    # segment) for backward compat with older clients. Bounds come
    # from the parent room; egress doesn't surface per-segment start/
    # end timestamps separately.
    room_row = (
        await db.execute(select(Room).where(Room.id == room_name))
    ).scalar_one_or_none()
    if room_row is not None:
        started_at = room_row.started_at
        ended_at = room_row.ended_at
        duration = None
        if started_at and ended_at:
            duration = max(0, int((ended_at - started_at).total_seconds()))
        db.add(
            Recording(
                room_id=room_row.id,
                source="egress",
                recording_url=file_url,
                s3_key=recording_key,
                started_at=started_at,
                ended_at=ended_at,
                duration_seconds=duration,
                upstream_recording_id=egress_id,
            )
        )

    await db.commit()

    # Clear the stashed egress_id now that we've recorded a successful
    # finalization — prevents a replayed webhook from re-writing the URL.
    try:
        await redis_service.redis.delete(f"room:{room_name}:egress_id")
    except Exception:
        logger.warning(
            "Failed to clear egress_id Redis key for room %s after egress_ended",
            room_name,
        )

    # Notify any still-connected participants that the recording is fully
    # finalized so their UI can clear the REC badge. Best-effort; room may
    # already have been torn down by this point.
    livekit = LiveKitService()
    try:
        payload = json.dumps({"type": "recording_state", "recording": False}).encode()
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

    # Dispatch ``recording.ready`` to outbound dev webhooks with a fresh
    # presigned URL (the stored ``recording_url`` is presign-friendly via
    # ``recording_key``; we generate a short-lived URL the developer can
    # fetch immediately rather than handing them a raw S3 path).
    room = await _load_room_for_dev_webhook(db, room_name)
    if room is not None and room.created_by_app_id is not None:
        presigned_url: str | None = file_url
        try:
            storage = StorageService()
            presigned_url = storage.generate_presigned_get_url(recording_key)
        except Exception:
            logger.warning(
                "Failed to presign recording_url for dev webhook (room=%s); "
                "falling back to stored URL",
                room_name,
            )
        duration_seconds: int | None = None
        if room.started_at is not None:
            duration_seconds = int(
                (datetime.now(timezone.utc) - room.started_at).total_seconds()
            )
        await dispatch_dev_webhook(
            db,
            app_id=room.created_by_app_id,
            event_type="recording.ready",
            data={
                "room_id": room_name,
                "recording_url": presigned_url,
                "duration_seconds": duration_seconds,
            },
        )


def _require_hypersnap_configured(accepted_secrets: list[str]) -> None:
    """Fail closed: 503 when no secret is configured."""
    if not accepted_secrets:
        logger.error("Hypersnap webhook secret not configured; rejecting delivery")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook receiver not configured",
        )


async def _reject_auth_failure(redis, *, route: str, client_ip: str) -> NoReturn:
    """Count the failed authentication, then answer 401."""
    await record_auth_failure(redis, route=route, client_ip=client_ip)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid webhook signature",
    )


def _parse_json_object(body: bytes) -> dict:
    try:
        payload = json.loads(body)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON body"
        ) from None
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON body"
        )
    return payload


@router.post("/hypersnap")
async def hypersnap_room_reply_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Replies to live rooms' announcement casts (global room-reply webhook).

    Broadcasts ``new_reply`` over the room's LiveKit data channel so clients
    refresh the space chat. Deliveries are de-duplicated on the cast hash in
    their own namespace, so a reply that is also delivered to the
    notifications route is not suppressed there.
    """
    route = ROUTE_HYPERSNAP_ROOM_REPLY
    accepted_secrets = ROOM_REPLY_WEBHOOK.secrets()
    _require_hypersnap_configured(accepted_secrets)
    client_ip = await _guard_unauthenticated(
        request, redis, route=route, limit=HYPERSNAP_RATE_LIMIT
    )
    body = await read_capped_body(request)
    signature = request.headers.get(HYPERSNAP_SIGNATURE_HEADER, "")
    if not verify_delivery_signature(body, signature, accepted_secrets):
        await _reject_auth_failure(redis, route=route, client_ip=client_ip)

    payload = _parse_json_object(body)
    if payload.get("type") != EVENT_CAST_CREATED:
        return {"status": "ok"}
    data = payload.get("data")
    if not isinstance(data, dict):
        return {"status": "ok"}
    parent_hash = normalize_cast_hash(cast_of(data).get("parent_hash"))
    if parent_hash is None:
        return {"status": "ok"}

    # Stored hashes may predate normalization: match with and without 0x.
    result = await db.execute(
        select(Room).where(
            Room.cast_hash.in_([parent_hash, parent_hash.removeprefix("0x")]),
            Room.status == "active",
        )
    )
    room = result.scalars().first()
    if room is None:
        return {"status": "ok"}

    # Marked seen only once we know we'll act on it, so a failed lookup above
    # (5xx, Hypersnap retries) isn't recorded as handled.
    key = dedupe_key(EVENT_CAST_CREATED, data)
    if key and not await redis.set(
        f"{ROOM_REPLY_SEEN_KEY_PREFIX}{key}",
        "1",
        nx=True,
        ex=WEBHOOK_SEEN_TTL_SECONDS,
    ):
        return {"status": "duplicate"}

    room_id = str(room.id)
    livekit = LiveKitService()
    try:
        message = json.dumps(
            {"type": "new_reply", "cast_hash": room.cast_hash}
        ).encode()
        await livekit.send_data(room_id, message, topic="space_chat")
    except Exception as e:
        logger.warning("Failed to broadcast new_reply to room %s: %s", room_id, e)
    finally:
        await livekit.close()

    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Farcaster miniapp webhook (forwarded from Next.js at juke.audio/api/webhook)
# ---------------------------------------------------------------------------


MINIAPP_EVENTS_ENABLE = frozenset({"miniapp_added", "notifications_enabled"})
MINIAPP_EVENTS_DISABLE = frozenset({"miniapp_removed", "notifications_disabled"})
MAX_NOTIFICATION_TOKEN_CHARS = 1024
MAX_NOTIFICATION_URL_CHARS = 2048

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
        return (
            parsed.scheme == "https" and parsed.hostname in ALLOWED_NOTIFICATION_HOSTS
        )
    except Exception:
        return False


def _has_valid_proxy_secret(request: Request) -> bool:
    """Constant-time check of the juke.audio proxy's shared secret."""
    expected = settings.MINIAPP_WEBHOOK_SECRET
    if not expected:
        return False
    provided = request.headers.get("x-webhook-secret", "")
    return hmac.compare_digest(provided.encode(), expected.encode())


def _forwarded_sender_ip(request: Request) -> str | None:
    """End-sender IP reported by the juke.audio proxy, if well-formed.

    Only meaningful after the proxy secret has been verified; the proxy sets
    it from Vercel's edge-assigned client address.
    """
    raw = request.headers.get(MINIAPP_SENDER_IP_HEADER, "").strip()
    if not raw:
        return None
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return None


def _notification_details(payload: dict) -> tuple[str, str] | None:
    """``(url, token)`` from a JFS event payload, when present and acceptable."""
    details = payload.get("notificationDetails")
    if not isinstance(details, dict):
        return None
    url, token = details.get("url"), details.get("token")
    if not isinstance(url, str) or not isinstance(token, str) or not token:
        return None
    if len(url) > MAX_NOTIFICATION_URL_CHARS:
        return None
    if len(token) > MAX_NOTIFICATION_TOKEN_CHARS:
        return None
    if not _validate_notification_url(url):
        return None
    return url, token


@router.post("/miniapp")
async def miniapp_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Handle Farcaster Mini App server events forwarded by juke.audio.

    The Next.js route at ``juke.audio/api/webhook`` forwards the client's raw
    JFS envelope ``{header, payload, signature}`` with the shared
    ``X-Webhook-Secret``. The secret only proves the request came through our
    proxy; the FID is trusted only after the Ed25519 signature verifies under
    ``header.key`` and that key is an active app key of ``header.fid``.
    """
    # Every legitimate request arrives from the proxy's egress IP, so only
    # proxy-secret failures are budgeted against it; envelope failures are
    # budgeted against the end sender the proxy reports (below). Otherwise any
    # internet user could exhaust a shared budget and lock out every client.
    proxy_ip = _client_ip(request)
    await ensure_auth_failure_budget(
        redis, route=ROUTE_MINIAPP_PROXY, client_ip=proxy_ip
    )
    # Checked before the body is read or parsed.
    if not _has_valid_proxy_secret(request):
        await record_auth_failure(redis, route=ROUTE_MINIAPP_PROXY, client_ip=proxy_ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook secret",
        )

    route = ROUTE_MINIAPP
    client_ip = _forwarded_sender_ip(request) or proxy_ip
    await enforce_ip_rate_limit(
        redis,
        route=route,
        client_ip=client_ip,
        limit=MINIAPP_RATE_LIMIT,
        window_seconds=RATE_LIMIT_WINDOW_SECONDS,
    )
    await ensure_auth_failure_budget(redis, route=route, client_ip=client_ip)

    body = await read_capped_body(request)
    try:
        envelope = JfsEnvelope.model_validate_json(body)
    except ValidationError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid signature envelope",
        ) from None

    try:
        verified = verify_jfs_signature(envelope)
    except JfsVerificationError as exc:
        logger.info("Rejected miniapp webhook: %s", exc)
        await _reject_auth_failure(redis, route=route, client_ip=client_ip)

    try:
        key_is_active = await is_app_key_active_for_fid(verified.fid, verified.key)
    except HypersnapError as exc:
        logger.warning("Miniapp webhook app-key lookup failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to verify app key",
        ) from None
    if not key_is_active:
        logger.info("Rejected miniapp webhook: key is not an active app key of fid")
        await _reject_auth_failure(redis, route=route, client_ip=client_ip)

    fid = verified.fid
    event = verified.payload.get("event")
    if event in MINIAPP_EVENTS_ENABLE:
        details = _notification_details(verified.payload)
        if details is None:
            return {"status": "ok"}
        notification_url, notification_token = details
        result = await db.execute(
            select(MiniAppNotification).where(MiniAppNotification.fid == fid)
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.notification_url = notification_url
            existing.notification_token = notification_token
            existing.is_active = True
        else:
            db.add(
                MiniAppNotification(
                    fid=fid,
                    notification_url=notification_url,
                    notification_token=notification_token,
                    is_active=True,
                )
            )
        await db.commit()
    elif event in MINIAPP_EVENTS_DISABLE:
        await db.execute(
            update(MiniAppNotification)
            .where(MiniAppNotification.fid == fid)
            .values(is_active=False)
        )
        await db.commit()

    return {"status": "ok"}


@router.post("/hypersnap/notifications")
async def hypersnap_notification_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Push-notification events (replies, mentions, reactions, follows).

    Several webhooks share this route, each with its own secret. The HMAC is
    checked over the raw body before parsing; the event type it implies must
    match the body's ``type`` (cross-event replay defense). Deliveries are
    at-least-once, so events are de-duplicated on their natural key.
    """
    route = ROUTE_HYPERSNAP_NOTIFICATIONS
    configured = [
        (event, accepted) for event, accepted in secrets_by_event_type() if accepted
    ]
    _require_hypersnap_configured(
        [secret for _, accepted in configured for secret in accepted]
    )
    client_ip = await _guard_unauthenticated(
        request, redis, route=route, limit=HYPERSNAP_RATE_LIMIT
    )
    body = await read_capped_body(request)
    signature = request.headers.get(HYPERSNAP_SIGNATURE_HEADER, "")
    # One HMAC pass per configured event type, before any parsing.
    signed_types = {
        event
        for event, accepted in configured
        if verify_delivery_signature(body, signature, accepted)
    }
    if not signed_types:
        await _reject_auth_failure(redis, route=route, client_ip=client_ip)
    payload = _parse_json_object(body)
    event_type = payload.get("type", "")
    if event_type not in signed_types:
        await _reject_auth_failure(redis, route=route, client_ip=client_ip)

    data = payload.get("data")
    key = dedupe_key(event_type, data) if isinstance(data, dict) else None
    seen_key = f"{WEBHOOK_SEEN_KEY_PREFIX}{key}" if key else None
    if seen_key and not await redis.set(
        seen_key, "1", nx=True, ex=WEBHOOK_SEEN_TTL_SECONDS
    ):
        return {"status": "duplicate"}

    from app.services.push_service import PushService

    try:
        push_payload = await to_push_payload(event_type, payload)
        if push_payload is None:
            return {"status": "ok"}
        await PushService(db, redis).handle_notification_event(event_type, push_payload)
    except Exception:
        # Let Hypersnap retry (5xx) rather than dropping the event as seen.
        if seen_key:
            await redis.delete(seen_key)
        raise

    return {"status": "ok"}
