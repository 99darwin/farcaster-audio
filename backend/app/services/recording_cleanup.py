"""
Recording retention cleanup.

Deletes recording files from object storage and clears ``rooms.recording_url``
for any room whose recording is older than the retention window (default 30
days). Exposed via an admin HTTP endpoint so Railway scheduled jobs can
trigger it daily — this avoids standing up a Celery/beat worker just for
this one task.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.room import Room
from app.services.storage_service import StorageService, extract_recording_s3_key

logger = logging.getLogger(__name__)

DEFAULT_RETENTION_DAYS = 30


# Backwards-compat alias for tests that import the private helper from this
# module. Points at the hardened shared implementation in ``storage_service``.
_extract_s3_key = extract_recording_s3_key


async def cleanup_expired_recordings(
    db: AsyncSession,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    storage: StorageService | None = None,
) -> dict:
    """Delete recording objects and clear URLs for rooms past the retention window.

    Returns a summary ``{"scanned": n, "deleted": n, "errors": n}`` so admin
    callers / scheduled jobs can verify the run.

    Security: if we can't derive a valid S3 key from a row's
    ``recording_url`` we SKIP the row entirely (and log). Silently clearing
    the column on a bad URL would let an attacker who slipped a malformed
    URL through the egress webhook wipe legitimate recordings off users'
    profiles.
    """
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=retention_days)

    result = await db.execute(
        select(Room).where(
            Room.recording_url.is_not(None),
            Room.ended_at.is_not(None),
            Room.ended_at < cutoff,
        )
    )
    expired = list(result.scalars().all())

    if not expired:
        return {"scanned": 0, "deleted": 0, "errors": 0}

    storage = storage or StorageService()

    deleted = 0
    errors = 0
    skipped = 0
    for room in expired:
        key = extract_recording_s3_key(room.recording_url or "")
        if not key:
            skipped += 1
            logger.warning(
                "Skipping room %s during cleanup: recording_url failed host/key "
                "validation and will NOT be cleared",
                room.id,
            )
            continue

        try:
            storage.delete_object(key)
        except Exception:
            errors += 1
            logger.exception(
                "Failed to delete recording object key=%s (room=%s)",
                key,
                room.id,
            )
            # Don't clear the URL on S3 failure — we'll retry on the next run.
            continue

        await db.execute(
            update(Room).where(Room.id == room.id).values(recording_url=None)
        )
        deleted += 1

    await db.commit()

    logger.info(
        "Recording cleanup: scanned=%d deleted=%d errors=%d skipped=%d (retention=%dd)",
        len(expired),
        deleted,
        errors,
        skipped,
        retention_days,
    )
    return {
        "scanned": len(expired),
        "deleted": deleted,
        "errors": errors,
        "skipped": skipped,
    }
