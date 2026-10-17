"""``/v1/messages`` — Farcaster Direct Casts (docs/messaging-design.md, 4.2).

Every route (HTTP and WS) except ``GET /status`` is gated by
``MESSAGING_ENABLED`` and answers 404 ``{"detail": "messaging_disabled"}``
(WS: close 4404) while it is off; ``GET /status`` lives on the ungated
:data:`status_router` so clients can tell "feature off" from "not found".

Every route acts strictly as the JWT's fid: the upstream credential is the
fid's stored custody-minted Direct Casts token, loaded per request by
``DirectCastService.authorize`` (403 ``messaging_token_missing`` /
``messaging_token_expired`` without one -> the client's "Enable messages"
flow), and no route accepts an acting fid or credential from the client.
Partner JWTs are refused (``require_first_party_user``): DMs are private and
must not be reachable through a third-party assertion.

Errors expose only a status and an opaque tag
(``detail="messaging_token_missing"`` etc.); upstream bodies, bearers and
signatures never reach a response or a log line.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import secrets
import time
from collections.abc import Callable, Coroutine
from contextlib import AbstractAsyncContextManager
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    WebSocketException,
    status,
)
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import HTTPConnection

from app.config import settings
from app.dependencies import get_db, pubsub_redis
from app.middleware.auth import (
    _first_party_payload,
    optional_security,
    require_first_party_user,
)
from app.models.user import User
from app.routing import RedactedValidationRoute
from app.schemas.messages import (
    ID_PATTERN,
    MAX_ID_CHARS,
    Conversation,
    ConversationCategory,
    InboxFilter,
    InboxResponse,
    Message,
    MessageMetadata,
    MessageSearchHit,
    MessagesEvent,
    MessagesEventsTicket,
    MessagesPage,
    MessageUser,
    MessagingStatus,
    MetadataPreviewRequest,
    Page,
    ReactionRequest,
    ReactorEntry,
    SendMessageRequest,
    SendMessageResponse,
    SignerStatus,
)
from app.services import direct_cast_relay, farcaster_token_service
from app.services.direct_cast_relay import InboxPoller, UpstreamRelay, events_channel
from app.services.rate_limit import ConnectionLease, try_acquire_connection_lease
from app.services.direct_cast_service import (
    TOKEN_EXPIRED,
    TOKEN_MISSING,
    TOKEN_UNAVAILABLE,
    DirectCastService,
    MessagingAuthError,
    MessagingError,
    MessagingViewer,
    build_direct_cast_service,
)

logger = logging.getLogger(__name__)

RATE_LIMIT_WINDOW_SECONDS = 60
# Per-user, per-minute budgets. Reads cover inbox/thread polling (the
# clients poll /recent every few seconds while a thread is open).
RATE_LIMITS_PER_MIN: dict[str, int] = {
    "read": 120,
    "send": 20,
    "reactions": 60,
    "search": 30,
    "events": 30,
    # Writes that flip read state; clients fire one per thread open/close.
    "mark_read": 30,
    # PUT /metadata (link unfurl while composing); was sharing "search".
    "preview": 30,
    "events_ticket": 30,
}
RATE_LIMIT_KEY_PREFIX = "messages:rl:"
RATE_LIMITED_DETAIL = "rate_limited"
MESSAGING_DISABLED_DETAIL = "messaging_disabled"
# MessagingAuthError code -> MessagingStatus.signer_status
SIGNER_STATUS_BY_CODE: dict[str, SignerStatus] = {
    TOKEN_MISSING: "not_linked",
    TOKEN_EXPIRED: "not_linked",
    TOKEN_UNAVAILABLE: "unavailable",
}

# Upstream cursors are short; in-thread search wraps one (``ts1.``, ~4/3x).
MAX_CURSOR_CHARS = 1024
MIN_QUERY_CHARS = 1
MAX_QUERY_CHARS = 200

# Websocket close codes (4xxx mirror HTTP semantics, as in the clients).
WS_CLOSE_NOT_FOUND = 4404
WS_CLOSE_UNAUTHORIZED = 4401
WS_CLOSE_FORBIDDEN = 4403
WS_CLOSE_RATE_LIMITED = 4429
WS_CLOSE_INTERNAL = status.WS_1011_INTERNAL_ERROR
WS_RECEIVE_TIMEOUT_SECONDS = 1.0
WS_IDLE_PING_SECONDS = 25.0
# 4401 close reasons (docs 4.7): ``ticket_rejected`` = the ticket was
# missing, unknown, consumed, expired or malformed (mint a fresh one and
# retry); ``session_expired`` = the issuing JWT expired (refresh auth first).
WS_CLOSE_REASON_SESSION_EXPIRED = "session_expired"
WS_CLOSE_REASON_TICKET_REJECTED = "ticket_rejected"

# Single-use WS tickets (docs 4.7): stored hashed, value is the fid plus the
# issuing JWT's ``exp`` so a ticket socket closes when that session would.
WS_TICKET_TTL_SECONDS = 30
WS_TICKET_BYTES = 32
MAX_WS_TICKET_CHARS = 128
WS_TICKET_KEY_PREFIX = "messages:ws_ticket:"
# Concurrent /events sockets per fid (``settings.MESSAGES_WS_MAX_PER_FID``).
# Each socket polls upstream, so an uncapped fid could fan out without bound.
# Leases are renewed every poll tick; a crashed worker's leases lapse after
# the TTL instead of locking the fid out.
WS_CONNECTION_KEY_PREFIX = "messages:ws_conn:"
WS_CONNECTION_LEASE_TTL_SECONDS = 60
WS_CLOSE_REASON_TOO_MANY_CONNECTIONS = "too_many_connections"
WS_CLOSE_REASON_MESSAGING_DISABLED = "messaging_disabled"


class MessagingErrorRoute(RedactedValidationRoute):
    """Translate ``MessagingError`` (from deps or handlers) into HTTP errors.

    422s never echo submitted values (message text, ids). An error with a
    sanitized ``client_message`` (``upstream_rejected``) answers
    ``{"detail": code, "message": client_message}``.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await handler(request)
            except MessagingError as exc:
                if exc.client_message is not None:
                    return JSONResponse(
                        status_code=exc.status_code,
                        content={"detail": exc.code, "message": exc.client_message},
                    )
                if exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
                    raise _rate_limited(exc.code) from None
                raise HTTPException(
                    status_code=exc.status_code, detail=exc.code
                ) from None

        return handle


