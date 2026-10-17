"""Realtime fan-out for ``WS /v1/messages/events`` (docs section 3.4).

Phase A (implemented): a per-fid poller. While at least one socket for a fid
is open, ticks every :data:`POLL_INTERVAL_SECONDS` fetch the first default
inbox page through :class:`DirectCastService` (so the 3 s read cache absorbs
multiple sockets / tabs), diff it against the previous snapshot stored in
Redis, and publish ``MessagesEvent`` frames on ``messages:events:{fid}``.
Every open socket for that fid is subscribed to the channel, so a single
tick serves all of them. A short ``SET NX`` lock elects one ticker per fid
per interval across sockets and API replicas.

Phase B (``MESSAGING_RELAY_ENABLED``): an upstream WS relay to
``wss://ws.farcaster.xyz/stream`` publishing onto the same channel.
**Stubbed** — :class:`UpstreamRelay` logs once and the poller keeps running,
so flipping the flag is safe but changes nothing until B1 verifies the
upstream socket's frame shapes.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from contextlib import AbstractAsyncContextManager
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.messages import Conversation, InboxResponse, Message, MessagesEvent
from app.services.direct_cast_service import DirectCastService

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 5.0
# Lock slightly shorter than the interval so the next tick can always win it.
POLL_LOCK_FRACTION = 0.8
MS_PER_SECOND = 1000
POLL_INBOX_LIMIT = 25
SNAPSHOT_TTL_SECONDS = 3600
EVENTS_CHANNEL_PREFIX = "messages:events:"
SNAPSHOT_KEY_PREFIX = "messages:inbox_snapshot:"
POLL_LOCK_PREFIX = "messages:poller:"

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]
# conversation_id -> [last_message_id, unread_count, last_read_at,
# peer_last_read_at]. Snapshots written before peer_last_read_at existed
# have three entries; a missing fourth is treated as "unchanged".
InboxSnapshot = dict[str, list[Any]]
SNAPSHOT_PEER_READ_INDEX = 3
# Reserved snapshot entry ``[max last_message.sent_at]`` of the page. Not a
# valid conversation id (``ID_PATTERN`` has no ``~``), so it cannot collide.
# Absent in snapshots written before it existed (watermark unknown).
SNAPSHOT_WATERMARK_KEY = "~watermark"


def events_channel(fid: int) -> str:
    return f"{EVENTS_CHANNEL_PREFIX}{fid}"


def snapshot_inbox(inbox: InboxResponse) -> InboxSnapshot:
    snapshot: InboxSnapshot = {
        conversation.conversation_id: [
            conversation.last_message.message_id if conversation.last_message else None,
            conversation.unread_count,
            conversation.last_read_at,
            conversation.peer_last_read_at,
        ]
        for conversation in inbox.items
    }
    snapshot[SNAPSHOT_WATERMARK_KEY] = [
        max(
            (c.last_message.sent_at for c in inbox.items if c.last_message),
            default=0,
        )
    ]
    return snapshot


def _watermark(previous: Mapping[str, list[Any]]) -> int | None:
    entry = previous.get(SNAPSHOT_WATERMARK_KEY)
    if not isinstance(entry, list) or not entry:
        return None
    value = entry[0]
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _is_newer_than_watermark(
    last_message: Message | None, watermark: int | None
) -> bool:
    """Only a message newer than everything the last tick saw is new; an
    unknown watermark (pre-watermark snapshot) never counts as newer."""
    return (
        last_message is not None
        and watermark is not None
        and last_message.sent_at > watermark
    )


def _event_for(
    conversation: Conversation, previous: list[Any] | None, watermark: int | None
) -> MessagesEvent | None:
    conversation_id = conversation.conversation_id
    last_message = conversation.last_message
    last_message_id = last_message.message_id if last_message else None
    if previous is None:
        # Newly in the first page. Not newer than the watermark means it
        # moved for another reason (an archive/unarchive, a request
        # accepted, a row falling off below): "inbox" so clients refetch
        # without a spurious notification.
        if _is_newer_than_watermark(last_message, watermark):
            return MessagesEvent(
                type="message", conversation_id=conversation_id, message=last_message
            )
        return MessagesEvent(type="inbox", conversation_id=conversation_id)
    prev_message_id, prev_unread, prev_last_read = previous[:SNAPSHOT_PEER_READ_INDEX]
    prev_peer_read = (
        previous[SNAPSHOT_PEER_READ_INDEX]
        if len(previous) > SNAPSHOT_PEER_READ_INDEX
        else conversation.peer_last_read_at
    )
    if last_message_id != prev_message_id:
        # A changed last message is only "message" when it is new; a delete
        # that leaves an older message last is "inbox" (refetch, no ping).
        if _is_newer_than_watermark(last_message, watermark):
            return MessagesEvent(
                type="message", conversation_id=conversation_id, message=last_message
            )
        return MessagesEvent(type="inbox", conversation_id=conversation_id)
    if conversation.unread_count < prev_unread or (
        conversation.last_read_at != prev_last_read
    ):
        return MessagesEvent(
            type="read", conversation_id=conversation_id, read_by="viewer"
        )
    if conversation.peer_last_read_at != prev_peer_read:
        return MessagesEvent(
            type="read", conversation_id=conversation_id, read_by="peer"
        )
    if conversation.unread_count != prev_unread:
        return MessagesEvent(type="inbox", conversation_id=conversation_id)
    return None


def diff_inbox(
    previous: Mapping[str, list[Any]] | None, inbox: InboxResponse
) -> list[MessagesEvent]:
    """Pure: events implied by moving from ``previous`` to ``inbox``.

    The first tick (``previous is None``) only establishes a baseline. A
    conversation that drops off the first page emits ``inbox`` so clients
    refetch rather than trusting a stale row; one that newly appears emits
    ``message`` only if its last message is newer than the previous tick's
    watermark (else ``inbox``).
    """
    if previous is None:
        return []
    watermark = _watermark(previous)
    events = [
        event
        for conversation in inbox.items
        if (
            event := _event_for(
                conversation, previous.get(conversation.conversation_id), watermark
            )
        )
    ]
    current_ids = {conversation.conversation_id for conversation in inbox.items}
    events.extend(
        MessagesEvent(type="inbox", conversation_id=conversation_id)
        for conversation_id in previous
        if conversation_id not in current_ids
        and conversation_id != SNAPSHOT_WATERMARK_KEY
    )
    return events


class InboxPoller:
    """One Phase A tick for one fid. Stateless apart from Redis."""

    def __init__(
        self,
        *,
        service: DirectCastService,
        redis: Any,
        session_factory: SessionFactory,
        interval_seconds: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self._service = service
        self._redis = redis
        self._session_factory = session_factory
        self._interval_seconds = interval_seconds

    async def _acquire_tick(self, fid: int) -> bool:
        lock_ms = max(
            1, int(self._interval_seconds * POLL_LOCK_FRACTION * MS_PER_SECOND)
        )
        try:
            return bool(
                await self._redis.set(
                    f"{POLL_LOCK_PREFIX}{fid}", "1", nx=True, px=lock_ms
                )
            )
        except (RedisError, OSError) as exc:
            # Without Redis there is no fan-out either; skip the tick.
            logger.warning("[messages-relay] lock failed (%s)", type(exc).__name__)
            return False

    async def _load_snapshot(self, fid: int) -> InboxSnapshot | None:
        raw = await self._redis.get(f"{SNAPSHOT_KEY_PREFIX}{fid}")
        if not isinstance(raw, (str, bytes)):
            return None
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    async def tick(self, fid: int) -> int:
        """Run one poll if this caller wins the lock; return events published.

        Raises ``MessagingError`` (e.g. token missing/expired/revoked) so the
        socket can close with a meaningful code; Redis errors are swallowed.
        """
        if not await self._acquire_tick(fid):
            return 0
        # Fresh session + freshly loaded stored token every tick: never cached.
        async with self._session_factory() as db:
            viewer = await self._service.authorize(db, fid=fid)
        inbox = await self._service.inbox(
            viewer,
            category="default",
            filter_=None,
            cursor=None,
            limit=POLL_INBOX_LIMIT,
        )
        try:
            previous = await self._load_snapshot(fid)
            events = diff_inbox(previous, inbox)
            await self._redis.set(
                f"{SNAPSHOT_KEY_PREFIX}{fid}",
                json.dumps(snapshot_inbox(inbox)),
                ex=SNAPSHOT_TTL_SECONDS,
            )
            channel = events_channel(fid)
            for event in events:
                await self._redis.publish(
                    channel, event.model_dump_json(exclude_none=True)
                )
        except (RedisError, OSError) as exc:
            logger.warning("[messages-relay] publish failed (%s)", type(exc).__name__)
            return 0
        return len(events)


class UpstreamRelay:
    """Phase B upstream WS relay. STUB: not implemented (see module doc)."""

    _warned = False

    @classmethod
    def ensure_started(cls) -> None:
        if cls._warned:
            return
        cls._warned = True
        logger.warning(
            "[messages-relay] MESSAGING_RELAY_ENABLED is set but the upstream "
            "relay is not implemented; falling back to Phase A polling"
        )
