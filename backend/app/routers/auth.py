import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.security import HTTPAuthorizationCredentials
from jose import JWTError, jwt
from pydantic import BaseModel
from siwe import SiweMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.clients.key_gateway import KeyGatewayError
from app.config import settings
from app.database import async_session
from app.dependencies import (
    DEMO_SIGNER_UUID,
    get_current_user,
    get_db,
    get_farcaster_spaces_service,
    get_redis,
)
from app.middleware.auth import _is_first_party, optional_security
from app.models.user import (
    SIGNER_STATUS_APPROVED,
    SIGNER_STATUS_DEMO,
    SIGNER_STATUS_NONE,
    User,
)
from app.routing import RedactedValidationRoute
from app.schemas.auth import (
    AuthAddressStatusResponse,
    InvalidateAuthAddressRequest,
    LoginResponse,
    LogoutRequest,
    ProtocolLoginRequest,
    RefreshRequest,
    SignerPrepareRequest,
    SignerPrepareResponse,
    SignerRegisterRequest,
    SignerRegisterResponse,
    SignerStatusResponse,
    SiwfLoginRequest,
    SiwfNonceResponse,
    UserResponse,
)
from app.services import (
    farcaster_token_service,
    signer_crypto,
    user_signer_service,
)
from app.services.auth_address_service import (
    get_auth_address_status_cached,
    mark_auth_address_revoked,
)
from app.services.auth_service import (
    consume_refresh_token,
    create_jwt,
    create_refresh_token,
    fetch_user_profile,
    get_or_create_user,
)
from app.services.client_ip import client_ip as _client_ip
from app.services.rate_limit import RateLimit, enforce_rate_limits
from app.services.redis_service import RedisService
from app.services.siwf_service import (
    ProtocolAuthError,
    allowed_protocol_auth_domains,
    consume_siwf_nonce,
    lookup_fid_by_custody,
    mint_siwf_nonce,
    verify_miniapp_siwf_message,
    verify_protocol_auth_token,
    verify_siwf_message,
)

logger = logging.getLogger(__name__)

# Register/login bodies carry custody signatures and auth tokens: 422s
# must not echo them (``RedactedValidationRoute``).
router = APIRouter(
    prefix="/v1/auth", tags=["auth"], route_class=RedactedValidationRoute
)


# ---------------------------------------------------------------------------
# Refresh-token cookie helpers
# ---------------------------------------------------------------------------
#
# The dashboard at juke.audio opts into cookie-based refresh by sending
# `use_cookie=true` on login. The cookie is scoped to `/v1/auth` so it's only
# ever sent on auth endpoints, HttpOnly so JS can't read it, and (in prod)
# Domain=.juke.audio so it covers your-api-host.example.com across the subdomain.


def _is_pro(profile: dict) -> bool:
    return (profile.get("pro") or {}).get("status") == "subscribed"


async def _fetch_profile_or_error(fid: int) -> dict:
    """Profile for a freshly authenticated FID; 400/502 when unavailable."""
    try:
        return await fetch_user_profile(fid)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from None
    except hypersnap.HypersnapError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not load Farcaster profile.",
        ) from None


def _user_response(user: User, *, is_pro: bool = False) -> UserResponse:
    # ``demo`` is internal: the shared demo login is read-only, like ``none``.
    signer_status = user.signer_status or SIGNER_STATUS_NONE
    if signer_status == SIGNER_STATUS_DEMO:
        signer_status = SIGNER_STATUS_NONE
    return UserResponse(
        fid=user.fid,
        username=user.username or "",
        display_name=user.display_name or "",
        pfp_url=user.pfp_url,
        custody_address=user.custody_address,
        is_pro=is_pro,
        is_admin=user.is_admin,
        signer_status=signer_status,
    )


