import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients.hypersnap import HypersnapError
from app.config import settings
from app.dependencies import (
    get_db,
    get_redis,
    require_developer_api_key,
    require_recent_siwn,
)
from app.middleware.auth import (
    get_admin_user,
    get_current_user,
    require_first_party_user,
)
from app.models.developer import DeveloperApiKey, DeveloperApp, DeveloperApplication
from app.models.developer_app_bot import DeveloperAppBot
from app.models.user import User
from app.schemas.common import StatusResponse
from app.schemas.developer import (
    DeveloperAccessUpdate,
    DeveloperAppCreate,
    DeveloperAppListResponse,
    DeveloperAppResponse,
    DeveloperAppUpdate,
    DeveloperApplicationResponse,
    DeveloperBotCreate,
    DeveloperBotListResponse,
    DeveloperBotResponse,
    DeveloperKeyCreate,
    DeveloperKeyListResponse,
    DeveloperKeyResponse,
    DeveloperKeyRevealRequest,
    DeveloperKeyRevealResponse,
    DeveloperApplicationRequest,
    DeveloperSpaceCreate,
    DeveloperSpaceEndRequest,
    DeveloperSpaceStartRequest,
    DeveloperStatusResponse,
    DeveloperUserListResponse,
    DeveloperUserResponse,
    DeveloperWebhookCreate,
    DeveloperWebhookCreateResponse,
    DeveloperWebhookListResponse,
    DeveloperWebhookResponse,
    NativeAgentJoinResponse,
    PartnerAgentJoinRequest,
    PartnerTokenCreate,
    PartnerTokenResponse,
)
from app.models.developer_webhook import DeveloperWebhook
from app.models.room import Room
from app.schemas.agent import AgentJoinRequest, AgentJoinResponse
from app.schemas.farcaster_spaces import FarcasterSpacesConfigError
from app.services.auth_service import create_partner_jwt
from app.services.dev_webhook_service import encrypt_secret as encrypt_webhook_secret
from app.services.dev_webhook_service import generate_secret as generate_webhook_secret
from app.services.dev_webhook_service import (
    public_delivery_outcome as public_webhook_outcome,
)
from app.services.dev_webhook_service import (
    public_error_category as public_webhook_error,
)
from app.services.signer_crypto import SignerKeyConfigError
from app.services.farcaster_spaces_service import FarcasterSpacesService
from app.services.session_service import SessionService
from app.schemas.room import RoomCreateResponse, RoomDetailResponse, RoomResponse
from app.schemas.participant import ParticipantResponse
from app.services.jfs import decode_jfs_bearer
from app.services.bot_signer_service import (
    AUTH_MODE_APP_KEY,
    BotSignerConfigError,
    BotSignerCryptoError,
    BotSignerNotReady,
    provision_bot_signer,
    refresh_bot_signer_status,
)
from app.services.developer_key_service import (
    VerifiedDeveloperKey,
    clear_expired_reveal_blob,
    create_api_key,
    get_owned_app,
    require_approved_developer,
    reveal_api_key_once,
)
from app.services.dev_webhook_service import dispatch as dispatch_dev_webhook
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService
from app.services.room_service import SYSTEM_ACTOR_FID, RoomService

router = APIRouter(prefix="/v1/developer", tags=["developer"])

logger = logging.getLogger(__name__)

MIN_SCHEDULE_AHEAD = timedelta(minutes=5)
MAX_SCHEDULE_AHEAD = timedelta(days=30)

# Per-fid resource caps. Both values enforced in the create paths and return
# a 409 with a clear message — they aren't a security limit so much as a
# guardrail against runaway resource creation by a single account.
MAX_APPS_PER_FID = 25
MAX_ACTIVE_KEYS_PER_APP = 20

# Rate limit windows. Mirrors the per-IP pattern in routers/auth.py but
# scoped per authenticated fid (or per key_id for key-authed routes).
_APPLICATION_RATE_LIMIT = 3
_APPLICATION_RATE_WINDOW = 24 * 60 * 60
_MUTATION_RATE_LIMIT = 20
_MUTATION_RATE_WINDOW = 60 * 60
_DEVELOPER_SPACES_RATE_LIMIT = 60
_DEVELOPER_SPACES_RATE_WINDOW = 60
# Partner SSO tokens are minted per-visitor per-pageview but each mint is
# an oracle ("this fid is real, here's a working JWT for it"). Cap at
# 60/min/key — same as space creation — so a leaked key can't enumerate
# the Farcaster fid space at scale before rotation. A second-tier daily
# ceiling guards against slow-drip abuse over hours.
_PARTNER_TOKEN_RATE_LIMIT = 60
_PARTNER_TOKEN_RATE_WINDOW = 60
_PARTNER_TOKEN_DAILY_LIMIT = 5000
_PARTNER_TOKEN_DAILY_WINDOW = 24 * 60 * 60
# Partner agent-join generates a long-lived audio session, so the per-key
# budget is much tighter than space creation or token mints. ZOE-class
# bots typically join once per scheduled space; 10/min handles burst
# rejoin storms after a transient disconnect, and 100/day keeps a leaked
# key from spinning up an unbounded swarm.
_PARTNER_AGENT_JOIN_RATE_LIMIT = 10
_PARTNER_AGENT_JOIN_RATE_WINDOW = 60
_PARTNER_AGENT_JOIN_DAILY_LIMIT = 100
_PARTNER_AGENT_JOIN_DAILY_WINDOW = 24 * 60 * 60
# Read endpoints (GET /spaces/{id}, GET /webhooks/{id}) need a budget so
# a leaked key can't be used for unbounded polling against the calling
# app's own rooms (the ownership filter caps enumeration value but
# doesn't bound RPS / PII exfiltration of live participant lists).
_DEVELOPER_READ_RATE_LIMIT = 120
_DEVELOPER_READ_RATE_WINDOW = 60
# Bot-registry management endpoints. Bots are registered manually by
# humans operating the developer dashboard or a one-off script — the
# expected rate is "a few per developer-onboarding flow". 10/min/app
# is generous for legitimate use, tight enough to make automated abuse
# (e.g. registering thousands of bots under a leaked key) infeasible.
_DEVELOPER_BOTS_RATE_LIMIT = 10
_DEVELOPER_BOTS_RATE_WINDOW = 60
# Per-app cap on registered bots. Same shape as ``_MAX_WEBHOOKS_PER_APP``
# — a runaway-creation guardrail, not a security boundary.
_MAX_BOTS_PER_APP = 50


async def _enforce_rate_limit(
    redis,
    *,
    key: str,
    limit: int,
    window_seconds: int,
    response: "Response | None" = None,
) -> None:
    """Raise HTTP 429 with Retry-After if `key` exceeds `limit` in `window_seconds`.

    When ``response`` is provided, also sets advisory
    ``X-Juke-Rate-Limit-Limit`` / ``-Remaining`` / ``-Reset`` headers
    on every successful pass so integrators can back off proactively
    before hitting 429.
    """
    service = RedisService(redis)
    allowed, retry_after, remaining, reset_in = await service.check_rate_limit_status(
        key, limit, window_seconds
    )
    if response is not None:
        response.headers["X-Juke-Rate-Limit-Limit"] = str(limit)
        response.headers["X-Juke-Rate-Limit-Remaining"] = str(remaining)
        response.headers["X-Juke-Rate-Limit-Reset"] = str(reset_in)
    if allowed:
        return
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Rate limit exceeded. Try again later.",
        headers={
            "Retry-After": str(retry_after),
            "X-Juke-Rate-Limit-Limit": str(limit),
            "X-Juke-Rate-Limit-Remaining": "0",
            "X-Juke-Rate-Limit-Reset": str(reset_in),
        },
    )