def _rate_limited(detail: str = RATE_LIMITED_DETAIL) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=detail,
        headers={"Retry-After": str(RATE_LIMIT_WINDOW_SECONDS)},
    )


async def require_messaging_enabled(conn: HTTPConnection) -> None:
    if settings.MESSAGING_ENABLED:
        return
    if conn.scope["type"] == "websocket":
        raise WebSocketException(code=WS_CLOSE_NOT_FOUND)
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail=MESSAGING_DISABLED_DETAIL
    )


router = APIRouter(
    prefix="/v1/messages",
    tags=["messages"],
    route_class=MessagingErrorRoute,
    dependencies=[Depends(require_messaging_enabled)],
)
# Ungated: answers even while MESSAGING_ENABLED is off.
status_router = APIRouter(
    prefix="/v1/messages", tags=["messages"], route_class=MessagingErrorRoute
)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


def get_direct_cast_service(conn: HTTPConnection) -> DirectCastService:
    """App-wide service instance (one shared upstream HTTP client)."""
    service = getattr(conn.app.state, "direct_cast_service", None)
    if service is None:
        service = build_direct_cast_service(settings, conn.app.state.redis)
        conn.app.state.direct_cast_service = service
    return service


def get_messages_session_factory() -> (
    Callable[[], AbstractAsyncContextManager[AsyncSession]]
):
    """Session factory for the WS loop (overridden in tests)."""
    from app.database import async_session

    return async_session