async def _issue_login(
    redis: aioredis.Redis,
    response: Response,
    user: User,
    *,
    is_pro: bool,
    use_cookie: bool,
) -> LoginResponse:
    """Mint a session for a freshly authenticated user.

    Marks a recent SIWN (step-up window for developer-key mutations). With
    ``use_cookie`` the refresh token goes in the HttpOnly cookie only.
    """
    jwt_token, expires_at = create_jwt(user.fid)
    refresh_token = await create_refresh_token(user.fid, redis)
    await RedisService(redis).mark_siwn(user.fid)
    body_refresh_token: str | None = refresh_token
    if use_cookie:
        _set_refresh_cookie(response, refresh_token)
        body_refresh_token = None
    return LoginResponse(
        jwt=jwt_token,
        refresh_token=body_refresh_token,
        expires_at=expires_at,
        user=_user_response(user, is_pro=is_pro),
    )


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
        # Fetch the real profile for a realistic review experience
        try:
            profile = await fetch_user_profile(fid)
            user = User(
                fid=fid,
                username=profile.get("username", "farcaster"),
                display_name=profile.get("display_name", "Farcaster"),
                pfp_url=profile.get("pfp_url"),
                signer_uuid=DEMO_SIGNER_UUID,
                signer_status=SIGNER_STATUS_DEMO,
            )
        except Exception:
            user = User(
                fid=fid,
                username="farcaster",
                display_name="Farcaster",
                signer_uuid=DEMO_SIGNER_UUID,
                signer_status=SIGNER_STATUS_DEMO,
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
        # Demo users never get admin access.
        user=_user_response(user).model_copy(update={"is_admin": False}),
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
       ``IdRegistry.idOf`` on Optimism. We do NOT trust a
       client-supplied FID — the FID is derived server-side from the
       cryptographically-verified address.
    4. Mint JWT + (optional) HttpOnly refresh cookie, mark a recent
       SIWN for step-up auth on developer-key mutations.

    Per-IP rate limited so this endpoint is bounded against
    credential-stuffing-style attempts.
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

    # Resolve custody → fid on-chain. The recovered address has
    # already been cryptographically tied to the message; this just
    # turns it into a Farcaster identity.
    fid = await lookup_fid_by_custody(custody)
    if fid is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No Farcaster account found for this address.",
        )

    # Profile lookup + user upsert. SIWF proves FID ownership but adds no
    # signer, so an existing user's signer state is left untouched.
    profile = await _fetch_profile_or_error(fid)
    user = await get_or_create_user(db, fid, profile)
    return await _issue_login(
        redis, response, user, is_pro=_is_pro(profile), use_cookie=body.use_cookie
    )


