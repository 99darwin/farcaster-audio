from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

security = HTTPBearer()


def _extract_room_id(path: str) -> str | None:
    """Extract room_id from URL paths like /v1/rooms/{room_id}/..."""
    parts = path.strip("/").split("/")
    # Expected: ["v1", "rooms", "{room_id}", ...]
    if len(parts) >= 3 and parts[0] == "v1" and parts[1] == "rooms":
        return parts[2]
    return None


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> int:
    """Extract and verify JWT, return the user's FID."""
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
        fid: int | None = payload.get("fid")
        if fid is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token: missing fid",
            )
        exp = payload.get("exp")
        if exp and datetime.fromtimestamp(exp, tz=timezone.utc) < datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token expired",
            )
        return fid
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )


optional_security = HTTPBearer(auto_error=False)


async def get_optional_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_security),
) -> int | None:
    """Extract and verify JWT if present. Returns FID or None."""
    if credentials is None:
        return None
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
        fid: int | None = payload.get("fid")
        if fid is None:
            return None
        exp = payload.get("exp")
        if exp and datetime.fromtimestamp(exp, tz=timezone.utc) < datetime.now(timezone.utc):
            return None
        return fid
    except JWTError:
        return None


async def get_agent_or_user(request: Request) -> int:
    """Return FID from JWT, agent session token, or x402 payment.

    Priority:
    1. JWT Bearer token -> human user FID
    2. X-Session-Token header -> agent FID from existing session
    3. x402 payment (request.state.payment_data) -> new agent, FID set later by join flow
    4. None of the above -> 401/402 (handled by x402 middleware if enabled)

    For agent sessions, also sets request.state.agent_session with the full session object.
    """
    # 1. Try JWT
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        try:
            payload = jwt.decode(
                token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
            )
            fid: int | None = payload.get("fid")
            if fid is not None:
                exp = payload.get("exp")
                if not exp or datetime.fromtimestamp(exp, tz=timezone.utc) >= datetime.now(timezone.utc):
                    request.state.authenticated = True
                    return fid
        except JWTError:
            pass

    # 2. Try session token (room-scoped: extract room_id from URL path)
    session_token = request.headers.get("x-session-token")
    if session_token:
        from app.services.session_service import SessionService

        # Extract room_id from path like /v1/rooms/{room_id}/...
        room_id_from_path = _extract_room_id(request.url.path)

        redis = request.app.state.redis
        session_svc = SessionService(redis)
        session = await session_svc.verify_session(session_token, room_id=room_id_from_path)
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
    fid: int = Depends(get_current_user),
    db: AsyncSession = Depends(_get_db_session),
) -> int:
    """Verify the authenticated user has admin privileges. Returns FID."""
    from app.models.user import User

    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is None or not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return fid
