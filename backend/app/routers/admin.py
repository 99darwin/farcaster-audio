"""
Admin router — privileged endpoints for room and participant management.

Endpoints:
  GET    /v1/admin/rooms                              List all active rooms
  DELETE /v1/admin/rooms/{room_id}                    Force-end any room
  DELETE /v1/admin/rooms/{room_id}/participants/{fid}  Force-kick participant
  POST   /v1/admin/setup-webhooks                     Provision Hypersnap webhooks
  POST   /v1/admin/recordings/cleanup                 Run recording retention cleanup
  POST   /v1/admin/rooms/{room_id}/recording/stop     Force-stop a native recording agent
"""

import hmac
import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.clients.hypersnap_webhooks import (
    HypersnapWebhookClient,
    HypersnapWebhookConfigError,
    app_webhook_signer,
    parse_secrets,
)
from app.config import settings
from app.dependencies import get_db, get_redis
from app.middleware.auth import get_admin_user
from app.schemas.common import StatusResponse
from app.schemas.push import RoomLiveNotifyRequest, RoomLiveNotifyResponse
from app.schemas.room import RoomListResponse
from app.services.hypersnap_webhook_service import (
    WebhookCapacityError,
    ensure_webhooks,
    push_room_reply_hashes,
    sync_push_webhooks,
)
from app.services.livekit_service import LiveKitService
from app.services.push_service import REDIS_ACTIVE_FIDS_KEY, PushService
from app.services.recording_cleanup import cleanup_expired_recordings
from app.services.redis_service import RedisService
from app.services.room_service import RoomService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/admin", tags=["admin"])


async def get_room_service(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    redis_service = RedisService(redis)
    livekit_service = LiveKitService()
    farcaster_spaces = getattr(request.app.state, "farcaster_spaces_service", None)
    recording_agent = getattr(request.app.state, "recording_agent_service", None)
    try:
        yield RoomService(
            db,
            redis_service,
            livekit_service,
            farcaster_spaces=farcaster_spaces,
            recording_agent=recording_agent,
        )
    finally:
        await livekit_service.close()


def get_push_service(
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> PushService:
    return PushService(db, redis)


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


@router.post("/rooms/{room_id}/notify-live", response_model=RoomLiveNotifyResponse)
async def notify_live_room(
    room_id: str,
    body: RoomLiveNotifyRequest,
    _admin_fid: int = Depends(get_admin_user),
    push_service: PushService = Depends(get_push_service),
) -> RoomLiveNotifyResponse:
    """Send or dry-run an admin go-live push campaign for an active room."""
    return await push_service.admin_notify_room_live(
        room_id=room_id,
        target=body.target,
        dry_run=body.dry_run,
    )


@router.post("/setup-webhooks")
async def setup_push_webhooks(
    _admin_fid: int = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Provision Juke's Hypersnap webhooks on the app FID (idempotent).

    Creates any missing webhook (room replies + enough push shards for the
    active FIDs), repoints existing ones at ``API_BASE_URL``, then syncs their
    filters. Re-run whenever the push-capacity warning is logged.

    Signing secrets are NOT returned. Each webhook reports
    ``secret_configured`` (whether its current secret is already in the
    matching ``HYPERSNAP_WEBHOOK_SECRET_*`` setting); when any is false, ops
    reads the values out-of-band with
    ``python -m scripts.print_hypersnap_webhook_secrets``.
    """
    try:
        client = HypersnapWebhookClient(app_webhook_signer())
        fids = [int(fid) for fid in await redis.smembers(REDIS_ACTIVE_FIDS_KEY)]
        results = await ensure_webhooks(client, push_fid_count=len(set(fids)))
        await push_room_reply_hashes(db, client)
        await sync_push_webhooks(fids, client)
    except HypersnapWebhookConfigError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from None
    except WebhookCapacityError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from None
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="setup-webhooks")

    return {"webhooks": [_redact_webhook_result(r) for r in results]}


def _redact_webhook_result(result: dict) -> dict:
    """Drop the signing secret; report only whether it's already deployed."""
    secret = result.get("secret")
    configured = parse_secrets(getattr(settings, result["secret_var"], "") or "")
    redacted = {key: value for key, value in result.items() if key != "secret"}
    redacted["secret_configured"] = bool(secret) and secret in configured
    return redacted


# ---------------------------------------------------------------------------
# Recording retention cleanup
# ---------------------------------------------------------------------------


def _verify_admin_secret(request: Request) -> None:
    """Gate ops endpoints called by external schedulers via shared secret.

    Sent as ``X-Admin-Secret: <ADMIN_SECRET>``. We require the secret to be
    configured (not empty) so a missing env var can't silently grant access,
    and use a constant-time comparison to prevent timing side-channels.

    NOTE: ``X-Admin-Secret`` is a privileged header — add it to the scrub
    allowlist in Sentry / OpenTelemetry config so it never appears in traces
    or breadcrumbs. See ``sentry_sdk.init(send_default_pii=False)`` + any
    custom ``before_send`` redaction hook.

    TODO(ops): Consider a Railway-level IP allowlist for ``/v1/admin/*`` so
    the shared secret is defense-in-depth rather than the sole gate.
    """
    # Fail closed: if the secret is unset we refuse every request. We do this
    # BEFORE the compare so a misconfigured env can't silently grant access.
    if not settings.ADMIN_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin secret",
        )

    provided = request.headers.get("x-admin-secret", "")
    if not hmac.compare_digest(provided or "", settings.ADMIN_SECRET or ""):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin secret",
        )


@router.post("/recordings/cleanup")
async def admin_cleanup_recordings(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete recording files + clear URLs past the retention window.

    Protected by the ``X-Admin-Secret`` header so Railway scheduled jobs
    can trigger it daily without a user JWT. Returns counts for verification.
    """
    _verify_admin_secret(request)
    return await cleanup_expired_recordings(db)


@router.post("/rooms/{room_id}/recording/stop", response_model=StatusResponse)
async def admin_stop_recording(
    room_id: str,
    admin_fid: int = Depends(get_admin_user),
    room_service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Force-stop a native recording-agent worker without host permission
    checks.  Use this when the host's space ended on Farcaster's side
    before they pressed Stop, leaving a recording worker running.
    """
    result = await room_service.admin_stop_native_recording(room_id, admin_fid)
    return StatusResponse(status=result.get("status", "stopped"))