@router.post("/refresh", response_model=LoginResponse)
async def refresh(
    request: Request,
    response: Response,
    body: RefreshRequest,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Refresh JWT using a refresh token.

    The Authorization bearer JWT is optional — on a cold page reload the
    client may not yet have a JWT in memory, but the HttpOnly refresh
    cookie still rides along. When a bearer is present we cross-check
    its FID against the FID stored alongside the refresh token as
    defense in depth.
    """

    # Authorization header is optional. If present *and* well-formed, we
    # decode it (ignoring expiry) to get a candidate FID; if present but
    # malformed, that's a client bug and we 401 rather than silently
    # falling through to the cookie-only path.
    fid_from_bearer: int | None = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header:
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

        fid_from_bearer = payload.get("fid")
        if fid_from_bearer is None:
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

    fid_from_token = await consume_refresh_token(refresh_token_value, redis)
    if fid_from_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    # Defense in depth: if a bearer was provided, its FID must match the
    # FID stored alongside the refresh token. This prevents an attacker
    # from pairing one user's bearer with another user's refresh cookie.
    if fid_from_bearer is not None and fid_from_bearer != fid_from_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    fid = fid_from_token

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
        is_pro = _is_pro(profile)
    except (hypersnap.HypersnapError, ValueError):
        logger.warning("refresh profile fetch failed fid=%s", user.fid)

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
        user=_user_response(user, is_pro=is_pro),
    )


def _first_party_fid_from_bearer(
    credentials: HTTPAuthorizationCredentials | None,
) -> int | None:
    """Fid of a validly signed first-party access JWT, else ``None``.

    The token may be expired -- a client typically logs out after its access
    token lapsed -- but by no more than the refresh-token lifetime, past
    which no session it belonged to can still exist. The fid is used solely
    to delete that fid's Direct Casts token, never to authorize anything.

    Never raises: logout must succeed (204) whatever the header holds.
    Partner JWTs are ignored -- a third-party assertion must not be able to
    wipe the user's Direct Casts credential.
    """
    if credentials is None:
        return None
    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.JWT_SECRET,
            algorithms=[settings.JWT_ALGORITHM],
            options={"verify_exp": False},
        )
    except JWTError:
        return None
    # First-party allowlist (not a partner denylist): any non-sign-in source,
    # partner or otherwise, must not be able to wipe the Direct Casts token.
    if not _is_first_party(payload):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, int) or isinstance(exp, bool):
        return None
    max_staleness = timedelta(days=settings.JWT_REFRESH_EXPIRY_DAYS)
    if datetime.now(timezone.utc).timestamp() - exp > max_staleness.total_seconds():
        return None
    fid = payload.get("fid")
    if not isinstance(fid, int) or isinstance(fid, bool):
        return None
    return fid


@router.post("/logout")
async def logout(
    request: Request,
    body: LogoutRequest | None = None,
    redis: aioredis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_security),
) -> Response:
    """Clear the `juke_refresh` cookie and revoke any presented refresh token.

    Callable without a bearer — the primary job is clearing the cookie. If
    a refresh token is present in the cookie or in the request body, we also
    delete it from Redis so it can't be replayed. iOS (which never receives
    a cookie) passes the token in the body. Logout is idempotent: a missing
    or already-revoked token is not an error.

    A live refresh token, or a valid first-party access JWT in the
    ``Authorization`` header, identifies the fid whose stored Direct Casts
    token is deleted (the user re-enables messages after signing back in).
    The bearer covers a refresh that raced this logout and already consumed
    (atomically) the refresh token.
    """
    from app.services.auth_service import _hash_token

    logged_out_fids: set[int] = set()

    async def revoke(token: str) -> None:
        stored_fid = await redis.getdel(f"refresh_token:{_hash_token(token)}")
        if stored_fid is not None:
            logged_out_fids.add(int(stored_fid))

    cookie_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if cookie_token:
        # The refresh_token Redis key is keyed by the hash of the token,
        # not by fid, so we can revoke without parsing the JWT.
        await revoke(cookie_token)

    body_token = body.refresh_token if body else None
    if body_token and body_token != cookie_token:
        await revoke(body_token)

    bearer_fid = _first_party_fid_from_bearer(credentials)
    if bearer_fid is not None:
        logged_out_fids.add(bearer_fid)

    for fid in sorted(logged_out_fids):
        await farcaster_token_service.delete_direct_cast_token(db, fid)

    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_refresh_cookie(response)
    return response


@router.post("/auth-address", status_code=status.HTTP_410_GONE)
async def register_auth_address() -> None:
    """Removed: auth addresses are now added on-chain with the app signer.

    Pass ``auth_address`` to ``POST /v1/auth/signer/prepare`` and sign the
    second ``Add`` it returns.
    """
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Use POST /v1/auth/signer/prepare with auth_address.",
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
    to ``KeyRegistry.keyDataOf`` for missing rows or stale pending entries.
    """
    if not re.match(r"^0x[0-9a-fA-F]{40}$", address):
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
    except KeyGatewayError:
        logger.error("auth address status check failed fid=%s address=%s", fid, address)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to check auth address status",
        )

    return AuthAddressStatusResponse(
        auth_address=result.get("address", address),
        status=result.get("status", "unknown"),
        fid=result.get("fid"),
    )


@router.post("/auth-address/invalidate", status_code=status.HTTP_204_NO_CONTENT)
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
    if not re.match(r"^0x[0-9a-fA-F]{40}$", address):
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
# App signer: KeyGateway.addFor relayed by Juke
# ---------------------------------------------------------------------------


