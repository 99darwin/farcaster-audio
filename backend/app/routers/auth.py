import logging
import re

from eth_account.messages import encode_defunct
from eth_account import Account
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import httpx
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

from app.config import settings
from app.dependencies import get_db, get_redis
from app.models.user import User
from app.schemas.auth import (
    AuthUrlResponse,
    InvalidateAuthAddressRequest,
    LoginRequest,
    LoginResponse,
    RefreshRequest,
    RegisterAuthAddressRequest,
    RegisterAuthAddressResponse,
    AuthAddressStatusResponse,
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
from app.dependencies import DEMO_SIGNER_UUID, get_current_user, require_non_demo_user

router = APIRouter(prefix="/v1/auth", tags=["auth"])


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


@router.get("/neynar-auth-url", response_model=AuthUrlResponse)
async def get_auth_url():
    """Fetch the Neynar authorization URL for SIWN via the Neynar API."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://api.neynar.com/v2/farcaster/login/authorize",
            params={
                "client_id": settings.NEYNAR_CLIENT_ID,
                "response_type": "code",
            },
            headers={"x-api-key": settings.NEYNAR_API_KEY},
        )
        resp.raise_for_status()
        data = resp.json()
    return AuthUrlResponse(authorization_url=data["authorization_url"])


@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Login with Neynar SIWF credentials."""
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
            is_pro=is_pro,
            is_admin=user.is_admin,
        ),
    )


@router.post("/refresh", response_model=LoginResponse)
async def refresh(
    request: Request,
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

    if not await verify_refresh_token(body.refresh_token, fid, redis):
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

    return LoginResponse(
        jwt=jwt_token,
        refresh_token=new_refresh_token,
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
