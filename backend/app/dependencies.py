import uuid
from typing import AsyncGenerator

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
)  # re-export
from app.models.user import User
from app.services.spam_service import SpamService

DEMO_SIGNER_UUID = "demo-readonly"


def _is_valid_neynar_signer(signer_uuid: str | None) -> bool:
    """A real Neynar signer is a UUIDv4 string. Any sentinel/legacy value
    (demo-readonly, dev-signer, etc.) won't parse as a UUID."""
    if not signer_uuid:
        return False
    try:
        uuid.UUID(signer_uuid)
    except (ValueError, TypeError, AttributeError):
        return False
    return True


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session, closing it on exit."""
    async with async_session() as session:
        yield session


async def get_redis(request: Request) -> aioredis.Redis:
    """Return the shared Redis connection pool attached to app state."""
    return request.app.state.redis


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
    return verified


async def require_recent_siwn(
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
) -> int:
    """Require a recent SIWN re-authentication for dangerous mutations.

    Step-up protection for routes that, if invoked from a hijacked refresh
    cookie or stolen long-lived JWT, would let an attacker pivot to credential
    theft (rotate/reveal a secret) or denial of service (revoke a key, delete
    an app). The client surfaces the 401 + WWW-Authenticate header by
    re-running the Neynar SIWN flow rather than the silent refresh path.
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
    fid: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> int:
    """
    Reject writes from the shared demo-readonly signer in non-development environments.
    The demo login issues a JWT for a real FID (currently @farcaster) with a sentinel
    signer_uuid so anyone can explore the app without signing in — but they shouldn't
    be able to post content or create rooms that attribute to that FID.
    """
    if settings.ENVIRONMENT == "development":
        return fid
    # The demo login only ever issues JWTs for DEMO_USER_FID, so any other fid
    # cannot be the demo signer. Skip the DB read on the hot path.
    if fid != DEMO_USER_FID:
        return fid
    result = await db.execute(select(User.signer_uuid).where(User.fid == fid))
    signer_uuid = result.scalar_one_or_none()
    if signer_uuid is None:
        # Valid JWT for a fid that no longer exists — fail closed.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )
    # Any non-UUID signer for fid=1 is a demo/legacy sentinel (demo-readonly,
    # dev-signer, etc.) and cannot actually cast to Neynar anyway. If @farcaster
    # themselves sign in via SIWN, they'll have a real Neynar UUIDv4 signer.
    if not _is_valid_neynar_signer(signer_uuid):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sign in with Farcaster to post or host.",
        )
    return fid


__all__ = [
    "get_db",
    "get_redis",
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
    "_is_valid_neynar_signer",
]
