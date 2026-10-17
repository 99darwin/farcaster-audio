"""Sequential publisher for Twitter-style cast threads.

Every segment is validated (embeds, byte length, mentions, channel) before
anything is published, so a bad segment can never strand a half-thread.
Segments are then signed and submitted strictly in order: each reply's
``parent_cast_id`` is the previous segment's message hash, which Juke knows
locally the moment it signs, so the chain can never fork or land out of
order. A segment is signed exactly once and the *same bytes* are resubmitted
on transient failure; the node treats a resubmit as a duplicate, which makes
retries idempotent.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import farcaster_messages as fm
from app.clients.proto import message_pb2
from app.services import farcaster_writes
from app.services.cast_ledger import record_cast
from app.services.farcaster_writes import MentionResolver, PreparedCast, Signer

logger = logging.getLogger(__name__)

MAX_SEGMENT_RETRIES = 2
RETRY_BACKOFF_SECONDS = (0.5, 1.0)
# Wall-clock budget for one whole thread. Without it, 10 segments x 3 attempts
# against a degraded node could hold a worker and a pooled DB connection for
# minutes. A healthy full thread completes in seconds.
THREAD_PUBLISH_BUDGET_SECONDS = 180.0
TRANSIENT_ERROR_MESSAGE = "Upstream temporarily unavailable"
PERMANENT_ERROR_MESSAGE = "Upstream rejected the cast"
BUDGET_EXHAUSTED_MESSAGE = "Thread publish timed out before all segments were sent"


@dataclass(frozen=True)
class ThreadSegmentInput:
    """One segment of a thread, already validated and normalized."""

    text: str
    embed_urls: tuple[str, ...] = ()
    quote_fid: int | None = None
    quote_hash: str | None = None


@dataclass(frozen=True)
class ThreadPublishOutcome:
    """Result of a sequential thread publish.

    ``hashes`` always holds the contiguous prefix of successfully published
    segments in order. ``failed_index`` is None when every segment landed.
    """

    hashes: list[str]
    failed_index: int | None = None
    error: str | None = None


@dataclass(frozen=True)
class _SegmentFailure(Exception):
    sanitized_message: str
    transient: bool
    cause: fm.SubmitMessageError | None = None


async def _prepare_segments(
    segments: Sequence[ThreadSegmentInput], *, channel_id: str | None
) -> list[PreparedCast]:
    """Validate every segment up front; raises before anything is published.

    One resolver is shared by the whole thread, so the mention-lookup cap
    bounds the request rather than each segment.
    """
    resolver = MentionResolver()
    prepared: list[PreparedCast] = []
    for index, segment in enumerate(segments):
        quote = None
        if segment.quote_fid is not None and segment.quote_hash is not None:
            quote = farcaster_writes.cast_ref(segment.quote_fid, segment.quote_hash)
        prepared.append(
            await farcaster_writes.prepare_cast(
                text=segment.text,
                embed_urls=segment.embed_urls,
                quote=quote,
                # The channel applies to the root cast only; replies inherit it.
                channel_id=channel_id if index == 0 else None,
                resolve_username=resolver,
            )
        )
    return prepared


async def _submit_once(message: message_pb2.Message) -> str:
    try:
        return await farcaster_writes.submit(message)
    except fm.SubmitMessageError as exc:
        transient = farcaster_writes.is_transient_submit_error(exc)
        message_text = TRANSIENT_ERROR_MESSAGE if transient else PERMANENT_ERROR_MESSAGE
        raise _SegmentFailure(message_text, transient, exc) from None


async def _submit_with_retries(
    message: message_pb2.Message, *, index: int, deadline: float
) -> str:
    """Submit one signed segment, resubmitting the same bytes on transient errors."""
    last_failure: _SegmentFailure | None = None
    for attempt in range(1 + MAX_SEGMENT_RETRIES):
        if attempt > 0:
            backoff = RETRY_BACKOFF_SECONDS[attempt - 1]
            if time.monotonic() + backoff >= deadline:
                # Surface the real upstream failure over the budget message.
                raise last_failure or _SegmentFailure(BUDGET_EXHAUSTED_MESSAGE, True)
            await asyncio.sleep(backoff)
        try:
            return await _submit_once(message)
        except _SegmentFailure as failure:
            last_failure = failure
            if not failure.transient:
                break
            logger.warning(
                "[cast-thread] transient failure segment=%d attempt=%d",
                index,
                attempt + 1,
            )
    if last_failure is None:  # pragma: no cover - loop always runs
        raise _SegmentFailure(PERMANENT_ERROR_MESSAGE, False)
    raise last_failure


async def publish_thread(
    db: AsyncSession,
    *,
    signer: Signer,
    segments: Sequence[ThreadSegmentInput],
    parent: str | None = None,
    channel_id: str | None = None,
    budget_seconds: float = THREAD_PUBLISH_BUDGET_SECONDS,
) -> ThreadPublishOutcome:
    """Publish an ordered thread: root cast, then each reply to the previous.

    Validation, mention/channel resolution and the root parent lookup all
    happen first and raise (``CastValidationError``, ``CastNotFoundError``,
    ``HypersnapError``) with nothing published. Publishing then stops at the
    first segment that permanently fails (or exhausts retries) and returns
    the published prefix. The wall-clock budget is only checked between
    attempts, never mid-request. Every published cast is recorded in the cast
    ledger.
    """
    deadline = time.monotonic() + budget_seconds
    prepared = await _prepare_segments(segments, channel_id=channel_id)
    previous: fm.CastRef | None = await farcaster_writes.resolve_parent(parent)

    hashes: list[str] = []
    for index, content in enumerate(prepared):
        if time.monotonic() >= deadline:
            return ThreadPublishOutcome(
                hashes=hashes, failed_index=index, error=BUDGET_EXHAUSTED_MESSAGE
            )
        message = farcaster_writes.build_cast(signer, content, parent=previous)
        try:
            cast_hash = await _submit_with_retries(
                message, index=index, deadline=deadline
            )
        except _SegmentFailure as failure:
            if (
                index == 0
                and failure.cause is not None
                and farcaster_writes.is_signer_rejection(failure.cause)
            ):
                # Nothing published and the signer is unknown to the node:
                # surface it so the router answers 403 signer_not_linked.
                raise failure.cause from None
            logger.warning(
                "[cast-thread] thread stopped fid=%d segment=%d published=%d",
                signer.fid,
                index,
                len(hashes),
            )
            return ThreadPublishOutcome(
                hashes=hashes, failed_index=index, error=failure.sanitized_message
            )
        await record_cast(db, fid=signer.fid, cast_hash=cast_hash, source="composer")
        hashes.append(cast_hash)
        previous = fm.CastRef(fid=signer.fid, hash=message.hash)
    return ThreadPublishOutcome(hashes=hashes)
