import logging
import re
import time

from eth_account.messages import encode_defunct
from eth_account import Account
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from jose import JWTError, jwt
from pydantic import BaseModel
from siwe import SiweMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import httpx
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

from app.config import settings
from app.dependencies import get_db, get_redis
from app.models.user import User
from app.schemas.auth import (
    InvalidateAuthAddressRequest,
    LoginRequest,
    LoginResponse,
    RefreshRequest,
    RegisterAuthAddressRequest,
    RegisterAuthAddressResponse,
    AuthAddressStatusResponse,
    SiwfLoginRequest,
    SiwfNonceResponse,
    UserResponse,
)
from app.services.auth_service import (
    create_jwt,
    create_refresh_token,
    fetch_user_profile,
    get_or_create_user,
    verify_neynar_signer,
    verify_refresh_token,
)
from app.services.auth_address_service import (
    generate_signed_key_request,
    get_auth_address_status_cached,
    mark_auth_address_revoked,
    register_auth_address_with_neynar,
    upsert_auth_address_from_registration,
)
from app.services.siwf_service import (
    consume_siwf_nonce,
    lookup_fid_by_custody,
    mint_siwf_nonce,
    verify_siwf_message,
)
from app.dependencies import DEMO_SIGNER_UUID, get_current_user, require_non_demo_user

