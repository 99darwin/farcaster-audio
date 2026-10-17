import logging
from typing import TYPE_CHECKING, Any, AsyncGenerator

import redis.asyncio as aioredis
from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.middleware.auth import (
    get_admin_user,
    get_agent_or_user,
    get_current_user,
    get_optional_current_user,
    require_first_party_user,
)  # re-export
from app.models.user import SIGNER_STATUS_APPROVED, User
from app.services.spam_service import SpamService

if TYPE_CHECKING:
    from app.services.farcaster_spaces_service import FarcasterSpacesService

DEMO_SIGNER_UUID = "demo-readonly"


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session, closing it on exit."""
    async with async_session() as session:
        yield session


async def get_redis(request: Request) -> aioredis.Redis:
    """Return the shared Redis connection pool attached to app state."""
    return request.app.state.redis


def pubsub_redis(app: Any) -> aioredis.Redis:
    """Redis client for websocket pubsub (its own bounded pool).

    Falls back to the command client when no pubsub pool is configured
    (tests, scripts).
    """
    return getattr(app.state, "redis_pubsub", None) or app.state.redis


def get_farcaster_spaces_service(request: Request) -> "FarcasterSpacesService":
    """Process-wide ``FarcasterSpacesService`` (one shared httpx client).

    Built eagerly at lifespan startup; tests using ASGITransport without
    the startup hook get one created lazily here.
    """
    from app.services.farcaster_spaces_service import FarcasterSpacesService

    service = getattr(request.app.state, "farcaster_spaces_service", None)
    if service is None:
        service = FarcasterSpacesService(settings)
        request.app.state.farcaster_spaces_service = service
    return service


async def get_spam_service(
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> SpamService:
    """Provide a SpamService instance with DB and Redis dependencies."""
    return SpamService(db, redis)


async def require_developer_api_key(
    request: Request,
    x_juke_api_key: str | None = Header(None, alias="X-Juke-Api-Key"),
    db: AsyncSession = Depends(get_db),
):
    """Require an active Juke developer API key.

    The key is a true machine credential — no user JWT is consulted. The
    owning fid is derived from the key's app row by verify_developer_api_key.
    All authentication failures collapse into the same opaque 401 string
    ("Invalid Juke API key.") to avoid leaking which check tripped.
    """
    from app.services.developer_key_service import (
        INVALID_API_KEY_DETAIL,
        verify_developer_api_key,
    )

    if not x_juke_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=INVALID_API_KEY_DETAIL,
        )
    # Pass the Origin header through so verify_developer_api_key can enforce
    # the app's allowed_origins list for browser-originated requests.
    origin_header = request.headers.get("origin")
    verified = await verify_developer_api_key(
        db,
        raw_secret_key=x_juke_api_key,
        method=request.method,
        path=request.url.path,
        origin=origin_header,
    )
    request.state.developer_api_key = verified
    log_developer_key_use(request, verified)
    return verified


# Dedicated logger so audit lines can be routed/retained separately.
developer_audit_logger = logging.getLogger("juke.audit.developer_api")


def log_developer_key_use(request: Request, verified) -> None:
    """One structured line per key-authenticated request.

    Identifiers only (the key's public ``key_id``, never the secret), plus
    the ``audit_hmac`` tag over method/path/fid/key_id so a tampered line
    is detectable by anyone holding ``JUKE_API_AUDIT_SECRET``. The path
    excludes the query string.
    """
    fields = {
        "method": request.method,
        "path": request.url.path,
        "fid": verified.fid,
        "app_id": str(verified.app_id),
        "key_id": verified.key_id,
        "audit_hmac": verified.audit_hmac,
    }
    # Rendered as key=value for the plain-text formatter; also attached as
    # record attributes for structured handlers.
    developer_audit_logger.info(
        "developer_api_request %s",
        " ".join(f"{name}={value}" for name, value in fields.items()),
        extra={"audit_event": "developer_api_request", **fields},
    )


async def require_recent_siwn(
    fid: int = Depends(require_first_party_user),
    redis: aioredis.Redis = Depends(get_redis),
) -> int:
    """Require a recent SIWN re-authentication for dangerous mutations.

    Step-up protection for routes that, if invoked from a hijacked refresh
    cookie or stolen long-lived JWT, would let an attacker pivot to credential
    theft (rotate/reveal a secret) or denial of service (revoke a key, delete
    an app). The client surfaces the 401 + WWW-Authenticate header by
    re-running the Neynar SIWN flow rather than the silent refresh path.

    Partner-minted JWTs (``source="partner"``) are rejected at the
    ``require_first_party_user`` layer, so the Redis recency check below
    is unreachable for them — fail-fast on the cheaper signal.
    """
    from app.services.redis_service import RedisService

    if not await RedisService(redis).has_recent_siwn(fid):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Recent sign-in required.",
            headers={"WWW-Authenticate": "ReAuth"},
        )
    return fid


DEMO_USER_FID = 1  # dev_login() issues JWTs scoped to this fid only


async def require_non_demo_user(
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
) -> int:
    """
    Reject writes from the shared demo-readonly signer in non-development environments.
    The demo login issues a JWT for a real FID (currently @farcaster) with
    signer_status="demo" so anyone can explore the app without signing in,
    but they shouldn't be able to post content or create rooms that
    attribute to that FID.

    Also rejects partner-minted JWTs (via ``require_first_party_user``):
    user-attributed writes like room creation, recording start, etc.
    must originate from the user's own session, not from an iframe-host
    bearer that the user only consented to for in-room participation.
    """
    if settings.ENVIRONMENT == "development":
        return fid
    # The demo login only ever issues JWTs for DEMO_USER_FID, so any other fid
    # cannot be the demo signer. Skip the DB read on the hot path.
    if fid != DEMO_USER_FID:
        return fid
    result = await db.execute(select(User.signer_status).where(User.fid == fid))
    signer_status = result.scalar_one_or_none()
    if signer_status is None:
        # Valid JWT for a fid that no longer exists — fail closed.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )
    # fid=1 may only write once its owner has added a real app signer
    # (``signer_status == "approved"``); the demo session is ``"demo"``.
    if signer_status != SIGNER_STATUS_APPROVED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sign in with Farcaster to post or host.",
        )
    return fid


__all__ = [
    "get_db",
    "get_redis",
    "pubsub_redis",
    "get_current_user",
    "get_admin_user",
    "get_agent_or_user",
    "get_optional_current_user",
    "get_spam_service",
    "require_developer_api_key",
    "require_non_demo_user",
    "require_recent_siwn",
    "DEMO_SIGNER_UUID",
    "DEMO_USER_FID",
]
