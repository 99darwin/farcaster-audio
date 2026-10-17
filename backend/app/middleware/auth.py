from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

security = HTTPBearer()

# ``source`` claim stamped on JWTs minted by ``create_partner_jwt``.
PARTNER_JWT_SOURCE = "partner"
FIRST_PARTY_JWT_SOURCE = "first_party"
# ``source`` claims accepted by the default (first-party) dependencies.
# First-party sign-ins (SIWF, Protocol Auth, miniapp, refresh) currently mint
# JWTs with no ``source`` claim; ``"first_party"`` is the explicit spelling.
# This is an allowlist on purpose: any new JWT flavour is refused by default
# until it is explicitly admitted here.
FIRST_PARTY_JWT_SOURCES: frozenset[str | None] = frozenset(
    {None, FIRST_PARTY_JWT_SOURCE}
)

PARTNER_JWT_REJECTED_DETAIL = (
    "This endpoint requires a first-party sign-in. Sign in with Farcaster on "
    "juke.audio rather than using a partner-minted token."
)


@dataclass(frozen=True)
class AuthPrincipal:
    """Who a request is authenticated as, and via which kind of JWT."""

    fid: int
    is_partner: bool
    partner_app_id: str | None = None


def _extract_room_id(path: str) -> str | None:
    """Extract room_id from URL paths like /v1/rooms/{room_id}/..."""
    parts = path.strip("/").split("/")
    # Expected: ["v1", "rooms", "{room_id}", ...]
    if len(parts) >= 3 and parts[0] == "v1" and parts[1] == "rooms":
        return parts[2]
    return None


def _decode_jwt_payload(token: str) -> dict:
    """Decode + validate a Juke JWT of any source. Raises 401 on any failure.

    Every Juke JWT carries ``exp``; a token without one is refused rather
    than treated as non-expiring.
    """
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=[settings.JWT_ALGORITHM],
            options={"require_exp": True},
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )
    fid = payload.get("fid")
    if fid is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: missing fid",
        )
    exp = payload.get("exp")
    if datetime.fromtimestamp(exp, tz=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired"
        )
    return payload


def _is_first_party(payload: dict) -> bool:
    return payload.get("source") in FIRST_PARTY_JWT_SOURCES


def _first_party_payload(token: str) -> dict:
    """Decode a JWT and refuse anything that isn't a first-party sign-in."""
    payload = _decode_jwt_payload(token)
    if not _is_first_party(payload):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=PARTNER_JWT_REJECTED_DETAIL,
        )
    return payload


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> int:
    """Extract and verify a first-party JWT, return the user's FID.

    Partner-minted JWTs (``source="partner"``) are refused: they are issued
    on a third-party app's *assertion* of who the visitor is, so they must
    not act as the user anywhere except the handful of embed-safe routes
    that opt in via :func:`get_principal_allow_partner`.
    """
    return _first_party_payload(credentials.credentials)["fid"]


async def require_first_party_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> int:
    """Explicit first-party gate; same check as :func:`get_current_user`.

    Kept as a separate name so routes whose side-effects must be
    attributable to a direct sign-in (developer dashboard, key management,
    admin) document that intent at the call site and stay first-party-only
    even if the default dependency ever changes.
    """
    return _first_party_payload(credentials.credentials)["fid"]


async def get_principal_allow_partner(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> AuthPrincipal:
    """Accept first-party AND partner-minted JWTs.

    Use ONLY on embed-safe room-participation routes (see the allowlist in
    ``tests/test_partner_jwt_route_table.py``). Callers must check
    ``is_partner`` and constrain what a partner session may do.
    """
    payload = _decode_jwt_payload(credentials.credentials)
    if _is_first_party(payload):
        return AuthPrincipal(fid=payload["fid"], is_partner=False)
    if payload.get("source") == PARTNER_JWT_SOURCE:
        partner_app_id = payload.get("partner_app_id")
        return AuthPrincipal(
            fid=payload["fid"],
            is_partner=True,
            partner_app_id=str(partner_app_id) if partner_app_id else None,
        )
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
    )


optional_security = HTTPBearer(auto_error=False)


async def get_optional_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_security),
) -> int | None:
    """FID of a valid first-party JWT if present, else None.

    Partner-minted, expired, malformed and ``exp``-less tokens all degrade
    to anonymous rather than personalising the response for that fid.
    """
    if credentials is None:
        return None
    try:
        return _first_party_payload(credentials.credentials)["fid"]
    except HTTPException:
        return None


async def get_agent_or_user(request: Request) -> int:
    """Return FID from a first-party JWT or an agent session token.

    Priority:
    1. First-party JWT Bearer token (must carry ``exp``) -> human user FID
    2. X-Session-Token header -> agent FID from existing session
    3. None of the above -> 401 (x402 middleware handles 402 separately)

    Partner-minted JWTs are not accepted here.

    For agent sessions, also sets request.state.agent_session with the full
    session object.
    """
    # 1. Try JWT
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        try:
            payload: dict | None = _first_party_payload(auth_header[7:])
        except HTTPException:
            payload = None
        if payload is not None:
            request.state.authenticated = True
            return payload["fid"]

    # 2. Try session token (room-scoped: extract room_id from URL path)
    session_token = request.headers.get("x-session-token")
    if session_token:
        from app.services.session_service import SessionService

        # Extract room_id from path like /v1/rooms/{room_id}/...
        room_id_from_path = _extract_room_id(request.url.path)

        redis = request.app.state.redis
        session_svc = SessionService(redis)
        session = await session_svc.verify_session(
            session_token, room_id=room_id_from_path
        )
        if session:
            request.state.authenticated = True
            request.state.agent_session = session
            return session.agent_fid

    # 3. No auth found — 401. The x402 middleware handles 402 responses
    # separately for agent-join routes before this dependency runs.
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required",
    )


async def _get_db_session():
    """Inline DB session dependency to avoid circular imports."""
    from app.database import async_session

    async with async_session() as session:
        yield session


async def get_admin_user(
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(_get_db_session),
) -> int:
    """Verify the authenticated user has admin privileges. Returns FID.

    Partner-minted JWTs never reach the admin check: an approved developer
    app can assert any fid, so admin rights require a first-party sign-in.
    """
    from app.models.user import User

    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is None or not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return fid