router = APIRouter(prefix="/v1/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Proxy-aware client IP
# ---------------------------------------------------------------------------


def _client_ip(request: Request) -> str:
    """Best-effort real client IP behind Railway's L7 proxy.

    Reads the leftmost `X-Forwarded-For` entry first, then `X-Real-IP`,
    then the raw socket peer. The leftmost XFF value is the originating
    client as documented by RFC 7239 / MDN; subsequent values are the
    chain of intermediate proxies.

    We deliberately parse these headers in-process rather than enabling
    uvicorn's `ProxyHeadersMiddleware`: that middleware's own threat
    model around `forwarded-allow-ips` adds attack surface (mis-trusting
    a proxy IP would let a client forge their own source). Doing it here
    keeps the trust decision explicit and scoped to rate-limit keys.
    """
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        first = forwarded_for.split(",")[0].strip()
        if first:
            return first
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


# ---------------------------------------------------------------------------
# Refresh-token cookie helpers
# ---------------------------------------------------------------------------
#
# The dashboard at juke.audio opts into cookie-based refresh by sending
# `use_cookie=true` on login. The cookie is scoped to `/v1/auth` so it's only
# ever sent on auth endpoints, HttpOnly so JS can't read it, and (in prod)
# Domain=.juke.audio so it covers your-api-host.example.com across the subdomain.

REFRESH_COOKIE_NAME = "juke_refresh"
REFRESH_COOKIE_PATH = "/v1/auth"


def _refresh_cookie_max_age() -> int:
    return settings.JWT_REFRESH_EXPIRY_DAYS * 86400


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Attach the rotating refresh token as an HttpOnly cookie."""
    is_prod = settings.ENVIRONMENT == "production"
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=_refresh_cookie_max_age(),
        path=REFRESH_COOKIE_PATH,
        domain=".juke.audio" if is_prod else None,
        secure=is_prod,
        httponly=True,
        samesite="lax",
    )


# Sentinel `signer_uuid` for users who authed via SIWF (Sign In With
# Farcaster). SIWF proves FID ownership but doesn't grant write access
# — there's no Neynar signer attached. Same shape as the miniapp Quick
# Auth flow's read-only sessions.
SIWF_SENTINEL_SIGNER_UUID = "siwf-auth"


def _clear_refresh_cookie(response: Response) -> None:
    """Expire the refresh cookie. Attributes must match the original set."""
    is_prod = settings.ENVIRONMENT == "production"
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value="",
        max_age=0,
        path=REFRESH_COOKIE_PATH,
        domain=".juke.audio" if is_prod else None,
        secure=is_prod,
        httponly=True,
        samesite="lax",
    )


@router.post("/dev-login", response_model=LoginResponse)
async def dev_login(
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Demo login: issue a real JWT for a demo user. Controlled by DEMO_LOGIN_ENABLED."""
    if not settings.DEMO_LOGIN_ENABLED and settings.ENVIRONMENT != "development":
        raise HTTPException(status_code=404, detail="Not found")

    fid = 1
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if not user:
        # Fetch real profile from Neynar for a realistic review experience
        try:
            profile = await fetch_user_profile(fid)
            user = User(
                fid=fid,
                username=profile.get("username", "farcaster"),
                display_name=profile.get("display_name", "Farcaster"),
                pfp_url=profile.get("pfp_url"),
                signer_uuid=DEMO_SIGNER_UUID,
            )
        except Exception:
            user = User(
                fid=fid,
                username="farcaster",
                display_name="Farcaster",
                signer_uuid=DEMO_SIGNER_UUID,
            )
        db.add(user)
        await db.commit()
        await db.refresh(user)

    jwt_token, expires_at = create_jwt(user.fid)
    refresh_token = await create_refresh_token(user.fid, redis)

    return LoginResponse(
        jwt=jwt_token,
        refresh_token=refresh_token,
        expires_at=expires_at,
        user=UserResponse(
            fid=user.fid,
            username=user.username or "",
            display_name=user.display_name or "",
            pfp_url=user.pfp_url,
            custody_address=user.custody_address,
            is_admin=False,  # demo users never get admin access
        ),
    )


@router.post("/siwf/nonce", response_model=SiwfNonceResponse)
async def siwf_nonce(
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
):
    """Issue a fresh nonce for a SIWF (Sign In With Farcaster) attempt.

    The client passes this verbatim into the SIWE message it generates
    via `@farcaster/auth-client`. The user signs the message in their
    Farcaster client (which displays the requesting `domain` field —
    that's what makes SIWF phishing-resistant in a way the legacy
    managed-signer flow couldn't be). The signed message + signature
    are submitted to `/v1/auth/siwf/login` for verification.

    Rate-limited per IP so a nonce-fetch loop can't burn Redis.
    """
    ip = _client_ip(request)
    rate_key = f"siwf_nonce_rate:{ip}"
    attempts = await redis.incr(rate_key)
    if attempts == 1:
        await redis.expire(rate_key, 60)
    if attempts > 30:
        retry_after = await redis.ttl(rate_key)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many sign-in attempts. Try again shortly.",
            headers={"Retry-After": str(max(int(retry_after or 60), 1))},
        )

    nonce = await mint_siwf_nonce(redis)
    return SiwfNonceResponse(nonce=nonce)