async def _over_rate_limit(redis: Any, bucket: str, fid: int) -> bool:
    """Fixed-window counter, same shape as ``rooms.py``.

    ``expire(nx=True)`` sets the window only on the first hit so steady
    polling cannot keep extending it and lock a client out indefinitely.
    """
    key = f"{RATE_LIMIT_KEY_PREFIX}{bucket}:{fid}"
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, RATE_LIMIT_WINDOW_SECONDS, nx=True)
    count, _ = await pipe.execute()
    return int(count) > RATE_LIMITS_PER_MIN[bucket]


def _rate_limited_fid(bucket: str) -> Callable[..., Coroutine[Any, Any, int]]:
    async def dependency(
        request: Request, fid: int = Depends(require_first_party_user)
    ) -> int:
        if await _over_rate_limit(request.app.state.redis, bucket, fid):
            raise _rate_limited()
        return fid

    return dependency


Service = Annotated[DirectCastService, Depends(get_direct_cast_service)]
Database = Annotated[AsyncSession, Depends(get_db)]


def _viewer(bucket: str) -> Callable[..., Coroutine[Any, Any, MessagingViewer]]:
    rate_limited_fid = _rate_limited_fid(bucket)

    async def dependency(
        db: Database,
        service: Service,
        # Closure-local dependency: string annotations (PEP 563) cannot
        # resolve it inside ``Annotated``, so it stays a default.
        fid: int = Depends(rate_limited_fid),
    ) -> MessagingViewer:
        return await service.authorize(db, fid=fid)

    return dependency


ReadViewer = Annotated[MessagingViewer, Depends(_viewer("read"))]
SendViewer = Annotated[MessagingViewer, Depends(_viewer("send"))]
ReactionViewer = Annotated[MessagingViewer, Depends(_viewer("reactions"))]
SearchViewer = Annotated[MessagingViewer, Depends(_viewer("search"))]
MarkReadViewer = Annotated[MessagingViewer, Depends(_viewer("mark_read"))]
PreviewViewer = Annotated[MessagingViewer, Depends(_viewer("preview"))]

IdPath = Annotated[str, Path(min_length=1, max_length=MAX_ID_CHARS, pattern=ID_PATTERN)]
Cursor = Annotated[str | None, Query(max_length=MAX_CURSOR_CHARS)]
SearchQuery = Annotated[
    str, Query(min_length=MIN_QUERY_CHARS, max_length=MAX_QUERY_CHARS)
]
IdQuery = Annotated[
    str, Query(min_length=1, max_length=MAX_ID_CHARS, pattern=ID_PATTERN)
]
OptionalIdQuery = Annotated[
    str | None, Query(min_length=1, max_length=MAX_ID_CHARS, pattern=ID_PATTERN)
]


async def load_sender_profile(db: AsyncSession, fid: int) -> MessageUser:
    """The viewer's own profile for the send echo; ``!fid`` if unknown."""
    try:
        result = await db.execute(select(User).where(User.fid == fid))
        user = result.scalar_one_or_none()
    except SQLAlchemyError as exc:
        logger.warning(
            "[messages] sender profile lookup failed (%s)", type(exc).__name__
        )
        user = None
    if user is None:
        return MessageUser(fid=fid, display_name=f"!{fid}")
    return MessageUser(
        fid=fid,
        username=user.username,
        display_name=user.display_name or user.username or f"!{fid}",
        pfp_url=user.pfp_url,
    )


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------


@status_router.get("/status", response_model=MessagingStatus)
async def get_messaging_status(
    db: Database,
    service: Service,
    fid: int = Depends(_rate_limited_fid("read")),
) -> MessagingStatus:
    """Capability probe: is messaging on, and can this viewer use it?

    Resolves the same credential every other route would (without calling
    upstream), so ``token_status: "active"`` means "has a stored token", not
    "upstream accepted it" — a revoked token still surfaces later as 403
    ``messaging_token_rejected``. ``signer_status`` is kept for older
    clients and derived from the same check.
    """
    if not settings.MESSAGING_ENABLED:
        return MessagingStatus(enabled=False)
    token = await farcaster_token_service.get_token_status(db, fid)
    signer_status: SignerStatus = "ready"
    try:
        await service.authorize(db, fid=fid)
    except MessagingAuthError as exc:
        signer_status = SIGNER_STATUS_BY_CODE.get(exc.code, "unavailable")
    return MessagingStatus(
        enabled=True,
        signer_status=signer_status,
        token_status=token.token_status,
        expires_at=token.expires_at,
    )


