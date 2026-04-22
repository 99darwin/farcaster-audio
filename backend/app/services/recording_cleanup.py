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
from urllib.parse import urlparse

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.room import Room
from app.services.storage_service import StorageService

logger = logging.getLogger(__name__)

DEFAULT_RETENTION_DAYS = 30


def _extract_s3_key(recording_url: str) -> str | None:
    """Best-effort extraction of the S3 object key from a recording URL.

    LiveKit's egress writes files with filepath like
    ``recordings/{room_id}/{timestamp}.ogg`` and returns a URL of the form
    ``{endpoint}/{bucket}/{key}`` or ``https://{bucket}.s3.{region}.amazonaws.com/{key}``.
    We try to pull the trailing "recordings/..." path out since that's the
    only part we actually need for ``delete_object``.
    """
    if not recording_url:
        return None

    # Already a bare key (defensive)
    if recording_url.startswith("recordings/"):
        return recording_url

    try:
        parsed = urlparse(recording_url)
    except Exception:
        return None

    path = parsed.path.lstrip("/")
    if not path:
        return None

    bucket = settings.AWS_S3_BUCKET_NAME
    # Path-style URL: /{bucket}/{key}
    if bucket and path.startswith(f"{bucket}/"):
        return path[len(bucket) + 1 :]

    # Virtual-hosted-style URL (bucket is already in the host) — return as-is
    return path


async def cleanup_expired_recordings(
    db: AsyncSession,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    storage: StorageService | None = None,
) -> dict:
    """Delete recording objects and clear URLs for rooms past the retention window.

    Returns a summary ``{"scanned": n, "deleted": n, "errors": n}`` so admin
    callers / scheduled jobs can verify the run.
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
    for room in expired:
        key = _extract_s3_key(room.recording_url or "")
        if key:
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
        else:
            logger.warning(
                "Could not derive S3 key from recording_url for room %s; clearing DB anyway",
                room.id,
            )

        await db.execute(
            update(Room).where(Room.id == room.id).values(recording_url=None)
        )
        deleted += 1

    await db.commit()

    logger.info(
        "Recording cleanup: scanned=%d deleted=%d errors=%d (retention=%dd)",
        len(expired),
        deleted,
        errors,
        retention_days,
    )
    return {"scanned": len(expired), "deleted": deleted, "errors": errors}