@router.post("/siwf/login", response_model=LoginResponse)
async def siwf_login(
    body: SiwfLoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Verify a SIWF signature and mint a Juke JWT.

    Wire shape (per `@farcaster/auth-client` watchStatus completion):
    the client receives `{message, signature, nonce, fid, ...}` from
    the Farcaster auth relay, then POSTs `{message, signature, nonce}`
    here. We:

    1. Confirm the nonce was issued by us and isn't already consumed
       (atomic delete-if-exists in Redis).
    2. Verify the SIWE message + EIP-191 signature with `siwe`
       (checks signature validity, domain match, nonce match,
       timestamps). On any failure → 401 with a generic detail; we
       don't leak which check failed.
    3. Resolve the recovered custody address → Farcaster FID via
       Neynar's bulk-by-address endpoint. We do NOT trust a
       client-supplied FID — the FID is derived server-side from the
       cryptographically-verified address.
    4. Mint JWT + (optional) HttpOnly refresh cookie, mark a recent
       SIWN for step-up auth on developer-key mutations.

    Same per-IP rate limit as `/v1/auth/login` so this endpoint is
    bounded against credential-stuffing-style attempts.
    """
    ip = _client_ip(request)
    login_rate_key = f"siwf_login_rate:{ip}"
    attempts = await redis.incr(login_rate_key)
    if attempts == 1:
        await redis.expire(login_rate_key, 60)
    if attempts > 10:
        retry_after = await redis.ttl(login_rate_key)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many sign-in attempts. Try again shortly.",
            headers={"Retry-After": str(max(int(retry_after or 60), 1))},
        )

    # Parse the SIWE message once up front so we know the nonce to
    # check (the message carries its own copy that has to match what
    # we issued).
    try:
        parsed = SiweMessage.from_message(body.message)
        msg_nonce = parsed.nonce
        msg_domain = parsed.domain
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid SIWF message.",
        )

    # Atomic nonce check & consume — concurrent submissions of the
    # same message all collapse to a single successful login.
    if not await consume_siwf_nonce(redis, msg_nonce):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired nonce.",
        )

    # Cryptographic verification. Bound to our domain(s) so a message
    # signed for someone else's app can't be replayed against Juke.
    # SIWF_DOMAIN is a comma-separated allowlist — the message's own
    # domain must match exactly one of the entries.
    allowed_domains = [
        d.strip() for d in (settings.SIWF_DOMAIN or "").split(",") if d.strip()
    ]
    if msg_domain not in allowed_domains:
        logger.warning(
            "siwf_domain_not_allowed",
            extra={"msg_domain": msg_domain, "allowed": allowed_domains},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SIWF domain not allowed.",
        )
    custody = await verify_siwf_message(
        message=body.message,
        signature=body.signature,
        expected_domain=msg_domain,
        expected_nonce=msg_nonce,
    )

    # Resolve custody → fid via Neynar. The recovered address has
    # already been cryptographically tied to the message; this just
    # turns it into a Farcaster identity.
    fid = await lookup_fid_by_custody(custody)
    if fid is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No Farcaster account found for this address.",
        )

    # Profile lookup + user upsert. SIWF doesn't grant write access,
    # so users authenticated this way use the same `siwf-auth`
    # sentinel signer the miniapp Quick Auth flow uses for read-only
    # sessions.
    try:
        profile = await fetch_user_profile(fid)
    except (httpx.HTTPStatusError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    user = await get_or_create_user(db, fid, SIWF_SENTINEL_SIGNER_UUID, profile)

    jwt_token, expires_at = create_jwt(user.fid)
    refresh_token = await create_refresh_token(user.fid, redis)

    # Mark recent SIWN — sign-in completed within the step-up window
    # required for developer-key mutations.
    from app.services.redis_service import RedisService

    await RedisService(redis).mark_siwn(user.fid)

    if body.use_cookie:
        _set_refresh_cookie(response, refresh_token)
        body_refresh_token: str | None = None
    else:
        body_refresh_token = refresh_token

    is_pro = profile.get("pro", {}).get("status") == "subscribed"
    return LoginResponse(
        jwt=jwt_token,
        refresh_token=body_refresh_token,
        expires_at=expires_at,
        user=UserResponse(
            fid=user.fid,
            username=user.username or "",
            display_name=user.display_name or "",
            pfp_url=user.pfp_url,
            custody_address=user.custody_address,
            is_pro=is_pro,
            is_admin=user.is_admin,
        ),
    )


@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Login with Neynar SIWF credentials."""
    # Per-IP rate limit before any other work. Login is the redemption
    # endpoint for the managed-signer flow, so it must not be unrate-limited
    # — otherwise a leaked {fid, signer_uuid} pair from the QR-phishing
    # chain could be replayed without throttling.
    ip = _client_ip(request)
    rate_key = f"login_rate:{ip}"
    attempts = await redis.incr(rate_key)
    if attempts == 1:
        await redis.expire(rate_key, 60)
    if attempts > 10:
        ttl = await redis.ttl(rate_key)
        retry_after = max(int(ttl), 1) if ttl and ttl > 0 else 60
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts. Try again in a minute.",
            headers={"Retry-After": str(retry_after)},
        )

    try:
        await verify_neynar_signer(body.signer_uuid, body.fid, redis=redis)
    except httpx.HTTPStatusError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid signer",
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Signer does not belong to this user",
        )

    try:
        profile = await fetch_user_profile(body.fid)
    except (httpx.HTTPStatusError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    user = await get_or_create_user(db, body.fid, body.signer_uuid, profile)
    is_pro = profile.get("pro", {}).get("status") == "subscribed"

    jwt_token, expires_at = create_jwt(user.fid)
    refresh_token = await create_refresh_token(user.fid, redis)

    # Record a "recent SIWN" marker so step-up-protected developer-key
    # mutations (rotate/revoke/reveal/delete-app) accept this session for
    # a short window. Refresh deliberately does NOT touch this marker —
    # a long-lived session must SIWN again to perform dangerous mutations.
    from app.services.redis_service import RedisService

    await RedisService(redis).mark_siwn(user.fid)

    if body.use_cookie:
        _set_refresh_cookie(response, refresh_token)
        body_refresh_token: str | None = None
    else:
        body_refresh_token = refresh_token

    return LoginResponse(
        jwt=jwt_token,
        refresh_token=body_refresh_token,
        expires_at=expires_at,
        user=UserResponse(
            fid=user.fid,
            username=user.username or "",
            display_name=user.display_name or "",
            pfp_url=user.pfp_url,
            custody_address=user.custody_address,
            is_pro=is_pro,
            is_admin=user.is_admin,
        ),
    )


@router.post("/refresh", response_model=LoginResponse)
async def refresh(
    request: Request,
    response: Response,
    body: RefreshRequest,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Refresh JWT using a refresh token and an (optionally expired) bearer JWT."""

    # Extract FID from the Authorization header even if the JWT has expired.
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
        )

    raw_token = auth_header.removeprefix("Bearer ").strip()

    try:
        payload = jwt.decode(
            raw_token,
            settings.JWT_SECRET,
            algorithms=[settings.JWT_ALGORITHM],
            options={"verify_exp": False},
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not decode token",
        )

    fid: int | None = payload.get("fid")
    if fid is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing FID claim",
        )

    # Cookie wins over body so a dashboard that's transitioned to cookie-based
    # refresh can't accidentally keep leaking a stale body token.
    cookie_token = request.cookies.get(REFRESH_COOKIE_NAME)
    refresh_token_value = cookie_token or body.refresh_token
    refresh_from_cookie = bool(cookie_token)

    if not refresh_token_value:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    if not await verify_refresh_token(refresh_token_value, fid, redis):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    # Fetch fresh profile to get current Pro status
    is_pro = False
    try:
        profile = await fetch_user_profile(user.fid)
        is_pro = profile.get("pro", {}).get("status") == "subscribed"
    except Exception:
        pass

    jwt_token, expires_at = create_jwt(user.fid)
    new_refresh_token = await create_refresh_token(user.fid, redis)

    if refresh_from_cookie:
        _set_refresh_cookie(response, new_refresh_token)
        body_refresh_token: str | None = None
    else:
        body_refresh_token = new_refresh_token

    return LoginResponse(
        jwt=jwt_token,
        refresh_token=body_refresh_token,
        expires_at=expires_at,
        user=UserResponse(
            fid=user.fid,
            username=user.username or "",
            display_name=user.display_name or "",
            pfp_url=user.pfp_url,
            custody_address=user.custody_address,
            is_pro=is_pro,
            is_admin=user.is_admin,
        ),
    )


@router.post("/logout")
async def logout(
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
) -> Response:
    """Clear the `juke_refresh` cookie and revoke any presented refresh token.

    Callable without a bearer — the primary job is clearing the cookie. If
    a refresh token is present in the cookie, we also delete it from Redis
    so it can't be replayed. Logout is idempotent: we never 401 here.
    """
    cookie_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if cookie_token:
        # The refresh_token Redis key is keyed by the hash of the token,
        # not by fid, so we can revoke without parsing the JWT.
        from app.services.auth_service import _hash_token

        await redis.delete(f"refresh_token:{_hash_token(cookie_token)}")

    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_refresh_cookie(response)
    return response


@router.post("/auth-address", response_model=RegisterAuthAddressResponse)
async def register_auth_address(
    body: RegisterAuthAddressRequest,
    fid: int = Depends(require_non_demo_user),
    redis: aioredis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
):
    """Register an auth address for miniapp signIn (SIWF).

    The client generates a secp256k1 keypair and sends the address here.
    We sign the EIP-712 key request with the app's Farcaster account and
    register it with Neynar, which returns an approval URL for the user.
    """
    # Rate limit: max 3 registrations per hour per user
    rate_key = f"auth_addr_rate:{fid}"
    attempts = await redis.incr(rate_key)
    if attempts == 1:
        await redis.expire(rate_key, 3600)  # 1 hour window
    if attempts > 3:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registration attempts. Try again later.",
        )

    if not re.match(r'^0x[0-9a-fA-F]{40}$', body.auth_address):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Ethereum address",
        )

    try:
        signature, deadline = generate_signed_key_request(body.auth_address)
    except ValueError as exc:
        logger.error("Auth address signing failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Auth address signing unavailable",
        )

    try:
        result = await register_auth_address_with_neynar(
            auth_address=body.auth_address,
            signature=signature,
            deadline=deadline,
        )
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Neynar auth address registration failed for fid=%s address=%s: %s",
            fid, body.auth_address, exc.response.text,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Auth address registration failed",
        )

    # Store address -> FID mapping so status checks can verify ownership
    await redis.set(f"auth_addr:{result['address']}", str(fid))

    upstream_status = result.get("status", "pending_approval")
    approval_url = result.get("auth_address_approval_url")

    # Persist to local DB so subsequent status checks don't hit Neynar.
    try:
        await upsert_auth_address_from_registration(
            db=db,
            address=result["address"],
            fid=fid,
            status=upstream_status,
            approval_url=approval_url,
        )
    except Exception as exc:
        logger.exception(
            "Failed to persist auth address for fid=%s: %s", fid, exc
        )

    return RegisterAuthAddressResponse(
        auth_address=result["address"],
        status=upstream_status,
        approval_url=approval_url,
    )


@router.get("/auth-address/status", response_model=AuthAddressStatusResponse)
async def get_auth_address_status(
    address: str,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
):
    """Check whether an auth address has been approved.

    Reads from the local `auth_addresses` table first; only falls through
    to Neynar for missing rows or stale pending entries (>30s old).
    """
    if not re.match(r'^0x[0-9a-fA-F]{40}$', address):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Ethereum address",
        )

    # Verify the requesting user owns this auth address
    owner_fid = await redis.get(f"auth_addr:{address}")
    if owner_fid is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Unknown auth address",
        )
    if int(owner_fid) != fid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Auth address does not belong to this user",
        )

    try:
        result = await get_auth_address_status_cached(db, address)
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Neynar auth address status check failed for fid=%s address=%s: %s",
            fid, address, exc.response.text,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to check auth address status",
        )

    return AuthAddressStatusResponse(
        auth_address=result.get("address", address),
        status=result.get("status", "unknown"),
        fid=result.get("fid"),
    )


@router.post(
    "/auth-address/invalidate", status_code=status.HTTP_204_NO_CONTENT
)
async def invalidate_auth_address(
    body: InvalidateAuthAddressRequest,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Mark an auth address as revoked locally.

    Same authorization pattern as the status endpoint. Lightly rate-limited
    so a malicious client cannot grief the table.
    """
    address = body.auth_address
    if not re.match(r'^0x[0-9a-fA-F]{40}$', address):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Ethereum address",
        )

    rate_key = f"auth_addr_invalidate_rate:{fid}"
    attempts = await redis.incr(rate_key)
    if attempts == 1:
        await redis.expire(rate_key, 3600)
    if attempts > 10:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many invalidate attempts. Try again later.",
        )

    owner_fid = await redis.get(f"auth_addr:{address}")
    if owner_fid is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Unknown auth address",
        )
    if int(owner_fid) != fid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Auth address does not belong to this user",
        )

    await mark_auth_address_revoked(db, address)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Miniapp SIWF token exchange