async def get_developer_room_service(
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    redis_service = RedisService(redis)
    livekit_service = LiveKitService()
    try:
        yield RoomService(db, redis_service, livekit_service)
    finally:
        await livekit_service.close()


def _farcaster_spaces_service(request: Request) -> FarcasterSpacesService:
    """Return the per-process shared FarcasterSpacesService.

    Same fallback pattern as ``routers/spaces_discovery.py``: the
    service is constructed eagerly at lifespan startup so the bearer
    cache + httpx client are a single singleton. Tests using
    ASGITransport without the startup hook get a fresh instance.
    """
    svc = getattr(request.app.state, "farcaster_spaces_service", None)
    if svc is None:
        svc = FarcasterSpacesService(settings)
        request.app.state.farcaster_spaces_service = svc
    return svc


def _bot_is_ready(bot: DeveloperAppBot) -> bool:
    """Single readiness gate exposed to the dashboard/client.

    A legacy ``custody_env`` bot is usable the moment it's registered
    (the developer already holds the custody secret). A managed
    ``app_key`` bot is only usable once its Ed25519 signer has been
    approved by the bot FID owner on Warpcast.
    """
    if bot.auth_mode == AUTH_MODE_APP_KEY:
        return bot.signer_status == "approved"
    return True


def _bot_response(bot: DeveloperAppBot) -> DeveloperBotResponse:
    # ``approval_url`` is only meaningful while the signer is awaiting
    # approval; surfacing it after approval/revocation would present a
    # stale link. It never carries key material (public deep link only).
    approval_url = (
        bot.signer_approval_url if bot.signer_status == "pending_approval" else None
    )
    return DeveloperBotResponse(
        id=bot.id,
        fid=bot.fid,
        label=bot.label,
        is_active=bot.is_active,
        auth_mode=bot.auth_mode,
        signer_status=bot.signer_status,
        signer_public_key=bot.signer_public_key,
        approval_url=approval_url,
        ready=_bot_is_ready(bot),
    )


def _key_response(
    key: DeveloperApiKey,
    *,
    public_key: str | None = None,
    secret_key: str | None = None,
    reveal_token: str | None = None,
) -> DeveloperKeyResponse:
    return DeveloperKeyResponse(
        app_id=key.app_id,
        key_id=key.key_id,
        name=key.name,
        public_key=public_key,
        secret_key=secret_key,
        reveal_token=reveal_token,
        reveal_expires_at=key.reveal_expires_at,
        revealed_at=key.revealed_at,
        last_used_at=key.last_used_at,
        revoked_at=key.revoked_at,
        rotated_from_key_id=key.rotated_from_key_id,
        created_at=key.created_at,
    )


async def _latest_application(
    db: AsyncSession, fid: int
) -> DeveloperApplication | None:
    result = await db.execute(
        select(DeveloperApplication)
        .where(DeveloperApplication.fid == fid)
        .order_by(DeveloperApplication.created_at.desc())
    )
    return result.scalars().first()


def _application_response(
    application: DeveloperApplication | None,
) -> DeveloperApplicationResponse | None:
    if application is None:
        return None
    return DeveloperApplicationResponse.model_validate(application)


def _developer_user_response(
    user: User,
    application: DeveloperApplication | None = None,
) -> DeveloperUserResponse:
    return DeveloperUserResponse(
        fid=user.fid,
        username=user.username,
        display_name=user.display_name,
        developer_access_status=user.developer_access_status,
        application=_application_response(application),
    )


def _parse_scheduled_at(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        scheduled_at = datetime.fromisoformat(value)
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
    return scheduled_at


@router.get("/status", response_model=DeveloperStatusResponse)
async def developer_status(
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperStatusResponse:
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    return DeveloperStatusResponse(
        developer_access_status=(
            user.developer_access_status if user is not None else "none"
        ),
        application=_application_response(
            await _latest_application(db, fid) if user is not None else None
        ),
    )


@router.post("/application", response_model=DeveloperStatusResponse)
async def request_developer_access(
    body: DeveloperApplicationRequest,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperStatusResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_application_rate:{fid}",
        limit=_APPLICATION_RATE_LIMIT,
        window_seconds=_APPLICATION_RATE_WINDOW,
    )
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found.",
        )
    if user.developer_access_status == "suspended":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Developer access is suspended.",
        )
    # New applications are always "pending". Previously, an already-approved
    # developer's resubmission was auto-approved, which let a compromised
    # account silently update their on-file project metadata without any
    # admin oversight. Approval status on the User row is left untouched.
    application = DeveloperApplication(
        fid=fid,
        project_name=body.project_name,
        website_url=body.website_url,
        use_case=body.use_case,
        status="pending",
    )
    db.add(application)
    if user.developer_access_status in ("none", "pending"):
        user.developer_access_status = "pending"
    await db.commit()
    await db.refresh(user)
    await db.refresh(application)
    return DeveloperStatusResponse(
        developer_access_status=user.developer_access_status,
        application=_application_response(application),
    )


@router.get("/apps", response_model=DeveloperAppListResponse)
async def list_apps(
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperAppListResponse:
    await require_approved_developer(db, fid)
    result = await db.execute(
        select(DeveloperApp)
        .where(DeveloperApp.owner_fid == fid, DeveloperApp.status != "deleted")
        .order_by(DeveloperApp.created_at.desc())
    )
    return DeveloperAppListResponse(apps=list(result.scalars().all()))


@router.post(
    "/apps",
    response_model=DeveloperAppResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_app(
    body: DeveloperAppCreate,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperApp:
    await _enforce_rate_limit(
        redis,
        key=f"developer_create_app_rate:{fid}",
        limit=_MUTATION_RATE_LIMIT,
        window_seconds=_MUTATION_RATE_WINDOW,
    )
    await require_approved_developer(db, fid)
    count_result = await db.execute(
        select(func.count())
        .select_from(DeveloperApp)
        .where(
            DeveloperApp.owner_fid == fid,
            DeveloperApp.status != "deleted",
        )
    )
    existing_apps = count_result.scalar_one() or 0
    if existing_apps >= MAX_APPS_PER_FID:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Per-developer app limit reached ({MAX_APPS_PER_FID}). "
                "Delete unused apps before creating another."
            ),
        )
    app = DeveloperApp(
        owner_fid=fid,
        name=body.name,
        description=body.description,
        website_url=body.website_url,
        allowed_origins=body.allowed_origins,
    )
    db.add(app)
    await db.commit()
    await db.refresh(app)
    return app


@router.get("/apps/{app_id}", response_model=DeveloperAppResponse)
async def get_app(
    app_id: UUID,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperApp:
    await require_approved_developer(db, fid)
    return await get_owned_app(db, fid, app_id)


@router.patch("/apps/{app_id}", response_model=DeveloperAppResponse)
async def update_app(
    app_id: UUID,
    body: DeveloperAppUpdate,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperApp:
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    if body.name is not None:
        app.name = body.name
    if body.description is not None:
        app.description = body.description
    if body.website_url is not None:
        app.website_url = body.website_url
    if body.allowed_origins is not None:
        app.allowed_origins = body.allowed_origins
    await db.commit()
    await db.refresh(app)
    return app


@router.delete("/apps/{app_id}", response_model=StatusResponse)
async def delete_app(
    app_id: UUID,
    fid: int = Depends(require_recent_siwn),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    app.status = "deleted"
    await db.commit()
    return StatusResponse(status="deleted")


@router.get("/apps/{app_id}/keys", response_model=DeveloperKeyListResponse)
async def list_keys(
    app_id: UUID,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperKeyListResponse:
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    result = await db.execute(
        select(DeveloperApiKey)
        .where(DeveloperApiKey.app_id == app.id)
        .order_by(DeveloperApiKey.created_at.desc())
    )
    return DeveloperKeyListResponse(keys=[_key_response(k) for k in result.scalars()])


@router.get("/apps/{app_id}/bots", response_model=DeveloperBotListResponse)
async def list_app_bots(
    app_id: UUID,
    response: Response,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperBotListResponse:
    """JWT-authed read-only mirror of ``GET /v1/developer/bots`` for the
    first-party developer dashboard, which authenticates with a SIWN JWT
    and never holds an API key.

    Owner-scoped via ``get_owned_app`` (cross-app / unknown app id → 404,
    same convention as ``GET /apps/{app_id}/keys``). Served straight from
    the DB — no Neynar calls — so the dashboard's ~15s poll while a signer
    is pending never fans out upstream traffic (the API-key
    ``GET /bots/{id}`` poll is where the lazy Neynar reconcile lives).
    """
    await _enforce_rate_limit(
        redis,
        key=f"developer_bots_read_rate:fid:{fid}",
        limit=_DEVELOPER_READ_RATE_LIMIT,
        window_seconds=_DEVELOPER_READ_RATE_WINDOW,
        response=response,
    )
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    result = await db.execute(
        select(DeveloperAppBot)
        .where(DeveloperAppBot.app_id == app.id)
        .order_by(DeveloperAppBot.created_at.desc())
    )
    return DeveloperBotListResponse(
        bots=[_bot_response(row) for row in result.scalars().all()]
    )


@router.post(
    "/apps/{app_id}/keys",
    response_model=DeveloperKeyResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_key(
    app_id: UUID,
    body: DeveloperKeyCreate,
    # Returns a live secret_key, so require a recent SIWN step-up rather
    # than any still-valid first-party session (matches reveal/rotate).
    fid: int = Depends(require_recent_siwn),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperKeyResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_create_key_rate:{fid}",
        limit=_MUTATION_RATE_LIMIT,
        window_seconds=_MUTATION_RATE_WINDOW,
    )
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    if app.status != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Developer app is not active.",
        )
    active_keys_count = await db.execute(
        select(func.count())
        .select_from(DeveloperApiKey)
        .where(
            DeveloperApiKey.app_id == app.id,
            DeveloperApiKey.revoked_at.is_(None),
        )
    )
    if (active_keys_count.scalar_one() or 0) >= MAX_ACTIVE_KEYS_PER_APP:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Active key limit reached for this app "
                f"({MAX_ACTIVE_KEYS_PER_APP}). Revoke an existing key first."
            ),
        )
    key, public_key, secret_key, reveal_token = await create_api_key(
        db, app, name=body.name
    )
    return _key_response(
        key,
        public_key=public_key,
        secret_key=secret_key,
        reveal_token=reveal_token,
    )


@router.post(
    "/apps/{app_id}/keys/{key_id}/reveal",
    response_model=DeveloperKeyRevealResponse,
)
async def reveal_key(
    app_id: UUID,
    key_id: str,
    body: DeveloperKeyRevealRequest,
    fid: int = Depends(require_recent_siwn),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperKeyRevealResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_reveal_key_rate:{fid}",
        limit=_MUTATION_RATE_LIMIT,
        window_seconds=_MUTATION_RATE_WINDOW,
    )
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    result = await db.execute(
        select(DeveloperApiKey).where(
            DeveloperApiKey.app_id == app.id,
            DeveloperApiKey.key_id == key_id,
        )
    )
    key = result.scalar_one_or_none()
    if key is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Developer API key not found.",
        )
    # Sweep before processing so a stale blob can't be revealed (the
    # service function also calls this defensively).
    await clear_expired_reveal_blob(db, key)
    secret_key = await reveal_api_key_once(db, key, reveal_token=body.reveal_token)
    return DeveloperKeyRevealResponse(
        secret_key=secret_key,
        reveal_expires_at=key.reveal_expires_at,
    )


@router.post(
    "/apps/{app_id}/keys/{key_id}/rotate",
    response_model=DeveloperKeyResponse,
    status_code=status.HTTP_201_CREATED,
)
async def rotate_key(
    app_id: UUID,
    key_id: str,
    body: DeveloperKeyCreate,
    fid: int = Depends(require_recent_siwn),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperKeyResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_rotate_key_rate:{fid}",
        limit=_MUTATION_RATE_LIMIT,
        window_seconds=_MUTATION_RATE_WINDOW,
    )
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    result = await db.execute(
        select(DeveloperApiKey).where(
            DeveloperApiKey.app_id == app.id,
            DeveloperApiKey.key_id == key_id,
        )
    )
    old_key = result.scalar_one_or_none()
    if old_key is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Developer API key not found.",
        )
    await clear_expired_reveal_blob(db, old_key)
    # Atomic rotation: revoke the old key and insert the new one in a
    # single transaction. If create_api_key fails (UNIQUE violation,
    # encryption error, etc.) the old key's revocation rolls back so we
    # don't leave the app without a valid credential.
    from app.services.developer_key_service import _now

    try:
        if old_key.revoked_at is None:
            old_key.revoked_at = _now()
            old_key.encrypted_secret_once = None
            old_key.reveal_token_hash = None
            await db.flush()
        new_key, public_key, secret_key, reveal_token = await create_api_key(
            db,
            app,
            name=body.name,
            rotated_from_key_id=old_key.key_id,
            commit=False,
        )
        await db.commit()
        await db.refresh(new_key)
        await db.refresh(old_key)
    except HTTPException:
        await db.rollback()
        raise
    except Exception:
        await db.rollback()
        raise
    return _key_response(
        new_key,
        public_key=public_key,
        secret_key=secret_key,
        reveal_token=reveal_token,
    )


@router.post("/apps/{app_id}/keys/{key_id}/revoke", response_model=DeveloperKeyResponse)
async def revoke_key(
    app_id: UUID,
    key_id: str,
    fid: int = Depends(require_recent_siwn),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperKeyResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_revoke_key_rate:{fid}",
        limit=_MUTATION_RATE_LIMIT,
        window_seconds=_MUTATION_RATE_WINDOW,
    )
    await require_approved_developer(db, fid)
    app = await get_owned_app(db, fid, app_id)
    result = await db.execute(
        select(DeveloperApiKey).where(
            DeveloperApiKey.app_id == app.id,
            DeveloperApiKey.key_id == key_id,
        )
    )
    key = result.scalar_one_or_none()
    if key is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Developer API key not found.",
        )
    await clear_expired_reveal_blob(db, key)
    if key.revoked_at is None:
        from app.services.developer_key_service import _now

        key.revoked_at = _now()
        key.encrypted_secret_once = None
        key.reveal_token_hash = None
        await db.commit()
        await db.refresh(key)
    return _key_response(key)


async def _load_room_host_user(db: AsyncSession, host_fid: int) -> User:
    """Load the ``User`` row backing ``room.host_fid``.

    Every developer native room has a host User row by construction — the
    calling app owner (bot mode) or the mirror-user upserted for the
    bearer FID (user mode). A missing row is internal-state corruption,
    surfaced as an opaque 500.
    """
    row = await db.execute(select(User).where(User.fid == host_fid))
    user = row.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Host user row missing.",
        )
    return user


def _native_room_response(room: Room, host_user: User) -> RoomResponse:
    """Hand-roll a ``RoomResponse`` for a developer Farcaster-native room.

    Native rooms have no Juke LiveKit participant state, so counts are
    always ``(0, 0)`` and the response is built directly from the Juke row
    + host user (not ``RoomService._build_room_response``, which would need
    Redis). Populates the additive ``host_mode`` / ``farcaster_host_fid``
    fields from ``metadata_``.
    """
    from app.schemas.auth import UserResponse  # local import to avoid cycle

    meta = room.metadata_ if isinstance(room.metadata_, dict) else {}
    return RoomResponse(
        id=str(room.id),
        title=room.title,
        host_fid=room.host_fid,
        host=UserResponse(
            fid=host_user.fid,
            username=host_user.username or str(host_user.fid),
            display_name=(
                host_user.display_name or host_user.username or str(host_user.fid)
            ),
            pfp_url=host_user.pfp_url,
            custody_address=None,  # never published in room payloads (L11a)
        ),
        status=room.status,
        started_at=room.started_at.isoformat() if room.started_at else "",
        ended_at=room.ended_at.isoformat() if room.ended_at else None,
        scheduled_at=room.scheduled_at.isoformat() if room.scheduled_at else None,
        speaker_count=0,
        listener_count=0,
        recording=bool(room.recording),
        cast_hash=room.cast_hash,
        allow_agents=room.allow_agents,
        farcaster_room_id=room.farcaster_room_id,
        is_farcaster_native=True,
        host_mode=meta.get("host_mode"),
        farcaster_host_fid=meta.get("farcaster_host_fid"),
    )


def _native_create_envelope(room: Room, host_user: User) -> RoomCreateResponse:
    """Wrap a native ``RoomResponse`` in the create/start envelope. Native
    rooms carry no Juke LiveKit token — the partner's bot / the end user
    joins upstream via the Farcaster client SDK, not through Juke."""
    return RoomCreateResponse(
        room=_native_room_response(room, host_user),
        livekit_token=None,
        livekit_ws_url=None,
        expires_at=None,
    )


def _native_webhook_fields(room: Room) -> dict:
    """Native-specific fields appended to every developer webhook dispatch
    for a Farcaster-native room. Field-consistent with the reconciler's
    ``room.finished`` payload (native_rooms_reconciler.py) and the docs."""
    meta = room.metadata_ if isinstance(room.metadata_, dict) else {}
    return {
        "is_farcaster_native": True,
        "farcaster_room_id": room.farcaster_room_id,
        "host_mode": meta.get("host_mode"),
        "farcaster_host_fid": meta.get("farcaster_host_fid"),
    }


async def _dispatch_native_room_started(db: AsyncSession, room: Room) -> None:
    """Dispatch a ``room.started`` developer webhook for a live native
    room. Base fields mirror room_service.py's dispatch; native fields are
    appended. Best-effort at the call site (wrapped by the caller)."""
    await dispatch_dev_webhook(
        db,
        app_id=room.created_by_app_id,
        event_type="room.started",
        data={
            "room_id": str(room.id),
            "title": room.title,
            "host_fid": room.host_fid,
            "started_at": room.started_at.isoformat() if room.started_at else None,
            "scheduled_at": (
                room.scheduled_at.isoformat() if room.scheduled_at else None
            ),
            **_native_webhook_fields(room),
        },
    )


async def _dispatch_native_room_finished(
    db: AsyncSession, room: Room, *, ended_by_fid: int
) -> None:
    """Dispatch a ``room.finished`` developer webhook for an api-ended
    native room. Base fields mirror the reconciler's ``room.finished``
    payload (``ended_via`` differs: ``"api"`` here vs ``"upstream"`` from
    the reconciler); native fields are appended. Best-effort at the call
    site (wrapped by the caller)."""
    await dispatch_dev_webhook(
        db,
        app_id=room.created_by_app_id,
        event_type="room.finished",
        data={
            "room_id": str(room.id),
            "host_fid": room.host_fid,
            "started_at": room.started_at.isoformat() if room.started_at else None,
            "ended_at": room.ended_at.isoformat() if room.ended_at else None,
            "ended_by_fid": ended_by_fid,
            "ended_via": "api",
            **_native_webhook_fields(room),
        },
    )


async def _publish_native_discovery_redis(
    redis_service: RedisService, room: Room, reason: str
) -> None:
    """Best-effort discovery pub/sub for a native dev room lifecycle event,
    using a bare :class:`RedisService` (start/end paths that don't hold a
    ``RoomService``)."""
    try:
        await redis_service.publish_room_discovery_event(
            {
                "type": "rooms_changed",
                "reason": reason,
                "room_id": str(room.id),
                "status": room.status,
            }
        )
    except Exception as exc:  # pragma: no cover — pubsub best-effort
        logger.debug(
            "discovery publish failed for native dev room %s (%s): %s",
            room.id,
            reason,
            type(exc).__name__,
        )


async def _publish_native_discovery(
    room_service: RoomService, room: Room, reason: str
) -> None:
    """Best-effort discovery pub/sub for a native dev room lifecycle event."""
    await _publish_native_discovery_redis(room_service.redis, room, reason)


async def _upsert_mirror_user(
    db: AsyncSession, fid: int, *, upstream_host: Any | None = None
) -> User:
    """Upsert the mirror ``User`` row backing a user-hosted native room's
    ``host_fid`` FK.

    Mirrors ``rooms.py`` ``mirror_native_room``: a never-signed-in host
    gets a sentinel ``signer_uuid="mirror-only"`` row. Profile fields are
    only filled from ``upstream_host`` when its fid matches (never trust an
    upstream host block attributed to a different fid) and only into
    blanks — never blanking a real value with ``None``.
    """
    row = await db.execute(select(User).where(User.fid == fid))
    user = row.scalar_one_or_none()
    prof = (
        upstream_host
        if upstream_host is not None and getattr(upstream_host, "fid", None) == fid
        else None
    )
    if user is None:
        user = User(
            fid=fid,
            signer_uuid="mirror-only",
            username=(prof.username if prof else None),
            display_name=(prof.display_name if prof else None),
            pfp_url=(prof.pfp_url if prof else None),
        )
        db.add(user)
        await db.flush()
        return user
    if prof is not None:
        if prof.username and not user.username:
            user.username = prof.username
        if prof.display_name and not user.display_name:
            user.display_name = prof.display_name
        if prof.pfp_url and not user.pfp_url:
            user.pfp_url = prof.pfp_url
    return user


def _map_upstream_participant_role(role: str) -> str:
    """Map an upstream Farcaster audio-room role to Juke's participant
    role vocabulary. Only ``cohost`` differs (Juke spells it
    ``co_host``); host / speaker / listener pass through unchanged."""
    return "co_host" if role == "cohost" else role


def _native_participants_response(
    participants: list[Any],
) -> tuple[list[ParticipantResponse], list[int]]:
    """Project upstream ``AudioRoomParticipant`` rows into the Juke
    ``ParticipantResponse`` shape + a hand-raise queue.

    * ``is_muted`` is always ``False`` — Juke has no server-side mute
      state for a native room (that lives upstream / in LiveKit).
    * ``hand_raised`` comes from upstream (``None`` → ``False``).
    * ``hand_queue`` is the fids with a raised hand, ordered by
      ``joined_at`` ascending (``None`` sorts last so a participant with an
      unknown join time never jumps the queue)."""
    mapped: list[ParticipantResponse] = []
    raised: list[Any] = []
    for p in participants:
        fid = p.user.fid
        hand_raised = bool(p.hand_raised)
        mapped.append(
            ParticipantResponse(
                fid=fid,
                role=_map_upstream_participant_role(p.role),
                is_muted=False,
                hand_raised=hand_raised,
                display_name=(p.user.display_name or p.user.username or str(fid)),
                pfp_url=p.user.pfp_url,
            )
        )
        if hand_raised:
            raised.append(p)

    def _joined_key(participant: Any) -> tuple[int, float]:
        joined = participant.joined_at
        if joined is None:
            return (1, 0.0)
        return (0, joined.timestamp())

    hand_queue = [p.user.fid for p in sorted(raised, key=_joined_key)]
    return mapped, hand_queue


@router.post(
    "/spaces",
    response_model=RoomCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_developer_space(
    body: DeveloperSpaceCreate,
    request: Request,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    room_service: RoomService = Depends(get_developer_room_service),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> RoomCreateResponse:
    # Per-key rate limit (60/min). Keyed by key_id so a single compromised
    # key can't be used to fan out room creation; legitimate apps can
    # rotate their key to immediately reset the bucket.
    await _enforce_rate_limit(
        redis,
        key=f"developer_spaces_rate:{verified_key.key_id}",
        limit=_DEVELOPER_SPACES_RATE_LIMIT,
        window_seconds=_DEVELOPER_SPACES_RATE_WINDOW,
        response=response,
    )
    scheduled_at = _parse_scheduled_at(body.scheduled_at)

    if body.host == "farcaster":
        return await _create_farcaster_native_developer_space(
            body=body,
            scheduled_at=scheduled_at,
            verified_key=verified_key,
            room_service=room_service,
            spaces_service=_farcaster_spaces_service(request),
            db=db,
        )

    return await room_service.create_room(
        fid=verified_key.fid,
        title=body.title,
        announce_cast=body.announce_cast,
        scheduled_at=scheduled_at,
        allow_agents=body.allow_agents,
        created_by_app_id=verified_key.app_id,
    )


async def _create_farcaster_native_developer_space(
    *,
    body: DeveloperSpaceCreate,
    scheduled_at: datetime | None,
    verified_key: VerifiedDeveloperKey,
    room_service: RoomService,
    spaces_service: FarcasterSpacesService,
    db: AsyncSession,
) -> RoomCreateResponse:
    """Create a Farcaster-native dev space in one of two host modes.

    ``host == "farcaster"`` requires EXACTLY ONE of ``host_bot_fid``
    (bot-hosted) or ``user_jfs_bearer`` (user-hosted) — supplying both or
    neither is a 422.

    **Bot-hosted** (``host_mode="bot"``): the upstream room is hosted by
    one of the calling app's registered bot FIDs. We mint the bot's bearer
    (custody EIP-191 or managed-signer JFS), create upstream via
    ``create_audio_room_with_bearer``, and record the Juke ``host_fid`` as
    the **calling key's** FID (a real ``users.fid`` row by FK); the bot FID
    lands in ``metadata_['farcaster_host_fid']``.

    **User-hosted** (``host_mode="user_fid"``): the caller passes an
    end-user-signed JFS bearer; the upstream room is hosted by that user's
    FID directly. We decode the bearer's fid, create upstream via
    ``create_audio_room(as_user_bearer=...)``, upsert a mirror ``User`` for
    the fid (FK), and record ``host_fid`` = the bearer fid.

    Both modes persist ``is_farcaster_native=True`` + ``farcaster_room_id``
    + ``created_by_app_id`` (partner attribution / iframe-CSP path). Live
    (non-scheduled) creates also register the active room + dispatch a
    ``room.started`` developer webhook; scheduled creates do neither (the
    ``start`` endpoint fires ``room.started`` when they go live).
    """
    has_bot = body.host_bot_fid is not None
    has_bearer = body.user_jfs_bearer is not None
    if has_bot == has_bearer:
        # Neither or both — ambiguous host intent. 422 rather than silently
        # preferring one branch.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "When host == 'farcaster', provide exactly one of "
                "host_bot_fid or user_jfs_bearer."
            ),
        )

    is_scheduled = scheduled_at is not None
    now = datetime.now(tz=timezone.utc)

    if has_bearer:
        host_fid, farcaster_room_id, host_user = await _create_native_user_hosted(
            body=body,
            scheduled_at=scheduled_at,
            verified_key=verified_key,
            spaces_service=spaces_service,
            db=db,
        )
        host_mode = "user_fid"
        farcaster_host_fid = host_fid
    else:
        host_fid, farcaster_room_id, host_user = await _create_native_bot_hosted(
            body=body,
            scheduled_at=scheduled_at,
            verified_key=verified_key,
            spaces_service=spaces_service,
            db=db,
        )
        host_mode = "bot"
        farcaster_host_fid = body.host_bot_fid

    # Persist the Juke row. We don't reuse ``RoomService.link_farcaster_room``
    # because that path also checks ``user.farcaster_sync_enabled`` —
    # which doesn't apply to a developer-owned room.
    room = Room(
        title=body.title,
        host_fid=host_fid,
        status="scheduled" if is_scheduled else "active",
        scheduled_at=scheduled_at,
        started_at=None if is_scheduled else now,
        livekit_room_id=None,
        allow_agents=body.allow_agents,
        recording=False,
        is_farcaster_native=True,
        farcaster_room_id=farcaster_room_id,
        created_by_app_id=verified_key.app_id,
        metadata_={
            "farcaster_host_fid": farcaster_host_fid,
            "channel_key": body.channel_key,
            "source": "developer-api",
            "host_mode": host_mode,
        },
    )
    db.add(room)
    await db.commit()
    await db.refresh(room)

    # Discovery pub/sub — keep native dev rooms surfacing alongside
    # Juke-hosted rooms.
    await _publish_native_discovery(
        room_service, room, "room_scheduled" if is_scheduled else "room_started"
    )

    # Live creates surface immediately in the active-rooms set + fire a
    # ``room.started`` webhook. Scheduled creates do neither — going live
    # happens through ``POST /spaces/{id}/start``, which fires them there.
    if not is_scheduled:
        try:
            await room_service.redis.add_active_room(str(room.id), now.timestamp())
        except Exception as exc:  # pragma: no cover — best-effort
            logger.debug(
                "redis add_active_room failed for native dev create %s: %s",
                room.id,
                type(exc).__name__,
            )
        try:
            await _dispatch_native_room_started(db, room)
        except Exception as exc:  # pragma: no cover — best-effort
            logger.debug(
                "room.started dispatch failed for native dev create %s: %s",
                room.id,
                type(exc).__name__,
            )

    # Audit log for fair-use review.
    logger.info(
        "developer_create_native_space app_id=%s key_id=%s room_id=%s "
        "farcaster_room_id=%s host_mode=%s farcaster_host_fid=%s",
        verified_key.app_id,
        verified_key.key_id,
        room.id,
        farcaster_room_id,
        host_mode,
        farcaster_host_fid,
    )

    return _native_create_envelope(room, host_user)


async def _create_native_bot_hosted(
    *,
    body: DeveloperSpaceCreate,
    scheduled_at: datetime | None,
    verified_key: VerifiedDeveloperKey,
    spaces_service: FarcasterSpacesService,
    db: AsyncSession,
) -> tuple[int, str, User]:
    """Bot-hosted create branch. Returns ``(host_fid, farcaster_room_id,
    host_user)``. ``host_fid`` is the calling key's FID."""
    # Partner ownership check. A 403 here is intentional even though
    # cross-app lookups elsewhere collapse to 404 — the FID itself is
    # public information (it's a Farcaster ID), so 403 is not an
    # enumeration oracle.
    bot_row = (
        await db.execute(
            select(DeveloperAppBot).where(
                DeveloperAppBot.app_id == verified_key.app_id,
                DeveloperAppBot.fid == body.host_bot_fid,
                DeveloperAppBot.is_active.is_(True),
            )
        )
    ).scalar_one_or_none()
    if bot_row is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "host_bot_fid is not registered to this developer "
                "app or is inactive."
            ),
        )

    # Mint the bot's bearer. An unapproved managed signer surfaces as
    # ``BotSignerNotReady`` → actionable 409; credential/config failures
    # collapse to an opaque 503 (never leak the custody ref / env var).
    try:
        bearer = await spaces_service.get_developer_bot_bearer(
            verified_key.app_id, body.host_bot_fid, db
        )
    except BotSignerNotReady as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "The host bot's signer is not approved yet. Complete the "
                "Warpcast approval, then retry."
            ),
        ) from exc
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "developer-bot bearer mint failed for app=%s fid=%s: %s",
            verified_key.app_id,
            body.host_bot_fid,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot credentials unavailable.",
        ) from exc

    # Upstream create. httpx errors → 502.
    try:
        upstream_result = await spaces_service.create_audio_room_with_bearer(
            bearer=bearer,
            title=body.title,
            scheduled_at=scheduled_at,
            channel_key=body.channel_key,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "create_audio_room upstream failure app=%s fid=%s err=%s",
            verified_key.app_id,
            body.host_bot_fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to create Farcaster-native room.",
        ) from exc

    # The upstream payload nests the room under ``room`` with ``id`` as
    # the UUID; some variants flatten to top-level ``roomId``. Be tolerant.
    room_obj = upstream_result.get("room")
    farcaster_room_id: str | None = None
    if isinstance(room_obj, dict):
        farcaster_room_id = room_obj.get("id")
    if not isinstance(farcaster_room_id, str) or not farcaster_room_id:
        farcaster_room_id = upstream_result.get("roomId")
    if not isinstance(farcaster_room_id, str) or not farcaster_room_id:
        logger.warning(
            "create_audio_room missing room id in result for app=%s",
            verified_key.app_id,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Upstream create did not return a room id.",
        )

    host_user = await _load_room_host_user(db, verified_key.fid)
    return verified_key.fid, farcaster_room_id, host_user


