import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError, jwt
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
    register_auth_address_with_neynar,
    check_auth_address_status,
)
from app.dependencies import get_current_user

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
                signer_uuid="demo-readonly",
            )
        except Exception:
            user = User(
                fid=fid,
                username="farcaster",
                display_name="Farcaster",
                signer_uuid="demo-readonly",
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
        await verify_neynar_signer(body.signer_uuid, body.fid)
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
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
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

    return RegisterAuthAddressResponse(
        auth_address=result["address"],
        status=result.get("status", "pending_approval"),
        approval_url=result.get("auth_address_approval_url"),
    )


@router.get("/auth-address/status", response_model=AuthAddressStatusResponse)
async def get_auth_address_status(
    address: str,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Check whether an auth address has been approved."""
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
        result = await check_auth_address_status(address)
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