@router.post("/signer/prepare", response_model=SignerPrepareResponse)
async def prepare_signer(
    body: SignerPrepareRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> SignerPrepareResponse:
    """Generate an app signer for ``fid`` and the payloads custody must sign.

    Unauthenticated: nothing is granted until ``/signer/register`` proves
    control of the FID. The custody wallet signs ``typed_data.signer`` and
    ``typed_data.auth_address`` as-is, plus a Protocol Auth token with the
    ``protocol_auth`` fields.
    """
    try:
        prepared = await user_signer_service.prepare_signer(
            db,
            redis,
            fid=body.fid,
            auth_address=body.auth_address,
            client_ip=_client_ip(request),
        )
    except KeyGatewayError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="registry_unavailable"
        ) from None
    except (ValueError, signer_crypto.SignerKeyConfigError):
        logger.error("signer_prepare_unconfigured")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="signer_unavailable",
        ) from None
    return SignerPrepareResponse(**prepared)


@router.post(
    "/signer/register",
    response_model=SignerRegisterResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def register_signer(
    body: SignerRegisterRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> SignerRegisterResponse:
    """Validate the signed ``Add``s and token, then relay in the background.

    Both signatures must recover to custody, the token must be custody-signed
    with the prepare nonce, and the signer ``addFor`` must simulate cleanly,
    all before anything is broadcast. Poll ``GET /signer/status``.

    An optional custody-signed ``dc_auth_request`` is exchanged for the
    Direct Casts token in the background, best effort: it never fails the
    link (the client falls back to ``POST /v1/messages/enable``).
    """
    accepted, should_relay = await user_signer_service.register_signer(
        db,
        redis,
        prepare_id=body.prepare_id,
        signer_add_signature=body.signer_add_signature,
        auth_address_add_signature=body.auth_address_add_signature,
        protocol_auth_token=body.protocol_auth_token,
        client_ip=_client_ip(request),
    )
    if should_relay:
        background_tasks.add_task(
            user_signer_service.relay_prepared_signer,
            redis,
            prepare_id=body.prepare_id,
            signer_add_signature=body.signer_add_signature,
            auth_address_add_signature=body.auth_address_add_signature,
            session_factory=async_session,
        )
        if body.dc_auth_request is not None and body.dc_auth_signature is not None:
            background_tasks.add_task(
                farcaster_token_service.enable_after_signer_register,
                session_factory=async_session,
                spaces_service=get_farcaster_spaces_service(request),
                prepare_id=body.prepare_id,
                auth_request=body.dc_auth_request,
                signature=body.dc_auth_signature,
            )
    return SignerRegisterResponse(**accepted)


@router.get("/signer/status", response_model=SignerStatusResponse)
async def get_signer_status(
    request: Request,
    prepare_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> SignerStatusResponse:
    """Progress of one prepare. Never carries a session.

    Unauthenticated, keyed by ``prepare_id``. Once ``approved``, the device
    signs in with ``POST /v1/auth/protocol`` using an ``hqa1`` token from the
    auth address the link just added on-chain, so knowing a ``prepare_id``
    (it travels in this query string) grants nothing. ``login`` stays in the
    response as ``null`` so older app builds fall back to that same login
    instead of failing; their ``use_cookie`` parameter is ignored.
    """
    progress = await user_signer_service.get_prepare_status(
        db, redis, prepare_id=prepare_id, client_ip=_client_ip(request)
    )
    return SignerStatusResponse(
        prepare_id=str(progress.prepare_id),
        status=progress.status,
        signer_tx_hash=progress.signer_tx_hash,
        auth_address_tx_hash=progress.auth_address_tx_hash,
        error=progress.error,
    )


# ---------------------------------------------------------------------------
# Protocol Auth login (every login after the first link)
# ---------------------------------------------------------------------------

PROTOCOL_LOGIN_RATE_PREFIX = "protocol_login_rate:"
PROTOCOL_LOGIN_RATE_LIMIT = 10
PROTOCOL_LOGIN_RATE_WINDOW_SECONDS = 60


@router.post("/protocol", response_model=LoginResponse)
async def protocol_login(
    body: ProtocolLoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> LoginResponse:
    """Sign in with an ``hqa1.`` token from a linked device or custody.

    The token's nonce must come from ``/v1/auth/siwf/nonce`` and is consumed
    here, after the signature checks, so the token works exactly once.
    """
    await user_signer_service.enforce_rate_limit(
        redis,
        f"{PROTOCOL_LOGIN_RATE_PREFIX}{_client_ip(request)}",
        limit=PROTOCOL_LOGIN_RATE_LIMIT,
        window=PROTOCOL_LOGIN_RATE_WINDOW_SECONDS,
    )
    try:
        claims = await verify_protocol_auth_token(
            body.token,
            allowed_domains=allowed_protocol_auth_domains(
                settings.QUICKAUTH_ALLOWED_AUDIENCES
            ),
        )
    except ProtocolAuthError as exc:
        logger.warning("protocol_login_rejected reason=%s", exc.reason)
        if exc.reason == "signer_not_linked":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="signer_not_linked"
            ) from None
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_token"
        ) from None
    except KeyGatewayError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="registry_unavailable"
        ) from None
    if not await consume_siwf_nonce(redis, claims.nonce):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_token"
        )

    profile = await _fetch_profile_or_error(claims.fid)
    # The first sign-in after a recovery-phrase link lands here (the status
    # poll no longer issues sessions), possibly before the user row exists.
    has_signer = await user_signer_service.has_approved_signer(db, claims.fid)
    user = await get_or_create_user(
        db,
        claims.fid,
        profile,
        signer_status=SIGNER_STATUS_APPROVED if has_signer else None,
    )
    return await _issue_login(
        redis, response, user, is_pro=_is_pro(profile), use_cookie=body.use_cookie
    )