# ---------------------------------------------------------------------------

import secrets
from datetime import datetime, timedelta, timezone


class MiniAppNonceResponse(BaseModel):
    nonce: str


class MiniAppVerifyRequest(BaseModel):
    message: str
    signature: str
    nonce: str


class MiniAppVerifyResponse(BaseModel):
    token: str
    fid: int


MINIAPP_JWT_EXPIRY_HOURS = 1
MINIAPP_NONCE_TTL_SECONDS = 300  # 5 minutes
MINIAPP_NONCE_PREFIX = "miniapp_nonce:"
MINIAPP_VERIFY_RATE_PREFIX = "miniapp_verify_rate:"
MINIAPP_VERIFY_RATE_LIMIT = 10  # per minute per IP
MINIAPP_VERIFY_RATE_WINDOW = 60


@router.get("/miniapp-nonce", response_model=MiniAppNonceResponse)
async def get_miniapp_nonce(
    redis: aioredis.Redis = Depends(get_redis),
):
    """Generate a server-side nonce for SIWF sign-in."""
    nonce = secrets.token_urlsafe(32)
    await redis.set(f"{MINIAPP_NONCE_PREFIX}{nonce}", "1", ex=MINIAPP_NONCE_TTL_SECONDS)
    return MiniAppNonceResponse(nonce=nonce)


