"""
Participants router — all endpoints scoped to a room participant lifecycle.

Dependency pattern:
  - `get_room_service` composes db + redis into a RoomService instance.
  - `get_current_user` extracts the authenticated caller's FID from the JWT.
  - `room_id` is always a path parameter (string UUID).
"""

import hashlib

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_redis, require_non_demo_user
from app.schemas.agent import AgentJoinRequest, AgentJoinResponse
from app.schemas.common import StatusResponse
from app.schemas.participant import (
    BanRequest,
    BanResponse,
    JoinResponse,
    PromoteResponse,
    RaiseHandRequest,
    RaiseHandResponse,
    TokenRefreshResponse,
)
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService
from app.services.room_service import RoomService

router = APIRouter(prefix="/v1/rooms", tags=["participants"])

ANONYMOUS_JOIN_RATE_LIMIT = 30
ANONYMOUS_JOIN_RATE_WINDOW_SECONDS = 60


async def get_room_service(
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    livekit = LiveKitService()
    try:
        yield RoomService(db=db, redis=RedisService(redis), livekit=livekit)
    finally:
        await livekit.close()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _anonymous_session_id(request: Request) -> str:
    raw_session_id = request.headers.get("x-juke-session-id")
    if raw_session_id:
        return hashlib.sha256(raw_session_id.encode("utf-8")).hexdigest()
    fallback = f"{_client_ip(request)}:{request.headers.get('user-agent', '')}"
    return hashlib.sha256(fallback.encode("utf-8")).hexdigest()


async def _enforce_anonymous_join_rate_limit(
    request: Request, redis: aioredis.Redis
) -> None:
    ip_digest = hashlib.sha256(_client_ip(request).encode("utf-8")).hexdigest()
    rate_keys = [f"anonymous_join:rate:ip:{ip_digest}"]
    session_id = request.headers.get("x-juke-session-id")
    if session_id:
        session_digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        rate_keys.append(f"anonymous_join:rate:session:{session_digest}")

    pipe = redis.pipeline()
    for rate_key in rate_keys:
        pipe.incr(rate_key)
        pipe.expire(rate_key, ANONYMOUS_JOIN_RATE_WINDOW_SECONDS)
    results = await pipe.execute()
    attempts = [int(results[index] or 0) for index in range(0, len(results), 2)]
    if any(count > ANONYMOUS_JOIN_RATE_LIMIT for count in attempts):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Anonymous join rate limit exceeded. Try again later.",
        )


# ---------------------------------------------------------------------------
# Join / Leave
# ---------------------------------------------------------------------------


@router.post("/{room_id}/join", response_model=JoinResponse)
async def join_room(
    room_id: str,
    fid: int = Depends(require_non_demo_user),
    service: RoomService = Depends(get_room_service),
) -> JoinResponse:
    """Join a room as a listener. Returns LiveKit token, WS URL, and current room state."""
    return await service.join_room(room_id=room_id, fid=fid)


@router.post("/{room_id}/anonymous-join", response_model=JoinResponse)
async def anonymous_join_room(
    room_id: str,
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
    service: RoomService = Depends(get_room_service),
) -> JoinResponse:
    """Join an active room as an anonymous listen-only listener."""
    await _enforce_anonymous_join_rate_limit(request, redis)
    return await service.join_room_anonymously(
        room_id=room_id,
        session_id=_anonymous_session_id(request),
    )


