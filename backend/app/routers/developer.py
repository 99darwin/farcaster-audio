from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import (
    get_db,
    get_redis,
    require_developer_api_key,
    require_recent_siwn,
)
from app.middleware.auth import get_admin_user, get_current_user
from app.models.developer import DeveloperApiKey, DeveloperApp, DeveloperApplication
from app.models.user import User
from app.schemas.common import StatusResponse
from app.schemas.developer import (
    DeveloperAccessUpdate,
    DeveloperAppCreate,
    DeveloperAppListResponse,
    DeveloperAppResponse,
    DeveloperAppUpdate,
    DeveloperApplicationResponse,
    DeveloperKeyCreate,
    DeveloperKeyListResponse,
    DeveloperKeyResponse,
    DeveloperKeyRevealRequest,
    DeveloperKeyRevealResponse,
    DeveloperApplicationRequest,
    DeveloperSpaceCreate,
    DeveloperStatusResponse,
    DeveloperUserListResponse,
    DeveloperUserResponse,
)
from app.schemas.room import RoomCreateResponse
from app.services.developer_key_service import (
    VerifiedDeveloperKey,
    clear_expired_reveal_blob,
    create_api_key,
    get_owned_app,
    require_approved_developer,
    reveal_api_key_once,
)
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService
from app.services.room_service import RoomService

router = APIRouter(prefix="/v1/developer", tags=["developer"])

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


async def _enforce_rate_limit(
    redis,
    *,
    key: str,
    limit: int,
    window_seconds: int,
) -> None:
    """Raise HTTP 429 with Retry-After if `key` exceeds `limit` in `window_seconds`."""
    service = RedisService(redis)
    allowed, retry_after = await service.check_rate_limit(key, limit, window_seconds)
    if allowed:
        return
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Rate limit exceeded. Try again later.",
        headers={"Retry-After": str(retry_after)},
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
    fid: int = Depends(get_current_user),
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
    fid: int = Depends(get_current_user),
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
    fid: int = Depends(get_current_user),
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
    fid: int = Depends(get_current_user),
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
    fid: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeveloperApp:
    await require_approved_developer(db, fid)
    return await get_owned_app(db, fid, app_id)


@router.patch("/apps/{app_id}", response_model=DeveloperAppResponse)
async def update_app(
    app_id: UUID,
    body: DeveloperAppUpdate,
    fid: int = Depends(get_current_user),
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
    fid: int = Depends(get_current_user),
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


@router.post(
    "/apps/{app_id}/keys",
    response_model=DeveloperKeyResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_key(
    app_id: UUID,
    body: DeveloperKeyCreate,
    fid: int = Depends(get_current_user),
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


@router.post(
    "/spaces",
    response_model=RoomCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_developer_space(
    body: DeveloperSpaceCreate,
    verified_key: VerifiedDeveloperKey = Depends(require_developer_api_key),
    room_service: RoomService = Depends(get_developer_room_service),
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
    )
    scheduled_at = _parse_scheduled_at(body.scheduled_at)
    return await room_service.create_room(
        fid=verified_key.fid,
        title=body.title,
        announce_cast=body.announce_cast,
        scheduled_at=scheduled_at,
        allow_agents=body.allow_agents,
        created_by_app_id=verified_key.app_id,
    )


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