@router.post("/miniapp-verify", response_model=MiniAppVerifyResponse)
async def miniapp_verify(
    body: MiniAppVerifyRequest,
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
):
    """Verify a SIWF credential from a Farcaster miniapp and issue a short-lived JWT.

    The miniapp calls `sdk.actions.signIn({ nonce })` which produces a SIWE-style
    message + signature. We recover the signer address, extract the FID, then
    verify the address is a custody or verified signer for that FID via Neynar.
    """
    # Rate limit by IP
    client_ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else "unknown"
    )
    rate_key = f"{MINIAPP_VERIFY_RATE_PREFIX}{client_ip}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, MINIAPP_VERIFY_RATE_WINDOW)
    count, _ = await pipe.execute()
    if count > MINIAPP_VERIFY_RATE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many verification attempts",
        )

    # Verify nonce was server-issued and consume it (one-time use)
    nonce_key = f"{MINIAPP_NONCE_PREFIX}{body.nonce}"
    consumed = await redis.delete(nonce_key)
    if not consumed:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired nonce",
        )

    # Verify the SIWE signature
    try:
        signable = encode_defunct(text=body.message)
        recovered_address = Account.recover_message(signable, signature=body.signature)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid signature",
        )

    # Verify nonce appears in the signed message (prevents nonce substitution)
    if body.nonce not in body.message:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Nonce mismatch in message",
        )

    # Extract FID from the SIWF message (farcaster://fid/{fid})
    fid_match = re.search(r"farcaster://fid/(\d+)", body.message)
    if not fid_match:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No FID found in message",
        )
    fid = int(fid_match.group(1))

    # Verify the recovered address is a custody or verified address for this FID
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://api.neynar.com/v2/farcaster/user/bulk",
                params={"fids": str(fid)},
                headers={"x-api-key": settings.NEYNAR_API_KEY},
                timeout=10.0,
            )
            resp.raise_for_status()
            users = resp.json().get("users", [])
            if not users:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="FID not found",
                )

            user = users[0]
            custody_address = (user.get("custody_address") or "").lower()
            verified_addresses = [
                a.lower()
                for a in user.get("verified_addresses", {}).get("eth_addresses", [])
            ]
            recovered_lower = recovered_address.lower()

            if recovered_lower != custody_address and recovered_lower not in verified_addresses:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Signer is not authorized for this FID",
                )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to verify FID ownership",
        )

    # Issue a short-lived JWT (1 hour)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=MINIAPP_JWT_EXPIRY_HOURS)
    payload = {
        "fid": fid,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)

    return MiniAppVerifyResponse(token=token, fid=fid)


