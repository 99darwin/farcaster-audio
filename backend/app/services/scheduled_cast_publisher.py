"""Durable publisher loop for scheduled Farcaster casts.

Multiple application workers may run this service concurrently. Claims use
``FOR UPDATE SKIP LOCKED`` and are committed before the external request. A
bounded lease recovers process crashes. Retries are idempotent because the
message timestamp is pinned to the job's server-validated ``scheduled_for``
and mention lookups never degrade (an upstream failure fails the attempt):
re-signing the same job yields the same message hash, and the node treats a
resubmit as a duplicate.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.clients import farcaster_messages as fm
from app.clients import hypersnap
from app.models.scheduled_cast import ScheduledCast
from app.services import farcaster_writes
from app.services.cast_ledger import record_cast
from app.services.signer_crypto import SignerDecryptError, SignerKeyConfigError
from app.services.user_signer_service import SignerNotApprovedError

logger = logging.getLogger(__name__)

TRANSIENT_ERROR_MESSAGE = "Upstream temporarily unavailable"
REJECTED_ERROR_MESSAGE = "Upstream rejected the scheduled cast"
INVALID_CAST_MESSAGE = "Scheduled cast is no longer valid"
NO_SIGNER_MESSAGE = "No approved Farcaster signer is available"
SIGNER_UNAVAILABLE_MESSAGE = "Signer temporarily unavailable"
PUBLISH_INTERVAL_SECONDS = 5.0
CLAIM_BATCH_SIZE = 10
PUBLISH_ATTEMPT_TIMEOUT_SECONDS = 20
CLAIM_LEASE_SAFETY_SECONDS = 30
CLAIM_LEASE_SECONDS = (
    CLAIM_BATCH_SIZE * PUBLISH_ATTEMPT_TIMEOUT_SECONDS + CLAIM_LEASE_SAFETY_SECONDS
)
MAX_PUBLISH_ATTEMPTS = 6
RETRY_BASE_SECONDS = 30
RETRY_MAX_SECONDS = 15 * 60
MAX_ACTIVE_SCHEDULED_CASTS_PER_USER = 100


def utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


@dataclass(frozen=True)
class _PublishFailure(Exception):
    sanitized_message: str
    transient: bool


class ScheduledCastPublisher:
    def __init__(
        self,
        session_maker: async_sessionmaker[AsyncSession],
        *,
        interval_seconds: float = PUBLISH_INTERVAL_SECONDS,
        batch_size: int = CLAIM_BATCH_SIZE,
        lease_seconds: int | None = None,
    ) -> None:
        self._session_maker = session_maker
        self._interval_seconds = interval_seconds
        self._batch_size = batch_size
        # Jobs are published sequentially. Enforce a lease long enough for the
        # final job in the batch to complete its bounded attempt; otherwise a
        # second Gunicorn worker could reclaim it while the first is still
        # publishing. The deterministic message hash is the crash backstop.
        minimum_lease = (
            batch_size * PUBLISH_ATTEMPT_TIMEOUT_SECONDS + CLAIM_LEASE_SAFETY_SECONDS
        )
        self._lease_seconds = max(lease_seconds or 0, minimum_lease)
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(
            self._run_forever(), name="scheduled-cast-publisher"
        )

    async def stop(self) -> None:
        self._stop_event.set()
        task = self._task
        if task is None:
            return
        if not task.done():
            task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        self._task = None

    async def _run_forever(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.process_once()
            except Exception as exc:  # noqa: BLE001 - keep the worker alive
                logger.error(
                    "[scheduled-casts] publisher pass failed: %s",
                    type(exc).__name__,
                )
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self._interval_seconds
                )
            except asyncio.TimeoutError:
                continue

    async def process_once(self) -> dict[str, int]:
        claimed = await self._claim_due_jobs()
        counts = {"claimed": len(claimed), "published": 0, "retried": 0, "failed": 0}
        for job in claimed:
            # Jobs at the attempt ceiling are finalized by the claim transaction
            # and deliberately never sent upstream again.
            if job.status == "failed":
                counts["failed"] += 1
                continue
            try:
                async with asyncio.timeout(PUBLISH_ATTEMPT_TIMEOUT_SECONDS):
                    cast_hash = await self._publish(job)
            except TimeoutError:
                failure = _PublishFailure(TRANSIENT_ERROR_MESSAGE, True)
            except _PublishFailure as exc:
                failure = exc
            except Exception as exc:  # noqa: BLE001 - sanitize unknown failures
                logger.error(
                    "[scheduled-casts] unexpected publish failure job=%s: %s",
                    job.id,
                    type(exc).__name__,
                )
                failure = _PublishFailure(TRANSIENT_ERROR_MESSAGE, True)
            else:
                if await self._record_success(job, cast_hash):
                    counts["published"] += 1
                continue
            final_status = await self._record_failure(job, failure)
            if final_status == "retrying":
                counts["retried"] += 1
            elif final_status == "failed":
                counts["failed"] += 1
        return counts

    async def _claim_due_jobs(self) -> list[ScheduledCast]:
        now = utcnow()
        lease_expires = now + timedelta(seconds=self._lease_seconds)
        async with self._session_maker() as db:
            result = await db.execute(
                select(ScheduledCast)
                .where(
                    or_(
                        and_(
                            ScheduledCast.status.in_(("pending", "retrying")),
                            ScheduledCast.next_attempt_at <= now,
                        ),
                        and_(
                            ScheduledCast.status == "processing",
                            ScheduledCast.lease_expires_at <= now,
                        ),
                    )
                )
                .order_by(ScheduledCast.next_attempt_at, ScheduledCast.id)
                .limit(self._batch_size)
                .with_for_update(skip_locked=True)
            )
            jobs = list(result.scalars().all())
            for job in jobs:
                stale_claim = job.status == "processing"
                if not stale_claim and job.attempts >= MAX_PUBLISH_ATTEMPTS:
                    job.status = "failed"
                    job.last_error = "Retry limit reached"
                    job.lease_expires_at = None
                    job.updated_at = now
                    continue
                job.status = "processing"
                # A stale processing row is an ambiguous prior request, not a
                # fresh logical attempt. Re-sign the same message without
                # consuming another retry; this also lets a final-attempt crash
                # recover the canonical success instead of falsely failing it.
                if stale_claim:
                    job.attempts = max(1, job.attempts)
                else:
                    job.attempts += 1
                job.lease_expires_at = lease_expires
                job.last_error = None
                job.updated_at = now
            await db.commit()
            return jobs

    async def _publish(self, job: ScheduledCast) -> str:
        try:
            async with self._session_maker() as db:
                signer = await farcaster_writes.load_user_signer(db, job.fid)
        except SignerNotApprovedError:
            raise _PublishFailure(NO_SIGNER_MESSAGE, False) from None
        except (SignerKeyConfigError, SignerDecryptError):
            raise _PublishFailure(SIGNER_UNAVAILABLE_MESSAGE, True) from None

        try:
            quote = None
            if job.quote_fid is not None and job.quote_hash is not None:
                quote = farcaster_writes.cast_ref(job.quote_fid, job.quote_hash)
            return await farcaster_writes.publish_cast(
                signer,
                text=job.text,
                embed_urls=job.embeds or [],
                quote=quote,
                parent_hash=job.parent,
                channel_id=job.channel_id,
                # Strict lookups: a degraded mention would change the message
                # hash and defeat the duplicate-resubmit idempotency.
                resolve_username=farcaster_writes.MentionResolver(
                    farcaster_writes.fetch_username_fid
                ),
                timestamp=_message_timestamp(job),
            )
        except (
            farcaster_writes.CastValidationError,
            farcaster_writes.CastNotFoundError,
            fm.MessageBuildError,
        ):
            raise _PublishFailure(INVALID_CAST_MESSAGE, False) from None
        except fm.SubmitMessageError as exc:
            logger.warning(
                "[scheduled-casts] publish rejected job=%s status=%s code=%s",
                job.id,
                exc.status_code,
                exc.err_code,
            )
            if farcaster_writes.is_signer_rejection(exc):
                raise _PublishFailure(NO_SIGNER_MESSAGE, False) from None
            if farcaster_writes.is_transient_submit_error(exc):
                raise _PublishFailure(TRANSIENT_ERROR_MESSAGE, True) from None
            raise _PublishFailure(REJECTED_ERROR_MESSAGE, False) from None
        except hypersnap.HypersnapError:
            raise _PublishFailure(TRANSIENT_ERROR_MESSAGE, True) from None

    def _claim_matches(self, job: ScheduledCast):
        return and_(
            ScheduledCast.id == job.id,
            ScheduledCast.status == "processing",
            ScheduledCast.attempts == job.attempts,
            ScheduledCast.lease_expires_at == job.lease_expires_at,
        )

    async def _record_success(self, job: ScheduledCast, cast_hash: str) -> bool:
        now = utcnow()
        async with self._session_maker() as db:
            result = await db.execute(
                update(ScheduledCast)
                .where(self._claim_matches(job))
                .values(
                    status="published",
                    published_hash=cast_hash,
                    published_at=now,
                    updated_at=now,
                    lease_expires_at=None,
                    last_error=None,
                )
            )
            await db.commit()
            recorded = bool(result.rowcount)
            if recorded:
                await record_cast(
                    db, fid=job.fid, cast_hash=cast_hash, source="scheduled"
                )
            return recorded

    async def _record_failure(
        self, job: ScheduledCast, failure: _PublishFailure
    ) -> str | None:
        now = utcnow()
        should_retry = failure.transient and job.attempts < MAX_PUBLISH_ATTEMPTS
        values: dict = {
            "status": "retrying" if should_retry else "failed",
            "last_error": failure.sanitized_message[:256],
            "updated_at": now,
            "lease_expires_at": None,
        }
        if should_retry:
            delay = min(
                RETRY_MAX_SECONDS,
                RETRY_BASE_SECONDS * (2 ** max(0, job.attempts - 1)),
            )
            values["next_attempt_at"] = now + timedelta(seconds=delay)
        async with self._session_maker() as db:
            result = await db.execute(
                update(ScheduledCast).where(self._claim_matches(job)).values(**values)
            )
            await db.commit()
            return values["status"] if result.rowcount else None


def _message_timestamp(job: ScheduledCast) -> int:
    """Pin the message timestamp to ``scheduled_for`` for idempotent retries.

    ``scheduled_for`` was validated server-side to lie 30s-365d in the future
    at scheduling time and the job only runs once it has passed, so it can
    neither backdate the cast nor sit in the future when submitted.
    """
    scheduled_for = job.scheduled_for
    if scheduled_for.tzinfo is None:
        scheduled_for = scheduled_for.replace(tzinfo=timezone.utc)
    return fm.farcaster_timestamp(scheduled_for)