async def _create_native_user_hosted(
    *,
    body: DeveloperSpaceCreate,
    scheduled_at: datetime | None,
    verified_key: VerifiedDeveloperKey,
    spaces_service: FarcasterSpacesService,
    db: AsyncSession,
) -> tuple[int, str, User]:
    """User-hosted create branch. Returns ``(host_fid, farcaster_room_id,
    host_user)``. ``host_fid`` is the bearer's decoded FID."""
    # Decode + shape-validate the user's bearer. The raw bearer is NEVER
    # logged (only the reason string, which carries no key material).
    try:
        bearer_fid = decode_jfs_bearer(body.user_jfs_bearer)
    except ValueError as exc:
        logger.warning(
            "developer native create invalid user_jfs_bearer app=%s reason=%s",
            verified_key.app_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user_jfs_bearer",
        ) from exc

    # Upstream create with the user's bearer forwarded verbatim as the
    # Authorization header — the upstream room is hosted by the bearer fid.
    try:
        audio_room = await spaces_service.create_audio_room(
            title=body.title,
            scheduled_at=scheduled_at,
            channel_key=body.channel_key,
            as_user_bearer=body.user_jfs_bearer,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "create_audio_room upstream failure (user-hosted) app=%s err=%s",
            verified_key.app_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to create Farcaster-native room.",
        ) from exc
    except ValueError as exc:
        logger.warning(
            "create_audio_room malformed envelope (user-hosted) app=%s",
            verified_key.app_id,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Upstream create did not return a room id.",
        ) from exc

    farcaster_room_id = audio_room.id
    if not isinstance(farcaster_room_id, str) or not farcaster_room_id:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Upstream create did not return a room id.",
        )

    # Upsert the mirror User so Room.host_fid FK is satisfied.
    host_user = await _upsert_mirror_user(db, bearer_fid, upstream_host=audio_room.host)
    return bearer_fid, farcaster_room_id, host_user