# --- Farcaster Quick Auth ---------------------------------------------------
#
# Quick Auth (https://miniapps.farcaster.xyz/docs/sdk/quick-auth) is the
# recommended modern auth path for Mini Apps. The client calls
# `sdk.quickAuth.getToken()` which returns a JWT signed by Farcaster's
# auth.farcaster.xyz server. We verify that JWT here (signature via JWKS,
# issuer, audience, expiry) and exchange it for our own short-lived session
# JWT so the rest of the API remains auth-method-agnostic.

_jwks_cache: dict = {"keys": [], "expires_at": 0.0}
QUICKAUTH_JWKS_CACHE_TTL = 3600  # seconds


class QuickAuthVerifyRequest(BaseModel):
    token: str


async def _fetch_quickauth_jwks(force: bool = False) -> list[dict]:
    """Fetch and cache the Farcaster Quick Auth JWKS (1 hour TTL).

    `force=True` bypasses the cache — used when the incoming token has a
    kid that isn't in the cached JWKS, in case keys were rotated.
    """
    now = time.time()
    if not force and _jwks_cache["keys"] and now < _jwks_cache["expires_at"]:
        return _jwks_cache["keys"]
    async with httpx.AsyncClient() as client:
        resp = await client.get(settings.QUICKAUTH_JWKS_URL, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
    keys = data.get("keys", [])
    _jwks_cache["keys"] = keys
    _jwks_cache["expires_at"] = now + QUICKAUTH_JWKS_CACHE_TTL
    return keys


def _allowed_quickauth_audiences() -> set[str]:
    return {
        a.strip()
        for a in settings.QUICKAUTH_ALLOWED_AUDIENCES.split(",")
        if a.strip()
    }


# Sentinel signer_uuid for users who authed via the miniapp Quick Auth
# flow but have no Neynar signer registered with us. They can listen and
# read but can't perform write actions that require a real signer.
MINIAPP_QUICKAUTH_SIGNER_UUID = "miniapp-quickauth"


@router.post("/miniapp-quickauth", response_model=MiniAppVerifyResponse)
async def miniapp_quickauth(
    body: QuickAuthVerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Verify a Farcaster Quick Auth JWT and issue our own session JWT.

    Flow on the client: `sdk.quickAuth.getToken()` returns a JWT issued by
    `auth.farcaster.xyz` with `sub=fid`, `aud=<miniapp domain>`. We verify
    the signature against the issuer's JWKS, check iss/aud/exp, then mint a
    session JWT matching the shape of `/miniapp-verify` for drop-in reuse.
    """
    # Share the existing rate-limit budget with /miniapp-verify so a
    # malicious client can't bypass it by splitting across both endpoints.
    client_ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else "unknown"
    )
    rate_key = f"{MINIAPP_VERIFY_RATE_PREFIX}{client_ip}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, MINIAPP_VERIFY_RATE_WINDOW)
    count, _ = await pipe.execute()
    if count > MINIAPP_VERIFY_RATE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many verification attempts",
        )

    token = body.token
    if not isinstance(token, str) or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token"
        )

    try:
        unverified_header = jwt.get_unverified_header(token)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token header"
        )
    kid = unverified_header.get("kid")
    if not kid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing kid"
        )

    # Look up the signing key. If not in cache, refresh once in case keys
    # were rotated; a second miss means the token isn't ours to verify.
    try:
        keys = await _fetch_quickauth_jwks()
    except httpx.HTTPError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to reach Farcaster Quick Auth",
        )
    key = next((k for k in keys if k.get("kid") == kid), None)
    if key is None:
        try:
            keys = await _fetch_quickauth_jwks(force=True)
        except httpx.HTTPError:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Unable to reach Farcaster Quick Auth",
            )
        key = next((k for k in keys if k.get("kid") == kid), None)
    if key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown signing key"
        )

    audiences = _allowed_quickauth_audiences()
    if not audiences:
        # Misconfigured server; fail closed rather than accepting any aud.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Quick Auth audience not configured",
        )

    # python-jose enforces RFC 7519 strictly: `audience` only accepts a
    # single string and `sub` must be a string. Quick Auth JWTs ship `sub`
    # as an integer fid (per https://miniapps.farcaster.xyz/docs/sdk/quick-auth)
    # and we want to match `aud` against an allowlist. Skip both checks
    # here and validate them manually below.
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[unverified_header.get("alg", "RS256")],
            issuer=settings.QUICKAUTH_ISSUER,
            options={"verify_aud": False, "verify_sub": False},
        )
    except JWTError as exc:
        logger.warning("quick-auth jwt verification failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Quick Auth token",
        )

    aud_claim = claims.get("aud")
    aud_values: list[str] = (
        [a for a in aud_claim if isinstance(a, str)]
        if isinstance(aud_claim, list)
        else [aud_claim]
        if isinstance(aud_claim, str)
        else []
    )
    if not any(a in audiences for a in aud_values):
        logger.warning(
            "quick-auth aud mismatch: token aud=%s, allowed=%s",
            aud_values,
            sorted(audiences),
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Quick Auth token audience not allowed",
        )

    sub = claims.get("sub")
    try:
        fid = int(sub) if sub is not None else None
    except (TypeError, ValueError):
        fid = None
    if fid is None or fid <= 0:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing fid in Quick Auth token",
        )

    # Ensure a User row exists for this fid so downstream endpoints
    # (e.g. POST /v1/rooms/{id}/join, which calls _get_user) don't 404
    # the first time a miniapp user shows up. Best-effort Neynar profile
    # fetch — if it fails, fall back to a minimal placeholder so auth
    # still succeeds; the user just gets a generic display name until
    # the next request refreshes their profile.
    try:
        profile = await fetch_user_profile(fid)
    except Exception as exc:
        logger.warning("neynar profile fetch failed for fid=%s: %s", fid, exc)
        profile = {}
    try:
        result = await db.execute(select(User).where(User.fid == fid))
        existing = result.scalar_one_or_none()
        if existing is None:
            db.add(
                User(
                    fid=fid,
                    signer_uuid=MINIAPP_QUICKAUTH_SIGNER_UUID,
                    username=profile.get("username"),
                    display_name=profile.get("display_name"),
                    pfp_url=profile.get("pfp_url"),
                    custody_address=profile.get("custody_address"),
                )
            )
        else:
            # Refresh profile fields if Neynar gave us anything new, but do
            # NOT touch signer_uuid — preserve any real Neynar signer the
            # user registered via the native app.
            if profile.get("username"):
                existing.username = profile["username"]
            if profile.get("display_name"):
                existing.display_name = profile["display_name"]
            if profile.get("pfp_url"):
                existing.pfp_url = profile["pfp_url"]
            if profile.get("custody_address"):
                existing.custody_address = profile["custody_address"]
        await db.commit()
    except Exception as exc:
        logger.warning("user upsert failed for fid=%s: %s", fid, exc)
        # Don't fail auth — downstream endpoints will surface the missing
        # user as a 404, but we still want the JWT issued.

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=MINIAPP_JWT_EXPIRY_HOURS)
    payload = {
        "fid": fid,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    session_token = jwt.encode(
        payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM
    )

    return MiniAppVerifyResponse(token=session_token, fid=fid)