@router.get("/inbox", response_model=InboxResponse)
async def get_inbox(
    viewer: ReadViewer,
    service: Service,
    category: ConversationCategory = "default",
    filter_: Annotated[InboxFilter | None, Query(alias="filter")] = None,
    cursor: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 25,
) -> InboxResponse:
    return await service.inbox(
        viewer, category=category, filter_=filter_, cursor=cursor, limit=limit
    )


@router.get("/conversations/with/{fid}", response_model=Conversation)
async def get_conversation_with(
    viewer: ReadViewer,
    service: Service,
    fid: Annotated[int, Path(ge=1)],
) -> Conversation:
    """The viewer's existing 1:1 with ``fid``; 404 ``conversation_not_found``."""
    return await service.conversation_with(viewer, fid)


@router.get("/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(
    viewer: ReadViewer,
    service: Service,
    conversation_id: IdPath,
) -> Conversation:
    return await service.conversation(viewer, conversation_id)


@router.get("/conversations/{conversation_id}/messages", response_model=MessagesPage)
async def get_messages(
    viewer: ReadViewer,
    service: Service,
    conversation_id: IdPath,
    cursor: Cursor = None,
    anchor_message_id: OptionalIdQuery = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> MessagesPage:
    """Newest-first page. ``cursor`` takes either ``next_cursor`` (older) or
    ``next_newer_cursor`` (newer); the direction is encoded in the cursor."""
    return await service.messages(
        viewer,
        conversation_id,
        cursor=cursor,
        anchor_message_id=anchor_message_id,
        limit=limit,
    )


@router.get("/conversations/{conversation_id}/recent", response_model=Page[Message])
async def get_recent_messages(
    viewer: ReadViewer,
    service: Service,
    conversation_id: IdPath,
) -> Page[Message]:
    return await service.recent_messages(viewer, conversation_id)


@router.put("/send", response_model=SendMessageResponse)
async def send_message(
    body: SendMessageRequest,
    viewer: SendViewer,
    service: Service,
    db: Database,
) -> SendMessageResponse:
    sender = await load_sender_profile(db, viewer.fid)
    message = await service.send(viewer, body, sender=sender)
    return SendMessageResponse(message=message)


@router.post(
    "/conversations/{conversation_id}/read",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def mark_read(
    viewer: MarkReadViewer,
    service: Service,
    conversation_id: IdPath,
) -> Response:
    await service.mark_read(viewer, conversation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/conversations/{conversation_id}/unread",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def mark_unread(
    viewer: MarkReadViewer,
    service: Service,
    conversation_id: IdPath,
) -> Response:
    await service.mark_unread(viewer, conversation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/conversations/{conversation_id}/accept",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def accept_request(
    viewer: SendViewer,
    service: Service,
    conversation_id: IdPath,
) -> Response:
    """Move a message request into the default inbox."""
    await service.accept_request(viewer, conversation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/conversations/{conversation_id}/decline",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def decline_request(
    viewer: SendViewer,
    service: Service,
    conversation_id: IdPath,
) -> Response:
    """Delete a request from the viewer's side (the sender is not told)."""
    await service.decline_request(viewer, conversation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_message(
    viewer: SendViewer,
    service: Service,
    conversation_id: IdPath,
    message_id: IdPath,
) -> Response:
    await service.delete_message(viewer, conversation_id, message_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/reactions", status_code=status.HTTP_204_NO_CONTENT, response_class=Response
)
async def add_reaction(
    body: ReactionRequest, viewer: ReactionViewer, service: Service
) -> Response:
    await service.react(viewer, body, remove=False)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/reactions", status_code=status.HTTP_204_NO_CONTENT, response_class=Response
)
async def remove_reaction(
    body: ReactionRequest, viewer: ReactionViewer, service: Service
) -> Response:
    await service.react(viewer, body, remove=True)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/reactions", response_model=Page[ReactorEntry])
async def list_reactors(
    viewer: ReadViewer,
    service: Service,
    conversation_id: IdQuery,
    message_id: IdQuery,
    cursor: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> Page[ReactorEntry]:
    return await service.reactors(
        viewer, conversation_id, message_id, cursor=cursor, limit=limit
    )


@router.get("/search", response_model=Page[MessageSearchHit])
async def search_messages(
    viewer: SearchViewer,
    service: Service,
    q: SearchQuery,
    conversation_id: OptionalIdQuery = None,
    cursor: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> Page[MessageSearchHit]:
    """Global search; ``conversation_id`` (additive) scopes it to one thread.

    Upstream has no per-conversation filter, so scoped search filters
    global hits server-side (see ``search_messages`` in the service).
    """
    return await service.search_messages(
        viewer, q, conversation_id=conversation_id, cursor=cursor, limit=limit
    )


@router.get("/search/conversations", response_model=Page[Conversation])
async def search_conversations(
    viewer: SearchViewer,
    service: Service,
    q: SearchQuery,
    category: ConversationCategory = "default",
    cursor: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> Page[Conversation]:
    return await service.search_conversations(
        viewer, q, category=category, cursor=cursor, limit=limit
    )


@router.get("/recipients", response_model=Page[MessageUser])
async def search_recipients(
    viewer: SearchViewer,
    service: Service,
    q: SearchQuery,
    cursor: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> Page[MessageUser]:
    return await service.search_recipients(viewer, q, cursor=cursor, limit=limit)


@router.post("/metadata/preview", response_model=MessageMetadata)
async def preview_metadata(
    body: MetadataPreviewRequest, viewer: PreviewViewer, service: Service
) -> MessageMetadata:
    return await service.preview_metadata(viewer, body.text)


# ---------------------------------------------------------------------------
# WS /events (Phase A polling fan-out; Phase B relay stubbed)
# ---------------------------------------------------------------------------


def _strict_int(value: Any) -> int | None:
    """``value`` if it is an ``int`` (``bool`` excluded), else ``None``."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _session_claims(value: Any) -> tuple[int, int | None] | None:
    """``(fid, exp)`` from a JWT payload or stored ticket; ``None`` if no fid."""
    if not isinstance(value, dict):
        return None
    fid = _strict_int(value.get("fid"))
    if fid is None:
        return None
    return fid, _strict_int(value.get("exp"))


def _first_party_claims(token: str) -> tuple[int, int | None] | None:
    """``(fid, exp)`` of a valid first-party JWT, else ``None`` (never raises)."""
    try:
        payload = _first_party_payload(token)
    except HTTPException:
        return None
    return _session_claims(payload)


def _ws_ticket_key(ticket: str) -> str:
    digest = hashlib.sha256(ticket.encode("utf-8")).hexdigest()
    return f"{WS_TICKET_KEY_PREFIX}{digest}"


async def _issue_ws_ticket(redis: Any, *, fid: int, expires_at: int | None) -> str:
    ticket = secrets.token_urlsafe(WS_TICKET_BYTES)
    await redis.set(
        _ws_ticket_key(ticket),
        json.dumps({"fid": fid, "exp": expires_at}),
        ex=WS_TICKET_TTL_SECONDS,
    )
    return ticket


async def _consume_ws_ticket(redis: Any, ticket: str) -> tuple[int, int | None] | None:
    """Atomically take ``ticket`` (GETDEL): ``(fid, exp)`` once, then ``None``."""
    if not ticket or len(ticket) > MAX_WS_TICKET_CHARS:
        return None
    raw = await redis.getdel(_ws_ticket_key(ticket))
    if raw is None:
        return None
    try:
        return _session_claims(json.loads(raw))
    except (TypeError, ValueError):
        return None


def _session_expired(expires_at: int | None) -> bool:
    return expires_at is not None and time.time() >= expires_at


@router.post("/events/ticket", response_model=MessagesEventsTicket)
async def create_events_ticket(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_security),
) -> MessagesEventsTicket:
    """Mint a single-use, 30 s ticket for ``WS /events?ticket=`` so the JWT
    never rides in a URL (proxy/access logs, browser history).

    A missing/non-Bearer ``Authorization`` is 401 (not ``HTTPBearer``'s
    default 403) so clients treat every auth failure here as "refresh auth".
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    claims = _first_party_claims(credentials.credentials)
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_token"
        )
    fid, expires_at = claims
    redis = request.app.state.redis
    if await _over_rate_limit(redis, "events_ticket", fid):
        raise _rate_limited()
    ticket = await _issue_ws_ticket(redis, fid=fid, expires_at=expires_at)
    return MessagesEventsTicket(ticket=ticket, expires_in=WS_TICKET_TTL_SECONDS)


async def _drain_client_frames(
    websocket: WebSocket, disconnected: asyncio.Event
) -> None:
    """Consume client frames (``{"type":"ping"}``) until the socket closes."""
    try:
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        disconnected.set()


def _decode_event(raw: Any) -> dict[str, Any] | None:
    data = raw.get("data") if isinstance(raw, dict) else None
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    try:
        payload = json.loads(data)
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


async def _close_quietly(websocket: WebSocket, code: int, reason: str = "") -> None:
    with contextlib.suppress(RuntimeError, WebSocketDisconnect):
        await websocket.close(code=code, reason=reason)


async def _close_for_error(websocket: WebSocket, exc: MessagingError) -> None:
    """4403 + the HTTP detail as close reason (e.g. ``messaging_token_missing``)."""
    if exc.status_code == status.HTTP_403_FORBIDDEN:
        await _close_quietly(websocket, WS_CLOSE_FORBIDDEN, exc.code)
        return
    await _close_quietly(websocket, WS_CLOSE_INTERNAL)


@router.websocket("/events")
async def messages_events(websocket: WebSocket, ticket: str | None = None) -> None:
    """Stream ``MessagesEvent`` frames for the authenticated fid only.

    Auth is ``?ticket=`` from ``POST /events/ticket`` (browsers cannot set
    WS headers). Closes 4401 ``ticket_rejected`` for a missing, unknown,
    consumed, expired or malformed ticket and 4401 ``session_expired`` once
    the issuing JWT's ``exp`` passes. Uses the stored Direct Casts token and
    closes 4403 with the HTTP detail as the close reason
    (``messaging_token_missing`` / ``_expired`` / ``_rejected``) when there
    is none or upstream refuses it.
    """
    await websocket.accept()
    redis = websocket.app.state.redis
    try:
        claims = await _consume_ws_ticket(redis, ticket) if ticket is not None else None
    except (RedisError, OSError) as exc:
        logger.warning("[messages] events auth failed (%s)", type(exc).__name__)
        await _close_quietly(websocket, WS_CLOSE_INTERNAL)
        return
    if claims is None:
        await _close_quietly(
            websocket, WS_CLOSE_UNAUTHORIZED, WS_CLOSE_REASON_TICKET_REJECTED
        )
        return
    fid, session_expires_at = claims
    service = get_direct_cast_service(websocket)
    session_factory = get_messages_session_factory()
    try:
        if await _over_rate_limit(redis, "events", fid):
            await _close_quietly(websocket, WS_CLOSE_RATE_LIMITED)
            return
        async with session_factory() as db:
            await service.authorize(db, fid=fid)
        lease = await try_acquire_connection_lease(
            redis,
            f"{WS_CONNECTION_KEY_PREFIX}{fid}",
            limit=settings.MESSAGES_WS_MAX_PER_FID,
            ttl_seconds=WS_CONNECTION_LEASE_TTL_SECONDS,
        )
    except MessagingError as exc:
        await _close_for_error(websocket, exc)
        return
    except (RedisError, OSError, SQLAlchemyError) as exc:
        logger.warning("[messages] events setup failed (%s)", type(exc).__name__)
        await _close_quietly(websocket, WS_CLOSE_INTERNAL)
        return
    if lease is None:
        await _close_quietly(
            websocket, WS_CLOSE_RATE_LIMITED, WS_CLOSE_REASON_TOO_MANY_CONNECTIONS
        )
        return
    try:
        await _stream_events(
            websocket,
            redis=redis,
            service=service,
            session_factory=session_factory,
            fid=fid,
            session_expires_at=session_expires_at,
            lease=lease,
        )
    finally:
        with contextlib.suppress(RedisError, OSError):
            await lease.release()


async def _stream_events(
    websocket: WebSocket,
    *,
    redis: Any,
    service: DirectCastService,
    session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]],
    fid: int,
    session_expires_at: int | None,
    lease: ConnectionLease,
) -> None:
    """Relay loop for one authenticated, leased ``/events`` socket."""

    if settings.MESSAGING_RELAY_ENABLED:
        UpstreamRelay.ensure_started()

    poller = InboxPoller(
        service=service,
        redis=redis,
        session_factory=session_factory,
        interval_seconds=direct_cast_relay.POLL_INTERVAL_SECONDS,
    )
    channel = events_channel(fid)
    pubsub = pubsub_redis(websocket.app).pubsub()
    try:
        await pubsub.subscribe(channel)
    except (RedisError, OSError) as exc:
        logger.warning("[messages] events subscribe failed (%s)", type(exc).__name__)
        with contextlib.suppress(RedisError, OSError):
            await pubsub.aclose()
        await _close_quietly(websocket, WS_CLOSE_INTERNAL)
        return
    disconnected = asyncio.Event()
    receiver = asyncio.create_task(_drain_client_frames(websocket, disconnected))
    loop = asyncio.get_running_loop()
    next_poll_at = loop.time()
    last_sent_at = loop.time()
    close_error: MessagingError | None = None
    session_expired = False
    messaging_disabled = False
    try:
        while not disconnected.is_set():
            now = loop.time()
            if now >= next_poll_at:
                next_poll_at = now + direct_cast_relay.POLL_INTERVAL_SECONDS
                if _session_expired(session_expires_at):
                    session_expired = True
                    break
                # The HTTP gate is a router dependency evaluated once at
                # connect; re-check so flipping the kill switch drops live
                # sockets too.
                if not settings.MESSAGING_ENABLED:
                    messaging_disabled = True
                    break
                with contextlib.suppress(RedisError, OSError):
                    await lease.renew()
                try:
                    await poller.tick(fid)
                except MessagingError as exc:
                    if exc.status_code == status.HTTP_403_FORBIDDEN:
                        close_error = exc
                        break
                    # Transient upstream failure: keep the socket, retry next tick.
                    logger.info("[messages] poll tick failed: %s", exc.code)
            try:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=WS_RECEIVE_TIMEOUT_SECONDS,
                )
            except (RedisError, OSError) as exc:
                # Like ``InboxPoller.tick``: keep the socket, retry next loop.
                logger.warning(
                    "[messages] events pubsub read failed (%s)", type(exc).__name__
                )
                await asyncio.sleep(WS_RECEIVE_TIMEOUT_SECONDS)
                continue
            if message:
                payload = _decode_event(message)
                if payload is None:
                    continue
                await websocket.send_json(payload)
                last_sent_at = loop.time()
            elif loop.time() - last_sent_at >= WS_IDLE_PING_SECONDS:
                await websocket.send_json(
                    MessagesEvent(type="ping").model_dump(
                        mode="json", exclude_none=True
                    )
                )
                last_sent_at = loop.time()
            await asyncio.sleep(0)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        receiver.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await receiver
        # aclose() alone resets the pubsub and releases its pooled
        # connection even if Redis is down (unsubscribe could raise first).
        with contextlib.suppress(RedisError, OSError):
            await pubsub.aclose()
    if session_expired:
        await _close_quietly(
            websocket, WS_CLOSE_UNAUTHORIZED, WS_CLOSE_REASON_SESSION_EXPIRED
        )
    elif messaging_disabled:
        await _close_quietly(
            websocket, WS_CLOSE_NOT_FOUND, WS_CLOSE_REASON_MESSAGING_DISABLED
        )
    elif close_error is not None:
        await _close_for_error(websocket, close_error)
