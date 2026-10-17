"""
Voice Notes router — upload, create, feed, playback tracking, reactions.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import (
    get_current_user,
    get_db,
    get_optional_current_user,
    get_redis,
    require_non_demo_user,
)
from app.schemas.voice_note import (
    PlayRequest,
    ReactionRequest,
    UploadUrlRequest,
    UploadUrlResponse,
    VoiceNoteCreateRequest,
    VoiceNoteDetailResponse,
    VoiceNoteFeedResponse,
    VoiceNoteResponse,
)
from app.services import voice_note_service
from app.services import farcaster_writes
from app.services.cast_ledger import record_cast
from app.services.client_ip import client_ip
from app.services.rate_limit import RateLimit, enforce_rate_limits
from app.services.farcaster_hydration import invalidate_viewer_reactions
from app.services.social_graph import get_following_fids
from app.services.storage_service import PRESIGNED_UPLOAD_TTL_SECONDS, StorageService
from app.services.voice_upload_service import (
    VoiceUploadError,
    build_voice_note_staging_key,
    discard_staging_upload,
    finalize_voice_upload,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/voice-notes", tags=["voice-notes"])

VOICE_NOTE_URL_TEMPLATE = "https://juke.audio/v/{voice_note_id}"
# Window to finalize (POST /) after requesting an upload slot. The presigned
# PUT itself expires sooner (PRESIGNED_UPLOAD_TTL_SECONDS).
UPLOAD_TTL_SECONDS = 900
RATE_LIMIT_WINDOW_SECONDS = 3600
RATE_LIMIT_MAX_UPLOADS = 20
PLAY_DEDUP_SECONDS = 60  # 1 play per signed-in user per voice note per 60s
# Anonymous plays are keyed by client IP (proxy-aware, unspoofable): one per
# IP per note per day, and a per-IP hourly budget across all notes, so a
# single host can't inflate play counts.
ANONYMOUS_PLAY_DEDUP_SECONDS = 24 * 60 * 60
ANONYMOUS_PLAY_RATE_LIMIT = RateLimit(limit=120, window_seconds=60 * 60)

_storage: StorageService | None = None


def _get_storage() -> StorageService:
    global _storage
    if _storage is None:
        _storage = StorageService()
    return _storage


async def _publish_voice_note_cast(
    signer: farcaster_writes.Signer,
    *,
    text: str,
    voice_note_id: uuid.UUID,
    parent_cast_hash: str | None,
    channel_id: str | None,
) -> str:
    """Cast the voice note's juke.audio link; a reply never targets a channel."""
    return await farcaster_writes.publish_cast(
        signer,
        text=text,
        embed_urls=[VOICE_NOTE_URL_TEMPLATE.format(voice_note_id=voice_note_id)],
        parent_hash=parent_cast_hash,
        channel_id=None if parent_cast_hash else channel_id,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/upload-url", response_model=UploadUrlResponse)
async def request_upload_url(
    body: UploadUrlRequest,
    current_user: int = Depends(require_non_demo_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Generate a presigned PUT URL for uploading voice note audio."""
    # Rate limit: 20 uploads per hour per FID (atomic INCR + EXPIRE)
    rate_key = f"voice_notes:upload_rate:{current_user}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if count > RATE_LIMIT_MAX_UPLOADS:
        raise HTTPException(
            status_code=429, detail="Upload rate limit exceeded (20/hr)"
        )

    upload_id = str(uuid.uuid4())
    object_key = build_voice_note_staging_key(
        current_user, upload_id, body.content_type
    )

    storage = _get_storage()
    upload_url = storage.generate_presigned_upload_url(object_key, body.content_type)

    # Store upload metadata in Redis for finalization
    upload_meta = json.dumps(
        {
            "fid": current_user,
            "object_key": object_key,
            "content_type": body.content_type,
            "duration_ms": body.duration_ms,
        }
    )
    await redis.set(
        f"voice_notes:upload:{upload_id}", upload_meta, ex=UPLOAD_TTL_SECONDS
    )

    expires_at = (
        datetime.now(timezone.utc) + timedelta(seconds=PRESIGNED_UPLOAD_TTL_SECONDS)
    ).isoformat()

    return UploadUrlResponse(
        upload_id=upload_id,
        upload_url=upload_url,
        expires_at=expires_at,
    )


@router.post("/", response_model=VoiceNoteResponse)
async def create_voice_note(
    body: VoiceNoteCreateRequest,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Finalize a voice note after upload completes."""
    if body.post_to_farcaster and body.parent_cast_hash and body.channel_id:
        raise HTTPException(status_code=400, detail="Replies cannot target a channel")

    # Consume the upload token atomically so concurrent finalize calls can't
    # both turn one upload into two voice notes.
    upload_token_key = f"voice_notes:upload:{body.upload_id}"
    upload_meta_raw = await redis.getdel(upload_token_key)
    if not upload_meta_raw:
        raise HTTPException(status_code=400, detail="Invalid or expired upload_id")

    upload_meta = json.loads(upload_meta_raw)
    if upload_meta["fid"] != current_user:
        raise HTTPException(
            status_code=403, detail="Upload does not belong to this user"
        )

    storage = _get_storage()
    staging_key = upload_meta["object_key"]
    try:
        audio = await finalize_voice_upload(
            storage,
            staging_key=staging_key,
            fid=current_user,
            content_type=upload_meta.get("content_type", "audio/mp4"),
        )
    except VoiceUploadError as exc:
        if exc.is_transient:
            # Transient storage/tooling failure: the staged audio is kept, so
            # hand the token back and let the client retry the same upload.
            await redis.set(upload_token_key, upload_meta_raw, ex=UPLOAD_TTL_SECONDS)
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    object_key = audio.object_key

    # Size, duration and waveform are server-derived; the client's
    # duration_ms/audio_size are accepted for compatibility but ignored.
    vn = await voice_note_service.create_voice_note(
        db=db,
        fid=current_user,
        upload_id=body.upload_id,
        duration_ms=audio.duration_ms,
        audio_size=audio.audio_size,
        caption=body.cast_text if body.cast_text else None,
        object_key=object_key,
        parent_cast_hash=body.parent_cast_hash,
        waveform_peaks=audio.waveform_peaks or None,
    )
    await discard_staging_upload(storage, staging_key)

    # Fire-and-forget background processing (transcription)
    from app.workers.voice_note_worker import process_voice_note

    asyncio.create_task(process_voice_note(str(vn.id)))

    # Optionally post to Farcaster
    if body.post_to_farcaster:
        # Best-effort: the voice note is saved even if the mirror cast fails.
        try:
            signer = await farcaster_writes.load_user_signer(db, current_user)
            vn.cast_hash = await _publish_voice_note_cast(
                signer,
                text=body.cast_text or "",
                voice_note_id=vn.id,
                parent_cast_hash=body.parent_cast_hash,
                channel_id=body.channel_id,
            )
            vn.cast_url = None
            await db.commit()
            await db.refresh(vn)
            await record_cast(
                db, fid=current_user, cast_hash=vn.cast_hash, source="voice_note"
            )
        except Exception as exc:  # noqa: BLE001 - mirror cast is best-effort
            logger.error(
                "[voice_notes] Failed to cast voice note %s: %s",
                vn.id,
                type(exc).__name__,
            )

    storage = _get_storage()
    return VoiceNoteResponse(
        id=str(vn.id),
        fid=vn.fid,
        duration_ms=vn.duration_ms,
        audio_url=storage.generate_presigned_get_url(object_key),
        audio_size=vn.audio_size,
        waveform_peaks=vn.waveform_peaks,
        transcript=vn.transcript,
        transcript_lang=vn.transcript_lang,
        transcript_words=vn.transcript_words,
        cast_hash=vn.cast_hash,
        cast_url=vn.cast_url,
        parent_cast_hash=vn.parent_cast_hash,
        caption=vn.caption,
        created_at=vn.created_at.isoformat(),
        deleted_at=None,
    )


@router.get("/feed", response_model=VoiceNoteFeedResponse)
async def get_feed(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Get voice notes feed from users you follow."""
    following_fids = await get_following_fids(redis, current_user)

    items, next_cursor = await voice_note_service.get_feed(
        db=db,
        fid=current_user,
        following_fids=following_fids,
        cursor=cursor,
        limit=limit,
    )

    return VoiceNoteFeedResponse(voice_notes=items, next_cursor=next_cursor)


RECENT_RATE_LIMIT_WINDOW = 60  # 1 minute
RECENT_RATE_LIMIT_MAX = 30  # requests per window per IP


@router.get("/recent", response_model=VoiceNoteFeedResponse)
async def get_recent_voice_notes(
    request: Request,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Get recent voice notes (public, no auth required)."""
    rate_key = f"voice_notes:recent_rate:{client_ip(request)}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, RECENT_RATE_LIMIT_WINDOW)
    count, _ = await pipe.execute()
    if count > RECENT_RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    items, next_cursor = await voice_note_service.get_recent_voice_notes(
        db=db,
        cursor=cursor,
        limit=limit,
    )
    return VoiceNoteFeedResponse(voice_notes=items, next_cursor=next_cursor)


@router.get("/user/{fid}", response_model=VoiceNoteFeedResponse)
async def get_user_voice_notes(
    fid: int = Path(...),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    current_user: int | None = Depends(get_optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get voice notes by a specific user."""
    items, next_cursor = await voice_note_service.get_user_voice_notes(
        db=db,
        fid=fid,
        viewer_fid=current_user,
        cursor=cursor,
        limit=limit,
    )
    return VoiceNoteFeedResponse(voice_notes=items, next_cursor=next_cursor)


@router.get("/{voice_note_id}", response_model=VoiceNoteDetailResponse)
async def get_voice_note(
    voice_note_id: uuid.UUID = Path(...),
    current_user: int | None = Depends(get_optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a single voice note with details."""
    return await voice_note_service.get_voice_note(
        db, voice_note_id, viewer_fid=current_user
    )


@router.post("/{voice_note_id}/plays", status_code=201)
async def record_play(
    body: PlayRequest,
    request: Request,
    voice_note_id: uuid.UUID = Path(...),
    current_user: int | None = Depends(get_optional_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Record a playback event."""
    if current_user:
        identifier = f"fid:{current_user}"
        dedup_seconds = PLAY_DEDUP_SECONDS
    else:
        ip = client_ip(request)
        identifier = f"ip:{ip}"
        dedup_seconds = ANONYMOUS_PLAY_DEDUP_SECONDS
        await enforce_rate_limits(
            redis, [(f"voice_notes:anon_play_rl:{ip}", ANONYMOUS_PLAY_RATE_LIMIT)]
        )
    dedup_key = f"voice_notes:play_rate:{identifier}:{voice_note_id}"
    first_play = await redis.set(dedup_key, "1", ex=dedup_seconds, nx=True)
    if not first_play:
        return {"status": "duplicate"}

    user_agent = request.headers.get("user-agent")
    await voice_note_service.record_play(
        db=db,
        voice_note_id=voice_note_id,
        listener_fid=current_user,
        listened_ms=body.listened_ms,
        completed=body.completed,
        source="app",
        user_agent=user_agent,
    )
    return {"status": "ok"}


async def _mirror_reaction(
    db: AsyncSession,
    voice_note_id: uuid.UUID,
    fid: int,
    *,
    action: str,
    reaction_type: str,
) -> None:
    """Mirror a voice note reaction onto its Farcaster cast, if it has one."""
    from app.models.voice_note import VoiceNote

    result = await db.execute(
        select(VoiceNote.cast_hash, VoiceNote.fid).where(VoiceNote.id == voice_note_id)
    )
    row = result.one_or_none()
    if row is None or not row.cast_hash:
        return
    signer = await farcaster_writes.load_user_signer(db, fid)
    # The voice note author is the cast author, so no lookup is needed.
    await farcaster_writes.publish_reaction(
        signer,
        action=action,
        reaction_type=reaction_type,
        target_hash=row.cast_hash,
        target_fid=row.fid,
    )


@router.post("/{voice_note_id}/reactions", status_code=201)
async def add_reaction(
    body: ReactionRequest,
    voice_note_id: uuid.UUID = Path(...),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Add a reaction to a voice note."""
    await voice_note_service.add_reaction(
        db, voice_note_id, current_user, body.reaction_type
    )

    try:
        await _mirror_reaction(
            db,
            voice_note_id,
            current_user,
            action="add",
            reaction_type=body.reaction_type,
        )
    except Exception as exc:  # noqa: BLE001 - mirror is best-effort
        logger.warning(
            "[voice_notes] Failed to mirror reaction to Farcaster: %s",
            type(exc).__name__,
        )

    await invalidate_viewer_reactions(redis, current_user)

    return {"status": "ok"}


@router.delete("/{voice_note_id}/reactions/{reaction_type}")
async def remove_reaction(
    voice_note_id: uuid.UUID = Path(...),
    reaction_type: str = Path(..., pattern=r"^(like|recast)$"),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Remove a reaction from a voice note."""
    await voice_note_service.remove_reaction(
        db, voice_note_id, current_user, reaction_type
    )

    try:
        await _mirror_reaction(
            db,
            voice_note_id,
            current_user,
            action="remove",
            reaction_type=reaction_type,
        )
    except Exception as exc:  # noqa: BLE001 - mirror is best-effort
        logger.warning(
            "[voice_notes] Failed to mirror reaction to Farcaster: %s",
            type(exc).__name__,
        )

    await invalidate_viewer_reactions(redis, current_user)

    return {"status": "ok"}


@router.delete("/{voice_note_id}")
async def delete_voice_note(
    voice_note_id: uuid.UUID = Path(...),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete a voice note. Author only."""
    vn = await voice_note_service.soft_delete(db, voice_note_id, current_user)

    # Delete cast from Farcaster if it exists
    if vn.cast_hash:
        try:
            signer = await farcaster_writes.load_user_signer(db, current_user)
            await farcaster_writes.publish_cast_removal(signer, vn.cast_hash)
        except Exception as exc:  # noqa: BLE001 - mirror delete is best-effort
            logger.warning(
                "[voice_notes] Failed to delete cast from Farcaster: %s",
                type(exc).__name__,
            )

    return {"status": "deleted"}