@router.get("/spaces/{room_id}", response_model=RoomDetailResponse)
async def get_developer_space(
    room_id: str,
    request: Request,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    room_service: RoomService = Depends(get_developer_room_service),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> RoomDetailResponse:
    """Read the current state of a developer-created room.

    Returns the same shape as ``GET /v1/rooms/{room_id}`` — room
    metadata + live participant list + hand queue — but key-auth'd and
    scoped to rooms the calling app created. Use this to reconcile
    against the source of truth after a missed webhook delivery, or to
    answer "who's actually here right now" without polling LiveKit.

    For **Farcaster-native** rooms there is no Juke Redis participant
    state — the participant list is proxied from
    ``client.farcaster.xyz``. The ``X-Juke-Participants-Source`` response
    header records where the list came from: ``upstream`` (fresh from
    Farcaster), ``unavailable`` (upstream errored — the read degrades to
    empty lists + 200 rather than 502ing a reconciliation poll), or
    ``juke`` (non-native rooms served from Redis).

    Cross-app and iOS-native rooms 404 (no enumeration oracle).
    """
    # Bound the load amplification potential of a leaked key on the
    # read path. Without this, a stolen key could be used to poll
    # participant lists from the calling app's own rooms at unbounded
    # RPS until the key is rotated.
    await _enforce_rate_limit(
        redis,
        key=f"developer_spaces_read_rate:{verified_key.key_id}",
        limit=_DEVELOPER_READ_RATE_LIMIT,
        window_seconds=_DEVELOPER_READ_RATE_WINDOW,
        response=response,
    )
    try:
        room_uuid = UUID(room_id)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    result = await db.execute(select(Room).where(Room.id == room_uuid))
    row = result.scalar_one_or_none()
    if row is None or row.created_by_app_id != verified_key.app_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )

    if row.is_farcaster_native:
        return await _get_native_developer_space(
            room=row, request=request, response=response, db=db
        )

    # current_fid=None: the developer key's owner_fid isn't a
    # meaningful "current user" for RSVP `is_going`. Treat the read as
    # uninhabited so the field always reports false for partner reads.
    response.headers["X-Juke-Participants-Source"] = "juke"
    return await room_service.get_room(room_id=room_id, current_fid=None)


