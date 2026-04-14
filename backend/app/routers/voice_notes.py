"""
Voice Notes router — upload, create, feed, playback tracking, reactions.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_current_user, get_db, get_optional_current_user, get_redis
from app.models.user import User
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
from app.services.storage_service import StorageService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/voice-notes", tags=["voice-notes"])

NEYNAR_BASE = "https://api.neynar.com/v2"
UPLOAD_TTL_SECONDS = 3600  # 1 hour
RATE_LIMIT_WINDOW_SECONDS = 3600
RATE_LIMIT_MAX_UPLOADS = 20
FOLLOWING_CACHE_TTL = 300  # 5 minutes
PLAY_DEDUP_SECONDS = 60  # 1 play per user/IP per voice note per 60s
MAX_UPLOAD_SIZE_BYTES = 10_485_760  # 10 MB

_storage: StorageService | None = None


def _get_storage() -> StorageService:
    global _storage
    if _storage is None:
        _storage = StorageService()
    return _storage


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


async def _get_signer_uuid(db: AsyncSession, fid: int) -> str:
    result = await db.execute(select(User.signer_uuid).where(User.fid == fid))
    signer_uuid = result.scalar_one_or_none()
    if not signer_uuid:
        raise HTTPException(status_code=400, detail="No signer found for user")
    return signer_uuid


async def _get_following_fids(redis: aioredis.Redis, fid: int) -> list[int]:
    """Fetch following FIDs from Neynar with Redis caching."""
    cache_key = f"voice_notes:following:{fid}"
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    following_fids: list[int] = []
    cursor: str | None = None

    async with httpx.AsyncClient() as client:
        while True:
            params: dict[str, str | int] = {"fid": fid, "limit": 100}
            if cursor:
                params["cursor"] = cursor
            resp = await client.get(
                f"{NEYNAR_BASE}/farcaster/following",
                params=params,
                headers=_neynar_headers(),
                timeout=15.0,
            )
            if resp.status_code != 200:
                logger.error("[voice_notes] Neynar following fetch failed: %s", resp.text[:500])
                break

            data = resp.json()
            for item in data.get("users", []):
                user = item.get("user", item)
                if "fid" in user:
                    following_fids.append(user["fid"])

            cursor = data.get("next", {}).get("cursor")
            if not cursor:
                break

    await redis.set(cache_key, json.dumps(following_fids), ex=FOLLOWING_CACHE_TTL)
    return following_fids


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/upload-url", response_model=UploadUrlResponse)
async def request_upload_url(
    body: UploadUrlRequest,
    current_user: int = Depends(get_current_user),
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
        raise HTTPException(status_code=429, detail="Upload rate limit exceeded (20/hr)")

    upload_id = str(uuid.uuid4())
    ext_map = {"audio/mp4": "m4a", "audio/aac": "aac", "audio/mp3": "mp3"}
    ext = ext_map.get(body.content_type, "m4a")
    object_key = f"voice-notes/{current_user}/{upload_id}.{ext}"

    storage = _get_storage()
    upload_url = storage.generate_presigned_upload_url(object_key, body.content_type)

    # Store upload metadata in Redis for finalization
    upload_meta = json.dumps({
        "fid": current_user,
        "object_key": object_key,
        "content_type": body.content_type,
        "duration_ms": body.duration_ms,
    })
    await redis.set(f"voice_notes:upload:{upload_id}", upload_meta, ex=UPLOAD_TTL_SECONDS)

    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=UPLOAD_TTL_SECONDS)).isoformat()

    return UploadUrlResponse(
        upload_id=upload_id,
        upload_url=upload_url,
        expires_at=expires_at,
    )


@router.post("/", response_model=VoiceNoteResponse)
async def create_voice_note(
    body: VoiceNoteCreateRequest,
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Finalize a voice note after upload completes."""
    # Verify upload_id
    upload_key = f"voice_notes:upload:{body.upload_id}"
    upload_meta_raw = await redis.get(upload_key)
    if not upload_meta_raw:
        raise HTTPException(status_code=400, detail="Invalid or expired upload_id")

    upload_meta = json.loads(upload_meta_raw)
    if upload_meta["fid"] != current_user:
        raise HTTPException(status_code=403, detail="Upload does not belong to this user")

    object_key = upload_meta["object_key"]

    # Verify uploaded object size does not exceed limit
    try:
        storage = _get_storage()
        object_size = storage.get_object_size(object_key)
        if object_size > MAX_UPLOAD_SIZE_BYTES:
            storage.delete_object(object_key)
            await redis.delete(upload_key)
            raise HTTPException(
                status_code=413,
                detail=f"Uploaded file exceeds maximum size ({MAX_UPLOAD_SIZE_BYTES} bytes)",
            )
    except HTTPException:
        raise
    except Exception:
        logger.warning("[voice_notes] Could not verify object size for %s", object_key, exc_info=True)

    # Create voice note record
    vn = await voice_note_service.create_voice_note(
        db=db,
        fid=current_user,
        upload_id=body.upload_id,
        duration_ms=body.duration_ms,
        audio_size=body.audio_size,
        caption=body.cast_text if body.cast_text else None,
        object_key=object_key,
    )

    # Clean up Redis upload token
    await redis.delete(upload_key)

    # Fire-and-forget background processing (waveform + transcription)
    from app.workers.voice_note_worker import process_voice_note

    asyncio.create_task(process_voice_note(str(vn.id)))

    # Optionally post to Farcaster
    if body.post_to_farcaster:
        try:
            signer_uuid = await _get_signer_uuid(db, current_user)
            storage = _get_storage()
            audio_public_url = storage.generate_presigned_get_url(object_key, expires_in=604800)

            cast_text = body.cast_text or ""
            # Append voice note link as embed
            payload: dict = {
                "signer_uuid": signer_uuid,
                "text": cast_text,
                "embeds": [{"url": audio_public_url}],
            }
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{NEYNAR_BASE}/farcaster/cast",
                    json=payload,
                    headers=_neynar_headers(),
                    timeout=15.0,
                )
            if resp.status_code == 200:
                cast_data = resp.json()
                cast_info = cast_data.get("cast", {})
                vn.cast_hash = cast_info.get("hash")
                vn.cast_url = cast_info.get("url") or cast_info.get("text")
                await db.commit()
                await db.refresh(vn)
            else:
                logger.error("[voice_notes] Neynar cast failed: %s", resp.text[:500])
        except Exception:
            logger.error("[voice_notes] Failed to cast voice note %s", vn.id, exc_info=True)

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
    following_fids = await _get_following_fids(redis, current_user)

    items, next_cursor = await voice_note_service.get_feed(
        db=db,
        fid=current_user,
        following_fids=following_fids,
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
    return await voice_note_service.get_voice_note(db, voice_note_id, viewer_fid=current_user)


@router.post("/{voice_note_id}/plays", status_code=201)
async def record_play(
    body: PlayRequest,
    voice_note_id: uuid.UUID = Path(...),
    request: Request = None,
    current_user: int | None = Depends(get_optional_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Record a playback event."""
    # Deduplicate: 1 play per user (or IP) per voice note per 60s
    identifier = str(current_user) if current_user else (
        request.client.host if request and request.client else "unknown"
    )
    dedup_key = f"voice_notes:play_rate:{identifier}:{voice_note_id}"
    already_tracked = await redis.set(dedup_key, "1", ex=PLAY_DEDUP_SECONDS, nx=True)
    if not already_tracked:
        return {"status": "duplicate"}

    user_agent = request.headers.get("user-agent") if request else None
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


@router.post("/{voice_note_id}/reactions", status_code=201)
async def add_reaction(
    body: ReactionRequest,
    voice_note_id: uuid.UUID = Path(...),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a reaction to a voice note."""
    await voice_note_service.add_reaction(db, voice_note_id, current_user, body.reaction_type)

    # Mirror to Farcaster if the voice note has a cast_hash
    try:
        from app.models.voice_note import VoiceNote

        result = await db.execute(
            select(VoiceNote.cast_hash).where(VoiceNote.id == voice_note_id)
        )
        cast_hash = result.scalar_one_or_none()
        if cast_hash:
            signer_uuid = await _get_signer_uuid(db, current_user)
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{NEYNAR_BASE}/farcaster/reaction",
                    json={
                        "signer_uuid": signer_uuid,
                        "reaction_type": body.reaction_type,
                        "target": cast_hash,
                    },
                    headers=_neynar_headers(),
                    timeout=15.0,
                )
    except Exception:
        logger.warning("[voice_notes] Failed to mirror reaction to Farcaster", exc_info=True)

    return {"status": "ok"}


@router.delete("/{voice_note_id}/reactions/{reaction_type}")
async def remove_reaction(
    voice_note_id: uuid.UUID = Path(...),
    reaction_type: str = Path(..., pattern=r"^(like|recast)$"),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a reaction from a voice note."""
    await voice_note_service.remove_reaction(db, voice_note_id, current_user, reaction_type)

    # Mirror to Farcaster if the voice note has a cast_hash
    try:
        from app.models.voice_note import VoiceNote

        result = await db.execute(
            select(VoiceNote.cast_hash).where(VoiceNote.id == voice_note_id)
        )
        cast_hash = result.scalar_one_or_none()
        if cast_hash:
            signer_uuid = await _get_signer_uuid(db, current_user)
            async with httpx.AsyncClient() as client:
                await client.request(
                    "DELETE",
                    f"{NEYNAR_BASE}/farcaster/reaction",
                    json={
                        "signer_uuid": signer_uuid,
                        "reaction_type": reaction_type,
                        "target": cast_hash,
                    },
                    headers=_neynar_headers(),
                    timeout=15.0,
                )
    except Exception:
        logger.warning("[voice_notes] Failed to mirror reaction removal to Farcaster", exc_info=True)

    return {"status": "ok"}


@router.delete("/{voice_note_id}")
async def delete_voice_note(
    voice_note_id: uuid.UUID = Path(...),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete a voice note. Author only."""
    vn = await voice_note_service.soft_delete(db, voice_note_id, current_user)

    # Delete cast from Farcaster if it exists
    if vn.cast_hash:
        try:
            signer_uuid = await _get_signer_uuid(db, current_user)
            async with httpx.AsyncClient() as client:
                await client.request(
                    "DELETE",
                    f"{NEYNAR_BASE}/farcaster/cast",
                    json={
                        "signer_uuid": signer_uuid,
                        "target_hash": vn.cast_hash,
                    },
                    headers=_neynar_headers(),
                    timeout=15.0,
                )
        except Exception:
            logger.warning("[voice_notes] Failed to delete cast from Farcaster", exc_info=True)

    return {"status": "deleted"}
