"""
Recordings router — public discovery feed and detail page for space recordings.

The per-user listing endpoint lives at /v1/users/{fid}/recordings (auth-required).
This router exposes the global feed (`/recent`) and a single-recording detail
endpoint (`/{room_id}`) used to render share previews and the miniapp player.
Both are public and IP-rate-limited.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, get_redis
from app.models.room import Room
from app.models.user import User
from app.schemas.room import (
    RecordingFeedHost,
    RecordingFeedItem,
    RecordingFeedResponse,
    RecordingResponse,
)
from app.services.storage_service import StorageService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/recordings", tags=["recordings"])

RECORDING_RETENTION_DAYS = 30
RECENT_RATE_LIMIT_WINDOW = 60
RECENT_RATE_LIMIT_MAX = 30
DETAIL_RATE_LIMIT_WINDOW = 60
DETAIL_RATE_LIMIT_MAX = 60
PRESIGN_TTL_SECONDS = 15 * 60


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _resolve_recording_url(
    room: Room, storage: StorageService | None
) -> tuple[str, StorageService | None]:
    """Mint a presigned GET if we have a key, else fall back to legacy URL.

    Returns (url, storage) so callers can reuse the same StorageService
    instance across rows in the feed endpoint without paying repeated init.
    """
    if room.recording_key:
        if storage is None:
            storage = StorageService()
        try:
            url = storage.generate_presigned_get_url(
                room.recording_key, expires_in=PRESIGN_TTL_SECONDS
            )
            return url, storage
        except Exception:
            logger.exception(
                "Failed to presign recording for room=%s key=%s",
                room.id,
                room.recording_key,
            )
            return "", storage
    if room.recording_url:
        return room.recording_url, storage
    return "", storage


def _build_recording_response(room: Room, url: str) -> RecordingResponse:
    duration_seconds: int | None = None
    if room.ended_at and room.started_at:
        duration_seconds = max(
            0, int((room.ended_at - room.started_at).total_seconds())
        )
    return RecordingResponse(
        room_id=str(room.id),
        title=room.title,
        recording_url=url,
        started_at=room.started_at.isoformat() if room.started_at else "",
        ended_at=room.ended_at.isoformat() if room.ended_at else None,
        duration_seconds=duration_seconds,
        cast_hash=room.cast_hash,
    )


def _build_host_response(user: User) -> RecordingFeedHost:
    return RecordingFeedHost(
        fid=user.fid,
        username=user.username or "",
        display_name=user.display_name or user.username or f"fid:{user.fid}",
        pfp_url=user.pfp_url,
    )


@router.get("/recent", response_model=RecordingFeedResponse)
async def get_recent_recordings(
    request: Request,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> RecordingFeedResponse:
    """Public global feed of recent space recordings within the retention window.

    Mirrors /v1/voice-notes/recent: no auth, IP-rate-limited, cursor pagination.
    Recordings are public-by-design — hosts opt in by toggling REC on a space.
    """
    rate_key = f"recordings:recent_rate:{_client_ip(request)}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, RECENT_RATE_LIMIT_WINDOW)
    count, _ = await pipe.execute()
    if count > RECENT_RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    cutoff = datetime.now(tz=timezone.utc) - timedelta(
        days=RECORDING_RETENTION_DAYS
    )

    query = (
        select(Room, User)
        .join(User, User.fid == Room.host_fid)
        .where(
            Room.recording_url.is_not(None),
            Room.recording_url != "",
            Room.status != "deleted",
            Room.started_at >= cutoff,
        )
        .order_by(Room.started_at.desc())
        .limit(limit + 1)
    )

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor")
        query = query.where(Room.started_at < cursor_dt)

    result = await db.execute(query)
    rows = list(result.all())

    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last_room = rows[-1][0]
        next_cursor = (
            last_room.started_at.isoformat() if last_room.started_at else None
        )

    storage: StorageService | None = None
    items: list[RecordingFeedItem] = []
    for room, user in rows:
        url, storage = _resolve_recording_url(room, storage)
        # Skip rows we can't serve a URL for rather than returning broken
        # links. Pagination cursor is computed from the raw row set above
        # so dropping individual items here doesn't break the next page.
        if not url:
            continue
        items.append(
            RecordingFeedItem(
                recording=_build_recording_response(room, url),
                host=_build_host_response(user),
            )
        )

    return RecordingFeedResponse(items=items, next_cursor=next_cursor)


@router.get("/{room_id}", response_model=RecordingFeedItem)
async def get_recording_detail(
    request: Request,
    room_id: str = Path(..., min_length=1),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> RecordingFeedItem:
    """Public single-recording detail used to render share previews and the
    miniapp player. Returns 404 once the recording falls outside retention or
    if the row has been deleted.
    """
    rate_key = f"recordings:detail_rate:{_client_ip(request)}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, DETAIL_RATE_LIMIT_WINDOW)
    count, _ = await pipe.execute()
    if count > DETAIL_RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    try:
        room_uuid = uuid.UUID(room_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Recording not found")

    cutoff = datetime.now(tz=timezone.utc) - timedelta(
        days=RECORDING_RETENTION_DAYS
    )

    result = await db.execute(
        select(Room, User)
        .join(User, User.fid == Room.host_fid)
        .where(
            Room.id == room_uuid,
            Room.recording_url.is_not(None),
            Room.recording_url != "",
            Room.status != "deleted",
            Room.started_at >= cutoff,
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Recording not found")

    room, user = row
    url, _ = _resolve_recording_url(room, None)
    if not url:
        raise HTTPException(status_code=404, detail="Recording not found")

    return RecordingFeedItem(
        recording=_build_recording_response(room, url),
        host=_build_host_response(user),
    )