async def _get_native_developer_space(
    *,
    room: Room,
    request: Request,
    response: Response,
    db: AsyncSession,
) -> RoomDetailResponse:
    """Build a ``RoomDetailResponse`` for a native dev room, proxying the
    participant list from upstream. A read must never 502 on an upstream
    blip — an unavailable upstream degrades to empty lists + a
    ``X-Juke-Participants-Source: unavailable`` header."""
    host_user = await _load_room_host_user(db, room.host_fid)
    room_response = _native_room_response(room, host_user)

    participants: list[ParticipantResponse] = []
    hand_queue: list[int] = []
    source = "unavailable"

    spaces_service = getattr(request.app.state, "farcaster_spaces_service", None)
    if spaces_service is not None and room.farcaster_room_id:
        try:
            upstream_participants = await spaces_service.get_participants(
                room.farcaster_room_id
            )
            participants, hand_queue = _native_participants_response(
                upstream_participants
            )
            source = "upstream"
        except Exception as exc:  # noqa: BLE001 — reads degrade, never 502
            logger.warning(
                "native dev participants proxy degraded room=%s err=%s",
                room.id,
                type(exc).__name__,
            )

    response.headers["X-Juke-Participants-Source"] = source
    return RoomDetailResponse(
        room=room_response,
        participants=participants,
        hand_queue=hand_queue,
    )


@router.post(
    "/spaces/{room_id}/start",
    response_model=RoomCreateResponse,
)
async def start_developer_space(
    room_id: str,
    request: Request,
    response: Response,
    body: DeveloperSpaceStartRequest | None = None,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> RoomCreateResponse:
    """Take a scheduled Farcaster-native dev space live.

    Native-only: Juke-hosted scheduled rooms go live via the LiveKit
    join/create path, not here. Idempotent — an already-active room
    returns 200 with its current state and issues no upstream call.

    Bearer dispatch mirrors create/end: ``host_mode == "user_fid"`` rooms
    require a fresh user-signed ``user_jfs_bearer`` (fid must match the
    room host); ``host_mode == "bot"`` rooms mint from the managed / custody
    signer (an unapproved managed signer → 409). An upstream 4xx is a
    permanent rejection → 400; 5xx / transport failures → 502 with the Juke
    row left ``scheduled`` so a retry is meaningful.
    """
    await _enforce_rate_limit(
        redis,
        key=f"developer_spaces_rate:{verified_key.key_id}",
        limit=_DEVELOPER_SPACES_RATE_LIMIT,
        window_seconds=_DEVELOPER_SPACES_RATE_WINDOW,
        response=response,
    )

    # Cross-app rooms and unknown rooms both 404 — same response shape so
    # the id space can't be enumerated.
    try:
        room_uuid = UUID(room_id)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    result = await db.execute(select(Room).where(Room.id == room_uuid))
    room = result.scalar_one_or_none()
    if room is None or room.created_by_app_id != verified_key.app_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )

    if not room.is_farcaster_native:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Not a Farcaster-native room",
        )

    # Idempotent: already live → return current state, no upstream call.
    if room.status == "active":
        host_user = await _load_room_host_user(db, room.host_fid)
        return _native_create_envelope(room, host_user)

    if room.status != "scheduled":
        # ended / cancelled — nothing to go live to.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Room is not in scheduled state",
        )

    if not room.farcaster_room_id:
        logger.warning(
            "native dev start: row missing farcaster_room_id room=%s",
            room.id,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Native room missing upstream id",
        )

    spaces_service = _farcaster_spaces_service(request)
    user_bearer = body.user_jfs_bearer if body is not None else None
    upstream_bearer = await _resolve_native_lifecycle_bearer(
        room=room,
        user_bearer=user_bearer,
        verified_key=verified_key,
        spaces_service=spaces_service,
        db=db,
        action="start",
    )

    # Upstream go-live. 4xx → permanent rejection (400); 5xx / transport →
    # 502 with the row left ``scheduled`` so a retry is meaningful.
    try:
        await spaces_service.start_scheduled_audio_room(
            room.farcaster_room_id, bearer=upstream_bearer
        )
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "native dev start: service misconfigured room=%s: %s", room.id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Farcaster spaces service unavailable.",
        ) from exc
    except httpx.HTTPStatusError as exc:
        upstream_status = exc.response.status_code if exc.response is not None else None
        logger.warning(
            "native dev start: upstream rejected room=%s status=%s",
            room.id,
            upstream_status,
        )
        if upstream_status is not None and 400 <= upstream_status < 500:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Couldn't start on Farcaster.",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Couldn't start on Farcaster.",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "native dev start: upstream failed room=%s err=%s",
            room.id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Couldn't start on Farcaster.",
        ) from exc

    # Flip live AFTER the upstream call succeeds.
    now = datetime.now(tz=timezone.utc)
    room.status = "active"
    room.started_at = now
    await db.commit()
    await db.refresh(room)

    redis_service = RedisService(redis)
    try:
        await redis_service.add_active_room(str(room.id), now.timestamp())
    except Exception as exc:  # pragma: no cover — best-effort
        logger.debug(
            "redis add_active_room failed for native dev start %s: %s",
            room.id,
            type(exc).__name__,
        )
    await _publish_native_discovery_redis(redis_service, room, "room_started")
    try:
        await _dispatch_native_room_started(db, room)
    except Exception as exc:  # pragma: no cover — best-effort
        logger.debug(
            "room.started dispatch failed for native dev start %s: %s",
            room.id,
            type(exc).__name__,
        )

    logger.info(
        "developer_start_native_space app_id=%s key_id=%s room_id=%s "
        "farcaster_room_id=%s",
        verified_key.app_id,
        verified_key.key_id,
        room.id,
        room.farcaster_room_id,
    )

    host_user = await _load_room_host_user(db, room.host_fid)
    return _native_create_envelope(room, host_user)


@router.post("/spaces/{room_id}/end", response_model=StatusResponse)
async def end_developer_space(
    room_id: str,
    request: Request,
    response: Response,
    body: DeveloperSpaceEndRequest | None = None,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    room_service: RoomService = Depends(get_developer_room_service),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> StatusResponse:
    """End a room created by the calling developer app.

    Without this, partners with key-only auth had no way to force a
    space to end — they were stuck waiting for LiveKit's 5-minute
    empty-room timeout after the last participant disconnected. Same
    ownership rule as the other developer-namespaced routes: the room
    must have been created via ``POST /v1/developer/spaces`` by the
    calling app.

    Farcaster-native rooms take a dedicated branch
    (``_end_farcaster_native_developer_space``) — ``RoomService.end_room``
    checks Juke Redis actor roles that native rooms don't have (guaranteed
    403) and never calls upstream ``end_audio_room``. Juke-hosted rooms are
    unchanged. The optional ``user_jfs_bearer`` body is only consulted for
    user-hosted native rooms; empty-body calls are backward compatible.
    """
    await _enforce_rate_limit(
        redis,
        key=f"developer_spaces_rate:{verified_key.key_id}",
        limit=_DEVELOPER_SPACES_RATE_LIMIT,
        window_seconds=_DEVELOPER_SPACES_RATE_WINDOW,
        response=response,
    )

    # Cross-app rooms and unknown rooms both 404 — same response shape so
    # the endpoint cannot be used to enumerate UUIDs owned by other
    # developer apps. Matches the partner agent-join behavior.
    try:
        room_uuid = UUID(room_id)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    result = await db.execute(select(Room).where(Room.id == room_uuid))
    room = result.scalar_one_or_none()
    if room is None or room.created_by_app_id != verified_key.app_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )

    if room.is_farcaster_native:
        return await _end_farcaster_native_developer_space(
            room=room,
            body=body,
            request=request,
            verified_key=verified_key,
            redis=redis,
            db=db,
        )

    # Juke-hosted path — unchanged. The app's ``owner_fid`` was registered
    # as the room host at creation time, so this caller passes the role
    # check inside ``end_room``. Tag with ``ended_via="api"`` so partner
    # webhook consumers can distinguish this from a human pressing End Space.
    await room_service.end_room(room_id=room_id, fid=verified_key.fid, ended_via="api")
    return StatusResponse(status="ended")


async def _end_farcaster_native_developer_space(
    *,
    room: Room,
    body: DeveloperSpaceEndRequest | None,
    request: Request,
    verified_key: VerifiedDeveloperKey,
    redis,
    db: AsyncSession,
) -> StatusResponse:
    """End a Farcaster-native dev room. Mirrors ``rooms.py`` end_native_room
    but keyed on developer attribution instead of an iOS JWT host."""
    # Idempotent: already terminal → 200, no upstream call.
    if room.status in ("ended", "cancelled"):
        return StatusResponse(status="ended")

    if not room.farcaster_room_id:
        logger.warning(
            "native dev end: row missing farcaster_room_id room=%s",
            room.id,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Native room missing upstream id",
        )

    was_scheduled = room.status == "scheduled"
    spaces_service = _farcaster_spaces_service(request)
    user_bearer = body.user_jfs_bearer if body is not None else None
    upstream_bearer = await _resolve_native_lifecycle_bearer(
        room=room,
        user_bearer=user_bearer,
        verified_key=verified_key,
        spaces_service=spaces_service,
        db=db,
        action="end",
    )

    # Best-effort native recording stop before ending upstream so the
    # egress worker can finalize while the room is still alive. Never
    # blocks the end flow.
    if room.recording and room.recording_id:
        await _best_effort_stop_native_recording(
            room=room,
            request=request,
            redis=redis,
            db=db,
            spaces_service=spaces_service,
        )
        refreshed = await db.execute(select(Room).where(Room.id == room.id))
        latest = refreshed.scalar_one_or_none()
        if latest is not None:
            room = latest

    # Upstream end. 4xx is swallowed inside the service (None). 5xx /
    # transport → 502 with the row left ``active`` so a retry makes sense.
    try:
        await spaces_service.end_audio_room(
            room.farcaster_room_id, bearer=upstream_bearer
        )
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "native dev end: service misconfigured room=%s: %s", room.id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Farcaster spaces service unavailable.",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "native dev end: upstream failed room=%s err=%s",
            room.id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Couldn't end on Farcaster.",
        ) from exc

    # Flip terminal AFTER the upstream call. A scheduled room that never
    # went live is ``cancelled``; a live room is ``ended``.
    now = datetime.now(tz=timezone.utc)
    room.status = "cancelled" if was_scheduled else "ended"
    room.ended_at = now
    await db.commit()
    await db.refresh(room)

    redis_service = RedisService(redis)
    try:
        await redis_service.remove_active_room(str(room.id))
    except Exception as exc:  # pragma: no cover — best-effort
        logger.debug(
            "redis remove_active_room failed for native dev end %s: %s",
            room.id,
            type(exc).__name__,
        )
    await _publish_native_discovery_redis(redis_service, room, "room_ended")
    try:
        await _dispatch_native_room_finished(db, room, ended_by_fid=verified_key.fid)
    except Exception as exc:  # pragma: no cover — best-effort
        logger.debug(
            "room.finished dispatch failed for native dev end %s: %s",
            room.id,
            type(exc).__name__,
        )

    logger.info(
        "developer_end_native_space app_id=%s key_id=%s room_id=%s status=%s",
        verified_key.app_id,
        verified_key.key_id,
        room.id,
        room.status,
    )
    return StatusResponse(status="ended")