@router.post("/{room_id}/agent-join", response_model=AgentJoinResponse)
async def agent_join_room(
    room_id: str,
    body: AgentJoinRequest,
    request: Request,
    redis: aioredis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
):
    """Join a room as an agent. Requires x402 payment or a valid session token.

    Agents are always identified as non-human in the participant list.
    They join as listeners with data-publish rights (can send transcription, etc).
    """
    from app.models.room import Room
    from app.models.user import User
    from app.services.session_service import SessionService
    from sqlalchemy import select as sa_select

    # Pre-check: does this room allow agents? Do this BEFORE payment processing
    # to avoid charging agents for rooms they can't enter.
    import uuid as uuid_mod

    try:
        room_uuid = uuid_mod.UUID(room_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    result = await db.execute(sa_select(Room).where(Room.id == room_uuid))
    room = result.scalar_one_or_none()
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Room not found"
        )
    if room.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Room is not active"
        )
    if not room.allow_agents:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This room does not allow agents",
        )

    # Check for existing session token (re-join)
    session_token = request.headers.get("x-session-token")
    if session_token:
        session_svc = SessionService(redis)
        session = await session_svc.verify_session(session_token, room_id=room_id)
        if not session:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired session token",
            )
        # Re-join with existing session
        livekit = LiveKitService()
        try:
            svc = RoomService(db=db, redis=RedisService(redis), livekit=livekit)
            join_response = await svc.join_room(room_id=room_id, fid=session.agent_fid)
            return AgentJoinResponse(
                session_token=session_token,
                livekit_token=join_response.livekit_token,
                livekit_ws_url=join_response.livekit_ws_url,
                expires_at=join_response.expires_at,
                role=join_response.role,
                room=join_response.room.model_dump(),
                participants=[p.model_dump() for p in join_response.participants],
            )
        finally:
            await livekit.close()

    # Check for x402 payment (set by middleware on request.state)
    # The x402 middleware sets payment_payload and payment_requirements on verified payment.
    import logging as _logging

    _log = _logging.getLogger(__name__)
    _state_attrs = {
        k: type(getattr(request.state, k)).__name__ for k in vars(request.state)
    }
    _log.info("agent-join request.state: %s", _state_attrs)

    if not hasattr(request.state, "payment_payload"):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Payment required. See GET /v1/agent/SKILL.md for instructions.",
        )

    # Extract payer address from payment payload if available
    payer_address = None
    payment_payload = request.state.payment_payload
    if hasattr(payment_payload, "payer"):
        payer_address = payment_payload.payer

    # Create agent session
    session_svc = SessionService(redis)
    token, session = await session_svc.create_session(
        room_id=room_id,
        agent_name=body.agent_name,
        agent_pfp_url=body.agent_pfp_url,
        payer_address=payer_address,
    )

    # Create temporary User record for the agent
    from sqlalchemy import select

    result = await db.execute(select(User).where(User.fid == session.agent_fid))
    existing_user = result.scalar_one_or_none()

    if not existing_user:
        agent_user = User(
            fid=session.agent_fid,
            signer_uuid=f"agent:{session.agent_fid}",
            username=f"agent-{session.agent_fid}",
            display_name=body.agent_name,
            pfp_url=body.agent_pfp_url,
            is_agent=True,
        )
        db.add(agent_user)
        await db.commit()

    # Join the room
    livekit = LiveKitService()
    try:
        svc = RoomService(db=db, redis=RedisService(redis), livekit=livekit)
        join_response = await svc.join_room_as_agent(
            room_id=room_id,
            agent_fid=session.agent_fid,
            agent_name=body.agent_name,
            agent_pfp_url=body.agent_pfp_url,
        )
        return AgentJoinResponse(
            session_token=token,
            livekit_token=join_response.livekit_token,
            livekit_ws_url=join_response.livekit_ws_url,
            expires_at=join_response.expires_at,
            role=join_response.role,
            room=join_response.room.model_dump(),
            participants=[p.model_dump() for p in join_response.participants],
        )
    finally:
        await livekit.close()


@router.post("/{room_id}/leave", response_model=StatusResponse)
async def leave_room(
    room_id: str,
    fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Leave a room. Removes the caller from Redis and marks left_at in the DB."""
    await service.leave_room(room_id=room_id, fid=fid)
    return StatusResponse(status="ok")


# ---------------------------------------------------------------------------
# Hand raise
# ---------------------------------------------------------------------------


@router.post("/{room_id}/raise-hand", response_model=RaiseHandResponse)
async def raise_hand(
    room_id: str,
    body: RaiseHandRequest,
    fid: int = Depends(require_non_demo_user),
    service: RoomService = Depends(get_room_service),
) -> RaiseHandResponse:
    """Toggle hand-raise state for the authenticated listener."""
    return await service.raise_hand(room_id=room_id, fid=fid, raised=body.raised)


# ---------------------------------------------------------------------------
# Moderation — promote / demote / mute / kick / ban
# ---------------------------------------------------------------------------


@router.post("/{room_id}/participants/{fid}/promote", response_model=PromoteResponse)
async def promote_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> PromoteResponse:
    """Promote a listener to speaker. Requires host or co-host role."""
    return await service.promote_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )


@router.post("/{room_id}/participants/{fid}/demote", response_model=PromoteResponse)
async def demote_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> PromoteResponse:
    """Demote a speaker or co-host back to listener. Requires host or co-host role."""
    return await service.demote_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )


@router.post("/{room_id}/participants/{fid}/mute", response_model=StatusResponse)
async def mute_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Server-side mute a speaker. Hosts and co-hosts only."""
    await service.mute_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )
    return StatusResponse(status="ok")


@router.post("/{room_id}/participants/{fid}/kick", response_model=StatusResponse)
async def kick_participant(
    room_id: str,
    fid: int,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> StatusResponse:
    """Forcibly remove a participant from the room."""
    await service.kick_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
    )
    return StatusResponse(status="ok")


@router.post("/{room_id}/participants/{fid}/ban", response_model=BanResponse)
async def ban_participant(
    room_id: str,
    fid: int,
    body: BanRequest,
    actor_fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> BanResponse:
    """Kick and ban a participant. Optionally specify reason and duration."""
    return await service.ban_participant(
        room_id=room_id,
        actor_fid=actor_fid,
        target_fid=fid,
        reason=body.reason,
        duration_hours=body.duration_hours,
    )


# ---------------------------------------------------------------------------
# Token refresh
# ---------------------------------------------------------------------------


@router.post("/{room_id}/token", response_model=TokenRefreshResponse)
async def refresh_token(
    room_id: str,
    fid: int = Depends(get_current_user),
    service: RoomService = Depends(get_room_service),
) -> TokenRefreshResponse:
    """Issue a fresh LiveKit token for an active participant."""
    return await service.refresh_token(room_id=room_id, fid=fid)