# ---------------------------------------------------------------------------
# Miniapp token exchange
# ---------------------------------------------------------------------------


class MiniAppNonceResponse(BaseModel):
    nonce: str


class MiniAppVerifyRequest(BaseModel):
    message: str
    signature: str
    nonce: str


class MiniAppVerifyResponse(BaseModel):
    token: str
    fid: int


class QuickAuthVerifyRequest(BaseModel):
    token: str


MINIAPP_JWT_EXPIRY_HOURS = 1
MINIAPP_NONCE_TTL_SECONDS = 300  # 5 minutes
MINIAPP_NONCE_PREFIX = "miniapp_nonce:"
MINIAPP_VERIFY_RATE_PREFIX = "miniapp_verify_rate:"
MINIAPP_VERIFY_RATE_LIMIT = 10  # per minute per IP
MINIAPP_VERIFY_RATE_WINDOW = 60


async def _enforce_miniapp_rate_limit(redis: aioredis.Redis, request: Request) -> None:
    """Shared per-IP budget for ``/miniapp-verify`` and ``/miniapp-quickauth``."""
    rate_key = f"{MINIAPP_VERIFY_RATE_PREFIX}{_client_ip(request)}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, MINIAPP_VERIFY_RATE_WINDOW)
    count, _ = await pipe.execute()
    if count > MINIAPP_VERIFY_RATE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many verification attempts",
        )


def _miniapp_domains() -> set[str]:
    domains = allowed_protocol_auth_domains(settings.QUICKAUTH_ALLOWED_AUDIENCES)
    if not domains:
        # Misconfigured server; fail closed rather than accepting any domain.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Miniapp auth domain not configured",
        )
    return domains