async def _best_effort_stop_native_recording(
    *,
    room: Room,
    request: Request,
    redis,
    db: AsyncSession,
    spaces_service: FarcasterSpacesService,
) -> None:
    """Stop an in-progress recording before ending a native room. Any
    failure is logged and swallowed — a stuck egress worker must never
    block the host from ending their space."""
    recording_agent_svc = getattr(request.app.state, "recording_agent_service", None)
    if recording_agent_svc is None:
        return
    livekit = LiveKitService()
    try:
        inline = RoomService(
            db,
            RedisService(redis),
            livekit,
            farcaster_spaces=spaces_service,
            recording_agent=recording_agent_svc,
        )
        await inline.stop_recording(room_id=str(room.id), fid=room.host_fid)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning(
            "native dev end: auto-stop recording failed room=%s err=%s",
            room.id,
            type(exc).__name__,
        )
    finally:
        await livekit.close()


async def _resolve_native_lifecycle_bearer(
    *,
    room: Room,
    user_bearer: str | None,
    verified_key: VerifiedDeveloperKey,
    spaces_service: FarcasterSpacesService,
    db: AsyncSession,
    action: str,
) -> str | None:
    """Resolve the upstream Authorization bearer for a native start/end.

    * ``host_mode == "user_fid"`` — a fresh user-signed bearer is REQUIRED
      (400 if missing), must decode (400 if malformed), and its fid must
      match the room host (403 otherwise). Forwarded verbatim.
    * ``host_mode == "bot"`` — minted from the managed / custody signer.
      An unapproved managed signer → 409; credential/config failure → 503.
    """
    meta = room.metadata_ if isinstance(room.metadata_, dict) else {}
    host_mode = meta.get("host_mode")

    if host_mode == "user_fid":
        if not user_bearer:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"user_jfs_bearer required to {action} a user-hosted "
                    "native space"
                ),
            )
        try:
            bearer_fid = decode_jfs_bearer(user_bearer)
        except ValueError as exc:
            # Reason string only — never the bearer itself.
            logger.warning(
                "native dev %s: invalid user_jfs_bearer room=%s reason=%s",
                action,
                room.id,
                exc,
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid user_jfs_bearer",
            ) from exc
        if bearer_fid != room.host_fid:
            logger.warning(
                "native dev %s: bearer fid mismatch room=%s host=%s jfs=%s",
                action,
                room.id,
                room.host_fid,
                bearer_fid,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="JFS bearer fid does not match the room host",
            )
        return user_bearer

    # Bot-hosted: mint from the registered host bot's signer.
    host_bot_fid = meta.get("farcaster_host_fid")
    if not isinstance(host_bot_fid, int):
        logger.warning(
            "native dev %s: bot room missing farcaster_host_fid room=%s",
            action,
            room.id,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Native room missing host bot fid",
        )
    try:
        return await spaces_service.get_developer_bot_bearer(
            verified_key.app_id, host_bot_fid, db
        )
    except BotSignerNotReady as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "The host bot's signer is not approved yet. Complete the "
                "Warpcast approval, then retry."
            ),
        ) from exc
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "native dev %s: bot bearer mint failed app=%s fid=%s: %s",
            action,
            verified_key.app_id,
            host_bot_fid,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot credentials unavailable.",
        ) from exc


# ---------------------------------------------------------------------------
# Partner SSO bridge
#
# Mints a short-lived Juke JWT on behalf of a trusted developer app so
# their iframe visitor — already SIWN/SIWE-authenticated on the parent
# site — doesn't have to re-do SIWF inside the embed. The trust model:
# possession of an active developer API key + the visitor's fid asserted
# by the partner. Damage from a leaked key is bounded by the TTL cap
# (≤ 10 min), the per-key rate limit, and the ``partner_app_id`` claim
# baked into the JWT for audit attribution.
# ---------------------------------------------------------------------------


@router.post(
    "/partner-tokens",
    response_model=PartnerTokenResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_partner_token(
    body: PartnerTokenCreate,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> PartnerTokenResponse:
    # Two-tier rate limit: a per-minute ceiling matching ``/v1/developer/spaces``
    # plus a daily cap so a leaked key can't slow-drip-enumerate the fid space.
    # The per-minute limit drives the X-Juke-Rate-Limit-* headers — the daily
    # cap is enforced separately and surfaces via 429 + Retry-After only.
    await _enforce_rate_limit(
        redis,
        key=f"developer_partner_token_rate:{verified_key.key_id}",
        limit=_PARTNER_TOKEN_RATE_LIMIT,
        window_seconds=_PARTNER_TOKEN_RATE_WINDOW,
        response=response,
    )
    await _enforce_rate_limit(
        redis,
        key=f"developer_partner_token_daily:{verified_key.key_id}",
        limit=_PARTNER_TOKEN_DAILY_LIMIT,
        window_seconds=_PARTNER_TOKEN_DAILY_WINDOW,
    )
    # The per-key buckets above reset on key rotation and multiply with the
    # number of keys / apps an owner holds. Also bucket by app and by owning
    # fid so neither rotating keys nor spinning up extra apps raises the cap.
    for scope, scope_id in (
        ("app", verified_key.app_id),
        ("owner", verified_key.fid),
    ):
        await _enforce_rate_limit(
            redis,
            key=f"developer_partner_token_rate:{scope}:{scope_id}",
            limit=_PARTNER_TOKEN_RATE_LIMIT,
            window_seconds=_PARTNER_TOKEN_RATE_WINDOW,
        )
        await _enforce_rate_limit(
            redis,
            key=f"developer_partner_token_daily:{scope}:{scope_id}",
            limit=_PARTNER_TOKEN_DAILY_LIMIT,
            window_seconds=_PARTNER_TOKEN_DAILY_WINDOW,
        )

    # Never mint a partner session for a Juke admin. Admin routes are
    # first-party-only regardless, but a partner assertion of an admin's
    # identity has no legitimate use and widens the blast radius of any
    # future first-party gap.
    is_admin_target = await db.scalar(select(User.is_admin).where(User.fid == body.fid))
    if is_admin_target:
        logger.warning(
            "partner_token_refused_admin_target app_id=%s key_id=%s",
            verified_key.app_id,
            verified_key.key_id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A partner token cannot be issued for this fid.",
        )

    token, expires_at_iso = create_partner_jwt(
        fid=body.fid,
        partner_app_id=str(verified_key.app_id),
        ttl_seconds=body.ttl_seconds,
    )
    return PartnerTokenResponse(
        token=token,
        fid=body.fid,
        expires_at=datetime.fromisoformat(expires_at_iso),
        partner_app_id=verified_key.app_id,
    )


# ---------------------------------------------------------------------------
# Partner-scoped free agent-join
#
# Lets an approved developer drop their own bot (concierge, transcriber,
# recap generator, etc.) into rooms they created without paying the x402
# toll the public ``/v1/rooms/{room_id}/agent-join`` endpoint requires.
# Trust model: possession of the API key + ``room.created_by_app_id``
# matches the key's app. Cross-app calls 403; iOS-native rooms (no
# owning app) cannot be reached at all. The returned ``session_token``
# is identical to the paid path's so rejoin/leave/refresh-token flow
# downstream code stays the same.
# ---------------------------------------------------------------------------


@router.post(
    "/rooms/{room_id}/agent-join",
    status_code=status.HTTP_201_CREATED,
)
async def partner_agent_join_room(
    room_id: str,
    body: PartnerAgentJoinRequest,
    request: Request,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    """Drop a partner-owned bot into a room owned by the calling app.

    Two response shapes:

    * Juke-hosted room → :py:class:`AgentJoinResponse` (existing flow).
    * Farcaster-native room + ``agent_bot_fid`` → :py:class:`NativeAgentJoinResponse`
      with ``{wsUrl, token}`` so the partner's bot connects directly to
      the upstream LiveKit signaling URL.

    The ``response_model`` is omitted so we can return either shape
    without contorting Pydantic unions in the OpenAPI surface.
    """
    await _enforce_rate_limit(
        redis,
        key=f"developer_agent_join_rate:{verified_key.key_id}",
        limit=_PARTNER_AGENT_JOIN_RATE_LIMIT,
        window_seconds=_PARTNER_AGENT_JOIN_RATE_WINDOW,
        response=response,
    )
    await _enforce_rate_limit(
        redis,
        key=f"developer_agent_join_daily:{verified_key.key_id}",
        limit=_PARTNER_AGENT_JOIN_DAILY_LIMIT,
        window_seconds=_PARTNER_AGENT_JOIN_DAILY_WINDOW,
    )

    # UUID parse + ownership + state checks. Cross-app rooms (and rooms
    # that don't exist at all) both 404 — same status code, same body
    # — so a partner cannot use this endpoint as an oracle to enumerate
    # which UUIDs belong to other developer apps.
    try:
        room_uuid = UUID(room_id)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    result = await db.execute(select(Room).where(Room.id == room_uuid))
    room = result.scalar_one_or_none()
    if room is None or room.created_by_app_id != verified_key.app_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )

    # Farcaster-native room + agent_bot_fid: mint the bot's bearer and
    # return raw LiveKit creds so the partner's worker can connect via
    # the upstream signaling URL. The Juke ``active`` / ``allow_agents``
    # checks below are LiveKit-room-state specific and don't apply to
    # native rooms (we don't own that state — Farcaster does), so we
    # short-circuit before them.
    if room.is_farcaster_native and body.agent_bot_fid is not None:
        return await _native_agent_join(
            room=room,
            agent_bot_fid=body.agent_bot_fid,
            verified_key=verified_key,
            spaces_service=_farcaster_spaces_service(request),
            db=db,
        )

    if room.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Room is not active"
        )
    if not room.allow_agents:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This room does not allow agents",
        )

    # Rejoin path: X-Session-Token from a prior call. Mirrors the public
    # agent-join handler exactly so a partner-spawned agent can recover
    # from a transient disconnect without re-authenticating.
    session_token = request.headers.get("x-session-token")
    if session_token:
        session_svc = SessionService(redis)
        session = await session_svc.verify_session(session_token, room_id=room_id)
        if not session:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired session token",
            )
        livekit = LiveKitService()
        try:
            svc = RoomService(db=db, redis=RedisService(redis), livekit=livekit)
            # SECURITY (L7): rejoin through the agent path so the per-room
            # agent cap, allow_agents flag and is_agent metadata apply.
            join_response = await svc.join_room_as_agent(
                room_id=room_id,
                agent_fid=session.agent_fid,
                agent_name=session.agent_name,
                agent_pfp_url=session.agent_pfp_url,
            )
            return AgentJoinResponse(
                session_token=session_token,
                livekit_token=join_response.livekit_token,
                livekit_ws_url=join_response.livekit_ws_url,
                expires_at=join_response.expires_at,
                role=join_response.role,
                room=join_response.room.model_dump(),
                participants=[p.model_dump() for p in join_response.participants],
            )
        finally:
            await livekit.close()

    # Fresh join. Tag the session with the owning app for audit
    # attribution — distinguishes partner-minted agents from x402-paid
    # ones in session logs. Pass ``db`` so SessionService can verify the
    # allocated fid has no existing User row (defends against Redis
    # counter wrap after a flush/restore).
    session_svc = SessionService(redis)
    token, session = await session_svc.create_session(
        room_id=room_id,
        agent_name=body.agent_name,
        agent_pfp_url=body.agent_pfp_url,
        payer_address=f"partner:{verified_key.app_id}",
        db=db,
    )

    existing_user_row = await db.execute(
        select(User).where(User.fid == session.agent_fid)
    )
    if existing_user_row.scalar_one_or_none() is None:
        agent_user = User(
            fid=session.agent_fid,
            signer_uuid=f"agent:{session.agent_fid}",
            username=f"agent-{session.agent_fid}",
            display_name=body.agent_name,
            pfp_url=body.agent_pfp_url,
            is_agent=True,
        )
        db.add(agent_user)
        await db.commit()

    livekit = LiveKitService()
    try:
        svc = RoomService(db=db, redis=RedisService(redis), livekit=livekit)
        join_response = await svc.join_room_as_agent(
            room_id=room_id,
            agent_fid=session.agent_fid,
            agent_name=body.agent_name,
            agent_pfp_url=body.agent_pfp_url,
        )
        # Structured audit log so post-hoc fair-use review can answer
        # "which partner spawned which agents into which rooms?" once
        # the 24h Redis session blob has expired. INFO-level because
        # this is normal partner behavior, not a security event.
        logger.info(
            "partner_agent_join app_id=%s key_id=%s room_id=%s "
            "agent_fid=%s agent_name=%r",
            verified_key.app_id,
            verified_key.key_id,
            room_id,
            session.agent_fid,
            body.agent_name,
        )
        return AgentJoinResponse(
            session_token=token,
            livekit_token=join_response.livekit_token,
            livekit_ws_url=join_response.livekit_ws_url,
            expires_at=join_response.expires_at,
            role=join_response.role,
            room=join_response.room.model_dump(),
            participants=[p.model_dump() for p in join_response.participants],
        )
    finally:
        await livekit.close()


