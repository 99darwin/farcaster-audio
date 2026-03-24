import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import httpx
import redis.asyncio as aioredis
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User


async def verify_neynar_signer(signer_uuid: str, expected_fid: int) -> dict:
    """Verify a signer_uuid with Neynar API. Returns signer data if valid.

    Raises ValueError if the signer's fid does not match expected_fid.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://api.neynar.com/v2/farcaster/signer",
            params={"signer_uuid": signer_uuid},
            headers={"api_key": settings.NEYNAR_API_KEY},
        )
        resp.raise_for_status()
        data = resp.json()
        signer_fid = data.get("fid")
        if signer_fid != expected_fid:
            raise ValueError(
                f"Signer fid {signer_fid} does not match expected fid {expected_fid}"
            )
        return data


async def fetch_user_profile(fid: int) -> dict:
    """Fetch user profile from Neynar by FID."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://api.neynar.com/v2/farcaster/user/bulk",
            params={"fids": str(fid)},
            headers={"api_key": settings.NEYNAR_API_KEY},
        )
        resp.raise_for_status()
        data = resp.json()
        users = data.get("users", [])
        if not users:
            raise ValueError(f"User with FID {fid} not found on Neynar")
        return users[0]


def create_jwt(fid: int) -> tuple[str, str]:
    """Create JWT + expiry string for the given FID."""
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=settings.JWT_EXPIRY_HOURS)
    payload = {
        "fid": fid,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return token, expires_at.isoformat()


def _hash_token(token: str) -> str:
    """Return hex SHA-256 hash of a token."""
    return hashlib.sha256(token.encode()).hexdigest()


async def create_refresh_token(fid: int, redis: aioredis.Redis) -> str:
    """Generate a cryptographically random refresh token and store its hash in Redis."""
    token = f"rt_{secrets.token_urlsafe(48)}"
    token_hash = _hash_token(token)
    ttl_seconds = settings.JWT_REFRESH_EXPIRY_DAYS * 86400
    await redis.set(f"refresh_token:{token_hash}", str(fid), ex=ttl_seconds)
    return token


async def verify_refresh_token(
    token: str, expected_fid: int, redis: aioredis.Redis
) -> bool:
    """Verify a refresh token against Redis. Deletes the token on use (rotation)."""
    token_hash = _hash_token(token)
    stored_fid = await redis.get(f"refresh_token:{token_hash}")
    if stored_fid is None:
        return False
    if int(stored_fid) != expected_fid:
        return False
    await redis.delete(f"refresh_token:{token_hash}")
    return True


async def get_or_create_user(
    db: AsyncSession, fid: int, signer_uuid: str, profile: dict
) -> User:
    """Get existing user or create new one from Neynar profile data."""
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()

    if user:
        user.signer_uuid = signer_uuid
        user.username = profile.get("username", user.username)
        user.display_name = profile.get("display_name", user.display_name)
        user.pfp_url = profile.get("pfp_url", user.pfp_url)
        user.custody_address = profile.get("custody_address", user.custody_address)
    else:
        user = User(
            fid=fid,
            signer_uuid=signer_uuid,
            username=profile.get("username"),
            display_name=profile.get("display_name"),
            pfp_url=profile.get("pfp_url"),
            custody_address=profile.get("custody_address"),
        )
        db.add(user)

    await db.commit()
    await db.refresh(user)
    return user
