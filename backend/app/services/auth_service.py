import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.config import settings
from app.models.user import SIGNER_STATUS_NONE, User


async def fetch_user_profile(fid: int) -> dict:
    """Fetch a user's profile from Hypersnap's ``/user/bulk`` by FID.

    Raises ``ValueError`` when the FID has no profile and
    ``hypersnap.HypersnapError`` on upstream failure.
    """
    data = await hypersnap.get("/user/bulk", {"fids": str(fid)})
    users = data.get("users") or []
    if not users:
        raise ValueError(f"User with FID {fid} not found")
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


def create_partner_jwt(
    *, fid: int, partner_app_id: str, ttl_seconds: int
) -> tuple[str, str]:
    """Mint a short-lived Juke JWT on behalf of a trusted developer app.

    Used by ``POST /v1/developer/partner-tokens`` to let an approved
    partner (zaoos.com, etc.) skip the SIWF dance inside an iframe when
    their visitor already signed in on the parent site. The trust model
    is: the partner holds a valid Juke API key + an active developer app
    with a matching ``allowed_origins`` entry, so we accept their
    assertion of who the user is. Damage is bounded by:

    - hard TTL cap enforced upstream (≤ 10 min)
    - ``partner_app_id`` baked into the JWT so a leaked token is
      traceable to the issuing app at audit time
    - ``source="partner"`` claim so sensitive routes (dashboard ops,
      key reveal, application status mutations, etc.) can refuse to
      honor partner-minted JWTs even when the bearer matches the owner
    - no refresh token: when the token expires the visitor either re-mints
      via the partner or falls back to SIWF inside the embed

    Returns ``(token, expires_at_iso)``.
    """
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=ttl_seconds)
    payload = {
        "fid": fid,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
        "partner_app_id": partner_app_id,
        "source": "partner",
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


async def consume_refresh_token(token: str, redis: aioredis.Redis) -> int | None:
    """Atomically take (GETDEL) a refresh token, returning the FID it
    belonged to (or None if invalid). Used when the caller doesn't yet
    know the FID (e.g. cold-start refresh with no bearer JWT).

    One round trip, so two concurrent consumers (a refresh racing another
    refresh or a logout) can't both observe the fid: exactly one wins.
    """
    token_hash = _hash_token(token)
    stored_fid = await redis.getdel(f"refresh_token:{token_hash}")
    if stored_fid is None:
        return None
    try:
        return int(stored_fid)
    except (TypeError, ValueError):
        return None


async def get_or_create_user(
    db: AsyncSession,
    fid: int,
    profile: dict,
    *,
    signer_status: str | None = None,
) -> User:
    """Get or create the user row for ``fid`` and refresh profile fields.

    ``signer_status`` is written only when given; sign-in paths that do not
    add a signer leave an existing user's signer state untouched.
    """
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()

    if user:
        user.username = profile.get("username", user.username)
        user.display_name = profile.get("display_name", user.display_name)
        user.pfp_url = profile.get("pfp_url", user.pfp_url)
        user.custody_address = profile.get("custody_address", user.custody_address)
        if signer_status is not None:
            user.signer_status = signer_status
    else:
        user = User(
            fid=fid,
            username=profile.get("username"),
            display_name=profile.get("display_name"),
            pfp_url=profile.get("pfp_url"),
            custody_address=profile.get("custody_address"),
            signer_status=signer_status or SIGNER_STATUS_NONE,
        )
        db.add(user)

    await db.commit()
    await db.refresh(user)
    return user