def _mint_miniapp_session(fid: int, *, not_after: datetime | None = None) -> str:
    """Short-lived session JWT; never outlives ``not_after`` when given."""
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=MINIAPP_JWT_EXPIRY_HOURS)
    if not_after is not None:
        expires_at = min(expires_at, not_after)
    payload = {
        "fid": fid,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


MINIAPP_NONCE_RATE_PREFIX = "miniapp_nonce_rate:"
# Unauthenticated, and every call stores a key in Redis for
# MINIAPP_NONCE_TTL_SECONDS, so it is bounded per client IP. Generous:
# carrier CGNAT puts many real users behind one IP, and a nonce costs only
# one short-lived key.
MINIAPP_NONCE_RATE_LIMIT = RateLimit(limit=120, window_seconds=60)


@router.get("/miniapp-nonce", response_model=MiniAppNonceResponse)
async def get_miniapp_nonce(
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
):
    """Generate a server-side nonce for SIWF sign-in."""
    await enforce_rate_limits(
        redis,
        [
            (
                f"{MINIAPP_NONCE_RATE_PREFIX}{_client_ip(request)}",
                MINIAPP_NONCE_RATE_LIMIT,
            )
        ],
    )
    # Alphanumeric only; the siwe parser rejects base64url "-" and "_".
    nonce = secrets.token_hex(32)
    await redis.set(f"{MINIAPP_NONCE_PREFIX}{nonce}", "1", ex=MINIAPP_NONCE_TTL_SECONDS)
    return MiniAppNonceResponse(nonce=nonce)


@router.post("/miniapp-verify", response_model=MiniAppVerifyResponse)
async def miniapp_verify(
    body: MiniAppVerifyRequest,
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
):
    """Verify a miniapp ``signIn`` SIWF credential and issue a short-lived JWT.

    The server nonce is consumed first (single use). The SIWE message must
    name an allowed domain, chain id 10, that nonce, a current validity
    window and one ``farcaster://fid/<fid>`` resource; its signer must be
    the FID's custody address or an added auth address.
    """
    await _enforce_miniapp_rate_limit(redis, request)

    consumed = await redis.delete(f"{MINIAPP_NONCE_PREFIX}{body.nonce}")
    if not consumed:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired nonce",
        )

    try:
        claims = await verify_miniapp_siwf_message(
            body.message,
            body.signature,
            expected_nonce=body.nonce,
            allowed_domains=_miniapp_domains(),
        )
    except ProtocolAuthError as exc:
        logger.warning("miniapp_verify_rejected reason=%s", exc.reason)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid sign-in message",
        ) from None
    except KeyGatewayError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to verify FID ownership",
        ) from None

    return MiniAppVerifyResponse(
        token=_mint_miniapp_session(claims.fid), fid=claims.fid
    )


async def _ensure_miniapp_user(db: AsyncSession, fid: int) -> None:
    """Best-effort user row so downstream endpoints don't 404 a new FID.

    A failed profile fetch or upsert never fails auth; profile fields are
    refreshed when available and signer state is never touched.
    """
    try:
        profile = await fetch_user_profile(fid)
    except (hypersnap.HypersnapError, ValueError):
        logger.warning("miniapp profile fetch failed fid=%s", fid)
        profile = {}
    try:
        await get_or_create_user(db, fid, profile)
    except Exception:  # noqa: BLE001 - auth must not fail on the upsert
        logger.exception("miniapp user upsert failed fid=%s", fid)
        await db.rollback()


@router.post("/miniapp-quickauth", response_model=MiniAppVerifyResponse)
async def miniapp_quickauth(
    body: QuickAuthVerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Exchange a Protocol Auth (``hqa1.``) token for a session JWT.

    The token is verified locally (no JWKS): canonical SIWE message for an
    allowed domain on chain 10, at most 1h lifetime, signed by the FID's
    custody address or an added auth address. It is not consumed, so a
    client may reuse a cached token within its lifetime; the session JWT
    never outlives the token. A token carrying a signer-prepare nonce is the
    custody-signed link token for ``/signer/register`` and is refused, so a
    leaked link token can never be exchanged for a session.
    """
    await _enforce_miniapp_rate_limit(redis, request)
    try:
        claims = await verify_protocol_auth_token(
            body.token,
            allowed_domains=_miniapp_domains(),
        )
    except ProtocolAuthError as exc:
        logger.warning("quickauth_rejected reason=%s", exc.reason)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Quick Auth token",
        ) from None
    except KeyGatewayError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to verify FID ownership",
        ) from None
    if await user_signer_service.is_prepare_nonce(redis, claims.nonce):
        logger.warning("quickauth_rejected reason=signer_link_token")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Quick Auth token",
        )

    await _ensure_miniapp_user(db, claims.fid)
    session_token = _mint_miniapp_session(claims.fid, not_after=claims.expires_at)
    return MiniAppVerifyResponse(token=session_token, fid=claims.fid)