async def _native_agent_join(
    *,
    room: Room,
    agent_bot_fid: int,
    verified_key: VerifiedDeveloperKey,
    spaces_service: FarcasterSpacesService,
    db: AsyncSession,
) -> NativeAgentJoinResponse:
    """Mint a LiveKit join token for a partner-owned bot to drop into
    an existing Farcaster-native room.

    Defense-in-depth gating:
    1. Row-level ownership: ``room.created_by_app_id`` must match the
       calling key's app (verified by caller before reaching us).
    2. Bot ownership: ``agent_bot_fid`` must be an active row in
       ``developer_app_bots`` for the same app.
    3. Service-level: ``FarcasterSpacesService.get_developer_bot_bearer``
       re-checks (1) against the registry before minting.

    The upstream ``POST /v1/audio-room/join`` returns ``{wsUrl, token}``
    (sometimes ``url`` instead of ``wsUrl``); we tolerate both.
    """
    if not room.farcaster_room_id:
        # is_farcaster_native=True without a farcaster_room_id is
        # internal-state corruption. Surface as 500.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Native room missing farcaster_room_id",
        )

    bot_row = (
        await db.execute(
            select(DeveloperAppBot).where(
                DeveloperAppBot.app_id == verified_key.app_id,
                DeveloperAppBot.fid == agent_bot_fid,
                DeveloperAppBot.is_active.is_(True),
            )
        )
    ).scalar_one_or_none()
    if bot_row is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "agent_bot_fid is not registered to this developer "
                "app or is inactive."
            ),
        )

    try:
        bearer = await spaces_service.get_developer_bot_bearer(
            verified_key.app_id, agent_bot_fid, db
        )
    except BotSignerNotReady as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "The bot's signer is not approved yet. Complete the "
                "Warpcast approval, then retry."
            ),
        ) from exc
    except FarcasterSpacesConfigError as exc:
        logger.warning(
            "developer-bot bearer mint failed for app=%s fid=%s: %s",
            verified_key.app_id,
            agent_bot_fid,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot credentials unavailable.",
        ) from exc

    try:
        join_result = await spaces_service.join_room_as_listener(
            room_id=room.farcaster_room_id, bearer=bearer
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "native agent-join upstream failure app=%s fid=%s err=%s",
            verified_key.app_id,
            agent_bot_fid,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Upstream join failed.",
        ) from exc

    ws_url = join_result.get("wsUrl") or join_result.get("url")
    token = join_result.get("token")
    if not isinstance(ws_url, str) or not ws_url or not isinstance(token, str):
        logger.warning(
            "native agent-join missing wsUrl/token in upstream " "result for app=%s",
            verified_key.app_id,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Upstream join returned incomplete credentials.",
        )

    logger.info(
        "developer_native_agent_join app_id=%s key_id=%s room_id=%s "
        "farcaster_room_id=%s agent_bot_fid=%s",
        verified_key.app_id,
        verified_key.key_id,
        room.id,
        room.farcaster_room_id,
        agent_bot_fid,
    )
    return NativeAgentJoinResponse(
        ws_url=ws_url,
        token=token,
        farcaster_room_id=room.farcaster_room_id,
    )


# ---------------------------------------------------------------------------
# Developer-app bot registry
#
# A bot is a Farcaster identity (FID) owned by the developer app. Used
# to host Farcaster-native dev spaces or join as an agent. The custody
# key reference is opaque (env: scheme for Phase-4) — the raw key is
# never persisted, never logged, never returned in responses.
# ---------------------------------------------------------------------------


@router.post(
    "/bots",
    response_model=DeveloperBotResponse,
    status_code=status.HTTP_201_CREATED,
)
async def register_developer_bot(
    body: DeveloperBotCreate,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperBotResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_bots_rate:{verified_key.key_id}",
        limit=_DEVELOPER_BOTS_RATE_LIMIT,
        window_seconds=_DEVELOPER_BOTS_RATE_WINDOW,
        response=response,
    )

    count = await db.scalar(
        select(func.count(DeveloperAppBot.id)).where(
            DeveloperAppBot.app_id == verified_key.app_id,
            DeveloperAppBot.is_active.is_(True),
        )
    )
    if count is not None and count >= _MAX_BOTS_PER_APP:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"This app already has {_MAX_BOTS_PER_APP} active bots. "
                "Deactivate one before registering another."
            ),
        )

    # Legacy custody_env bots point at a server-side secret by name, so they
    # are admin-provisioned only (and further gated by the
    # DEVELOPER_CUSTODY_KEY_REFS allowlist at mint time). Self-serve
    # registration always provisions a managed app_key signer.
    if not body.is_managed_signer:
        logger.warning(
            "developer_bot_custody_mode_refused app_id=%s key_id=%s",
            verified_key.app_id,
            verified_key.key_id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Custody-key bots are not available via self-serve "
                "registration. Omit custody_address and custody_key_ref to "
                "register a managed signer."
            ),
        )

    bot = DeveloperAppBot(
        app_id=verified_key.app_id,
        fid=body.fid,
        label=body.label,
        is_active=True,
        auth_mode=AUTH_MODE_APP_KEY,
    )
    db.add(bot)

    # Flush first so the client-side-defaulted ``bot.id`` is settled and
    # bound as AAD when the private key is encrypted. The row is NOT
    # committed until the signer is provisioned — a Neynar failure rolls
    # the whole insert back so no orphan (keyless) bot row survives.
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=("A bot with this fid is already registered to this app."),
        )
    try:
        await provision_bot_signer(db, bot)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=("A bot with this fid is already registered to this app."),
        )
    except (BotSignerConfigError, BotSignerCryptoError) as exc:
        # Server-side misconfiguration (missing/invalid encryption key).
        # Opaque 503 — never confirm which knob is wrong.
        await db.rollback()
        logger.error(
            "bot signer provisioning failed (config/crypto) app_id=%s "
            "key_id=%s err=%s",
            verified_key.app_id,
            verified_key.key_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot signer provisioning is temporarily unavailable.",
        ) from exc
    except httpx.HTTPError as exc:
        # Upstream (Neynar) registration failed — no row persisted.
        # Actionable but non-leaky: the partner can retry.
        await db.rollback()
        logger.warning(
            "bot signer registration upstream failure app_id=%s key_id=%s " "err=%s",
            verified_key.app_id,
            verified_key.key_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to register the bot signer with Farcaster. Retry shortly.",
        ) from exc

    # Audit log. We log the fid + label but NOT the custody_key_ref or any
    # signer key material (the scheme prefix is innocuous but logging it
    # normalizes the field as "loggable" — keep that surface tight).
    logger.info(
        "developer_bot_registered app_id=%s key_id=%s bot_id=%s fid=%s "
        "auth_mode=%s label=%r",
        verified_key.app_id,
        verified_key.key_id,
        bot.id,
        bot.fid,
        bot.auth_mode,
        bot.label,
    )
    return _bot_response(bot)


@router.get(
    "/bots",
    response_model=DeveloperBotListResponse,
)
async def list_developer_bots(
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperBotListResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_bots_read_rate:{verified_key.key_id}",
        limit=_DEVELOPER_READ_RATE_LIMIT,
        window_seconds=_DEVELOPER_READ_RATE_WINDOW,
        response=response,
    )
    result = await db.execute(
        select(DeveloperAppBot)
        .where(DeveloperAppBot.app_id == verified_key.app_id)
        .order_by(DeveloperAppBot.created_at.desc())
    )
    return DeveloperBotListResponse(
        bots=[_bot_response(row) for row in result.scalars().all()]
    )


@router.get(
    "/bots/{bot_id}",
    response_model=DeveloperBotResponse,
)
async def get_developer_bot(
    bot_id: UUID,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperBotResponse:
    """Poll a single bot's current state, including the managed-signer
    approval status.

    Ownership-scoped: cross-app or unknown ids both return an opaque 404
    (no enumeration oracle). For managed (``app_key``) bots this lazily
    reconciles the signer status with Neynar — the service's internal
    recheck cache (30s pending / 24h approved) makes tight polling safe.
    A transient upstream (Neynar) blip must NOT fail a status poll, so an
    httpx error degrades to serving the stale DB row.
    """
    await _enforce_rate_limit(
        redis,
        key=f"developer_bots_read_rate:{verified_key.key_id}",
        limit=_DEVELOPER_READ_RATE_LIMIT,
        window_seconds=_DEVELOPER_READ_RATE_WINDOW,
        response=response,
    )
    result = await db.execute(
        select(DeveloperAppBot).where(
            DeveloperAppBot.id == bot_id,
            DeveloperAppBot.app_id == verified_key.app_id,
        )
    )
    bot = result.scalar_one_or_none()
    if bot is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Bot not found",
        )
    try:
        await refresh_bot_signer_status(db, bot)
    except (httpx.HTTPError, HypersnapError) as exc:
        # Serve the stale row — a poll shouldn't 502 because Hypersnap
        # blipped. Log the exception TYPE ONLY (no message, which could
        # echo an upstream URL / detail).
        logger.warning(
            "bot signer status refresh degraded (serving stale) bot_id=%s " "err=%s",
            bot.id,
            type(exc).__name__,
        )
    return _bot_response(bot)


@router.post(
    "/bots/{bot_id}/signer",
    response_model=DeveloperBotResponse,
)
async def reregister_developer_bot_signer(
    bot_id: UUID,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperBotResponse:
    """Re-register a bot's managed signer with a FRESH Ed25519 keypair.

    Recovery path for a signer that can never be approved as-is: the 24h
    ``SignedKeyRequest`` deadline lapsed, the key was revoked on-chain, or
    it was approved under the wrong FID (``fid_mismatch``). Generates a new
    keypair, registers it with Neynar, and resets the signer to
    ``pending_approval`` with a fresh ``approval_url``.

    Ownership-scoped (opaque 404). ``provision_bot_signer`` re-populates
    every signer field and sets ``auth_mode="app_key"``; on any failure the
    session is rolled back so the prior signer state is preserved.
    """
    await _enforce_rate_limit(
        redis,
        key=f"developer_bots_rate:{verified_key.key_id}",
        limit=_DEVELOPER_BOTS_RATE_LIMIT,
        window_seconds=_DEVELOPER_BOTS_RATE_WINDOW,
        response=response,
    )
    result = await db.execute(
        select(DeveloperAppBot).where(
            DeveloperAppBot.id == bot_id,
            DeveloperAppBot.app_id == verified_key.app_id,
        )
    )
    bot = result.scalar_one_or_none()
    if bot is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Bot not found",
        )
    try:
        await provision_bot_signer(db, bot)
    except (BotSignerConfigError, BotSignerCryptoError) as exc:
        await db.rollback()
        logger.error(
            "bot signer re-provisioning failed (config/crypto) app_id=%s "
            "key_id=%s bot_id=%s err=%s",
            verified_key.app_id,
            verified_key.key_id,
            bot_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot signer provisioning is temporarily unavailable.",
        ) from exc
    except httpx.HTTPError as exc:
        await db.rollback()
        logger.warning(
            "bot signer re-registration upstream failure app_id=%s key_id=%s "
            "bot_id=%s err=%s",
            verified_key.app_id,
            verified_key.key_id,
            bot_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to register the bot signer with Farcaster. Retry shortly.",
        ) from exc
    logger.info(
        "developer_bot_signer_reregistered app_id=%s key_id=%s bot_id=%s fid=%s",
        verified_key.app_id,
        verified_key.key_id,
        bot.id,
        bot.fid,
    )
    return _bot_response(bot)


@router.delete(
    "/bots/{bot_id}",
    response_model=StatusResponse,
)
async def deactivate_developer_bot(
    bot_id: UUID,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> StatusResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_bots_rate:{verified_key.key_id}",
        limit=_DEVELOPER_BOTS_RATE_LIMIT,
        window_seconds=_DEVELOPER_BOTS_RATE_WINDOW,
        response=response,
    )
    result = await db.execute(
        select(DeveloperAppBot).where(
            DeveloperAppBot.id == bot_id,
            DeveloperAppBot.app_id == verified_key.app_id,
        )
    )
    bot = result.scalar_one_or_none()
    if bot is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Bot not found",
        )
    # Deactivating also purges any managed-signer private key material —
    # a deactivated bot can never mint again, so there's no reason to keep
    # the encrypted blob at rest. Also purge for an already-inactive row
    # that predates this behavior (defense-in-depth key hygiene).
    if bot.is_active or bot.signer_private_key_encrypted is not None:
        bot.is_active = False
        bot.signer_private_key_encrypted = None
        await db.commit()
        logger.info(
            "developer_bot_deactivated app_id=%s key_id=%s bot_id=%s " "fid=%s",
            verified_key.app_id,
            verified_key.key_id,
            bot.id,
            bot.fid,
        )
    return StatusResponse(status="deactivated")


# ---------------------------------------------------------------------------
# Outbound webhook subscriptions
#
# Subscriptions are scoped to the developer app derived from the API key
# (``verified_key.app_id``). Cross-app reads/writes are impossible by
# construction: the route never accepts an ``app_id`` parameter.
# ---------------------------------------------------------------------------

_MAX_WEBHOOKS_PER_APP = 5


def _webhook_response_fields(webhook: DeveloperWebhook) -> dict:
    """Public fields only: coarse outcome categories, never the raw status
    code (``last_status`` is always null) or an unvetted error string."""
    return {
        "id": webhook.id,
        "app_id": webhook.app_id,
        "url": webhook.url,
        "events": list(webhook.events or []),
        "last_delivery_at": webhook.last_delivery_at,
        "last_outcome": public_webhook_outcome(webhook),
        "last_status": None,
        "last_error": public_webhook_error(webhook.last_error),
        "created_at": webhook.created_at,
    }


def _webhook_response(webhook: DeveloperWebhook) -> DeveloperWebhookResponse:
    return DeveloperWebhookResponse(**_webhook_response_fields(webhook))


@router.post(
    "/webhooks",
    response_model=DeveloperWebhookCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_developer_webhook(
    body: DeveloperWebhookCreate,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperWebhookCreateResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_webhook_create_rate:{verified_key.key_id}",
        limit=_MUTATION_RATE_LIMIT,
        window_seconds=_MUTATION_RATE_WINDOW,
        response=response,
    )
    count = await db.scalar(
        select(func.count(DeveloperWebhook.id)).where(
            DeveloperWebhook.app_id == verified_key.app_id
        )
    )
    if count is not None and count >= _MAX_WEBHOOKS_PER_APP:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"This app already has {_MAX_WEBHOOKS_PER_APP} webhook "
                "subscriptions. Delete an existing one before creating another."
            ),
        )

    secret = generate_webhook_secret()
    # The id is fixed up front because it is the ciphertext's AAD.
    webhook_id = uuid4()
    try:
        stored_secret = encrypt_webhook_secret(webhook_id, secret)
    except SignerKeyConfigError:
        # Fail closed rather than store a plaintext signing secret.
        logger.error("Webhook create refused: secret encryption key not configured")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook subscriptions are temporarily unavailable",
        ) from None
    webhook = DeveloperWebhook(
        id=webhook_id,
        app_id=verified_key.app_id,
        url=body.url,
        secret=stored_secret,
        events=body.events,
    )
    db.add(webhook)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "A webhook with this URL already exists for this app. "
                "Delete it before re-registering."
            ),
        )
    await db.refresh(webhook)

    return DeveloperWebhookCreateResponse(
        **_webhook_response_fields(webhook), secret=secret
    )


@router.get("/webhooks", response_model=DeveloperWebhookListResponse)
async def list_developer_webhooks(
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
) -> DeveloperWebhookListResponse:
    result = await db.execute(
        select(DeveloperWebhook)
        .where(DeveloperWebhook.app_id == verified_key.app_id)
        .order_by(DeveloperWebhook.created_at.desc())
    )
    return DeveloperWebhookListResponse(
        webhooks=[_webhook_response(row) for row in result.scalars().all()]
    )


@router.get(
    "/webhooks/{webhook_id}",
    response_model=DeveloperWebhookResponse,
)
async def get_developer_webhook(
    webhook_id: UUID,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> DeveloperWebhookResponse:
    """Read a single subscription's current state including
    ``last_delivery_at``, ``last_outcome`` and ``last_error`` (coarse
    categories only; ``last_status`` is always null). Cross-app
    subscriptions 404 (no enumeration oracle).
    """
    await _enforce_rate_limit(
        redis,
        key=f"developer_webhook_read_rate:{verified_key.key_id}",
        limit=_DEVELOPER_READ_RATE_LIMIT,
        window_seconds=_DEVELOPER_READ_RATE_WINDOW,
        response=response,
    )
    result = await db.execute(
        select(DeveloperWebhook).where(
            DeveloperWebhook.id == webhook_id,
            DeveloperWebhook.app_id == verified_key.app_id,
        )
    )
    webhook = result.scalar_one_or_none()
    if webhook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook not found",
        )
    return _webhook_response(webhook)


@router.delete(
    "/webhooks/{webhook_id}",
    response_model=StatusResponse,
)
async def delete_developer_webhook(
    webhook_id: UUID,
    response: Response,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
) -> StatusResponse:
    await _enforce_rate_limit(
        redis,
        key=f"developer_webhook_delete_rate:{verified_key.key_id}",
        limit=_MUTATION_RATE_LIMIT,
        window_seconds=_MUTATION_RATE_WINDOW,
        response=response,
    )
    result = await db.execute(
        select(DeveloperWebhook).where(
            DeveloperWebhook.id == webhook_id,
            DeveloperWebhook.app_id == verified_key.app_id,
        )
    )
    webhook = result.scalar_one_or_none()
    if webhook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook not found",
        )
    await db.delete(webhook)
    await db.commit()
    return StatusResponse(status="deleted")


@router.get("/admin/access", response_model=DeveloperUserListResponse)
async def admin_list_developer_access(
    status_filter: str | None = None,
    _admin_fid: int = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperUserListResponse:
    query = select(User)
    if status_filter is not None:
        query = query.where(User.developer_access_status == status_filter)
    query = query.order_by(User.fid.asc())
    result = await db.execute(query)
    application_rows = await db.execute(select(DeveloperApplication))
    applications_by_fid: dict[int, DeveloperApplication] = {}
    for application in application_rows.scalars().all():
        current = applications_by_fid.get(application.fid)
        if current is None or application.created_at > current.created_at:
            applications_by_fid[application.fid] = application
    return DeveloperUserListResponse(
        users=[
            _developer_user_response(
                user,
                applications_by_fid.get(user.fid),
            )
            for user in result.scalars().all()
        ]
    )


@router.post("/admin/access/{fid}", response_model=DeveloperUserResponse)
async def admin_set_developer_access(
    fid: int,
    body: DeveloperAccessUpdate,
    _admin_fid: int = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperUserResponse:
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found.",
        )
    user.developer_access_status = body.status
    application = await _latest_application(db, fid)
    if application is not None:
        application.status = "pending" if body.status == "none" else body.status
        application.reviewed_by_fid = _admin_fid
        application.reviewed_at = datetime.now(tz=timezone.utc)
    await db.commit()
    await db.refresh(user)
    if application is not None:
        await db.refresh(application)
    return _developer_user_response(user, application)
