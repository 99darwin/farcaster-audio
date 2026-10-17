import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import (
    get_current_user,
    get_db,
    get_redis,
    require_non_demo_user,
)
from app.models.compose_draft import ComposeDraft
from app.schemas.compose_draft import (
    MAX_WAVEFORM_PEAKS,
    ComposeDraftBase,
    ComposeDraftCreate,
    ComposeDraftListResponse,
    ComposeDraftResponse,
    ComposeDraftUpdate,
    DraftMediaEmbed,
    DraftVoiceMetadata,
    DraftVoiceUploadUrlRequest,
    DraftVoiceUploadUrlResponse,
)
from app.services import voice_note_service
from app.services.cast_ledger import record_cast
from app.services.farcaster_writes import (
    MAX_CAST_EMBEDS,
    Signer,
    cast_ref,
    cast_response,
    is_valid_embed_url,
    load_user_signer,
    publish_cast,
    write_errors_as_http,
)
from app.services.media_embed import normalize_media_embed_url
from app.services.storage_service import PRESIGNED_UPLOAD_TTL_SECONDS, StorageService
from app.services.voice_upload_service import (
    VoiceUploadError,
    discard_staging_upload,
    extension_for,
    finalize_voice_upload,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/drafts", tags=["drafts"])

VOICE_NOTE_URL_TEMPLATE = "https://juke.audio/v/{voice_note_id}"
DRAFT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS = 3600
DRAFT_UPLOAD_RATE_LIMIT_MAX = 20
MAX_DRAFTS_PER_FID = 50
DRAFT_PUBLISH_LOCK_SECONDS = 120
URL_PATTERN = re.compile(r"https?://[^\s]+")

_storage: StorageService | None = None


def _get_storage() -> StorageService:
    global _storage
    if _storage is None:
        _storage = StorageService()
    return _storage


def _valid_waveform_peaks(peaks: object) -> bool:
    if peaks is None:
        return True
    if not isinstance(peaks, list) or len(peaks) > MAX_WAVEFORM_PEAKS:
        return False
    return all(
        isinstance(p, (int, float)) and not isinstance(p, bool) and 0 <= p <= 1
        for p in peaks
    )


def _client_voice_metadata(stored: dict | None) -> dict | None:
    """Stored voice metadata as the client may see/resubmit it.

    Drops the server-only ``object_key`` and, for drafts saved before peaks
    were bounded, peaks the schemas now reject (rather than 500).
    """
    voice_metadata = dict(stored or {}) or None
    if voice_metadata:
        voice_metadata.pop("object_key", None)
        if not _valid_waveform_peaks(voice_metadata.get("waveform_peaks")):
            voice_metadata["waveform_peaks"] = None
    return voice_metadata


def _draft_to_response(draft: ComposeDraft) -> ComposeDraftResponse:
    voice_metadata = _client_voice_metadata(draft.voice_metadata)
    return ComposeDraftResponse(
        id=str(draft.id),
        fid=draft.fid,
        text=draft.text,
        channel_id=draft.channel_id,
        parent_cast_hash=draft.parent_cast_hash,
        parent_cast=draft.parent_cast,
        quote_cast=draft.quote_cast,
        media_embeds=draft.media_embeds or [],
        voice_metadata=voice_metadata,
        post_to_farcaster=draft.post_to_farcaster,
        created_at=draft.created_at.isoformat(),
        updated_at=draft.updated_at.isoformat(),
    )


def _dump_media(items: list[DraftMediaEmbed]) -> list[dict]:
    return [item.model_dump(mode="json") for item in items]


def _owned_draft_voice_prefix(fid: int, draft_id: uuid.UUID) -> str:
    return f"voice-note-drafts/{fid}/{draft_id}/"


def _owned_draft_voice_key(fid: int, draft_id: uuid.UUID, object_key: str) -> bool:
    return object_key.startswith(_owned_draft_voice_prefix(fid, draft_id))


async def _delete_owned_draft_voice(
    fid: int, draft_id: uuid.UUID, object_key: str | None
) -> None:
    """Best-effort delete of a draft's staged voice object (owned keys only)."""
    if not object_key or not _owned_draft_voice_key(fid, draft_id, object_key):
        return
    try:
        await asyncio.to_thread(_get_storage().delete_object, object_key)
    except Exception:
        logger.warning(
            "[drafts] Failed to delete draft voice object %s",
            object_key,
            exc_info=True,
        )


def _draft_embed_urls(draft: ComposeDraft) -> list[str]:
    """Attached media first (validated strictly at publish), then URLs found
    in the text, which only fill the remaining protocol embed slots and are
    skipped when invalid (they still appear in the cast text)."""
    media_urls = [
        normalize_media_embed_url(item["url"])
        for item in (draft.media_embeds or [])
        if item.get("url")
    ]
    slots = MAX_CAST_EMBEDS - int(bool(draft.quote_cast)) - len(media_urls)
    text_urls: list[str] = []
    for raw_url in URL_PATTERN.findall(draft.text or ""):
        if len(text_urls) >= slots:
            break
        url = normalize_media_embed_url(raw_url.rstrip(".,!?"))
        if is_valid_embed_url(url) and url not in media_urls + text_urls:
            text_urls.append(url)
    return media_urls + text_urls


async def _publish_draft_cast(
    signer: Signer, draft: ComposeDraft, *, embed_urls: list[str]
) -> str:
    quote = None
    if draft.quote_cast:
        quote = cast_ref(draft.quote_cast["fid"], draft.quote_cast["hash"])
    return await publish_cast(
        signer,
        text=draft.text.strip(),
        embed_urls=embed_urls,
        quote=quote if quote is not None and not draft.voice_metadata else None,
        parent_hash=draft.parent_cast_hash,
        channel_id=None if draft.parent_cast_hash else draft.channel_id,
    )


async def _get_owned_draft(
    db: AsyncSession,
    draft_id: uuid.UUID,
    fid: int,
) -> ComposeDraft:
    result = await db.execute(
        select(ComposeDraft).where(ComposeDraft.id == draft_id, ComposeDraft.fid == fid)
    )
    draft = result.scalar_one_or_none()
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")
    return draft


def _validate_update_candidate(
    draft: ComposeDraft,
    body: ComposeDraftUpdate,
) -> ComposeDraftBase:
    updates = body.model_dump(exclude_unset=True)
    candidate = {
        "text": draft.text,
        "channel_id": draft.channel_id,
        "parent_cast_hash": draft.parent_cast_hash,
        "parent_cast": draft.parent_cast,
        "quote_cast": draft.quote_cast,
        "media_embeds": draft.media_embeds or [],
        "voice_metadata": _client_voice_metadata(draft.voice_metadata),
        "post_to_farcaster": draft.post_to_farcaster,
    }
    candidate.update(updates)
    return ComposeDraftBase(**candidate)


@router.get("", response_model=ComposeDraftListResponse)
async def list_drafts(
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ComposeDraft)
        .where(ComposeDraft.fid == current_user)
        .order_by(ComposeDraft.updated_at.desc())
        .limit(50)
    )
    return ComposeDraftListResponse(
        drafts=[_draft_to_response(draft) for draft in result.scalars().all()]
    )


@router.post("", response_model=ComposeDraftResponse, status_code=201)
async def create_draft(
    body: ComposeDraftCreate,
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    draft_count = await db.scalar(
        select(func.count())
        .select_from(ComposeDraft)
        .where(ComposeDraft.fid == current_user)
    )
    if (draft_count or 0) >= MAX_DRAFTS_PER_FID:
        raise HTTPException(
            status_code=409,
            detail=f"Draft limit reached ({MAX_DRAFTS_PER_FID}); delete a draft first",
        )
    draft = ComposeDraft(
        id=uuid.uuid4(),
        fid=current_user,
        text=body.text,
        channel_id=body.channel_id,
        parent_cast_hash=body.parent_cast_hash,
        parent_cast=(
            body.parent_cast.model_dump(mode="json") if body.parent_cast else None
        ),
        quote_cast=body.quote_cast.model_dump(mode="json") if body.quote_cast else None,
        media_embeds=_dump_media(body.media_embeds),
        voice_metadata=(
            body.voice_metadata.model_dump(mode="json") if body.voice_metadata else None
        ),
        post_to_farcaster=body.post_to_farcaster,
    )
    db.add(draft)
    await db.commit()
    await db.refresh(draft)
    return _draft_to_response(draft)


@router.patch("/{draft_id}", response_model=ComposeDraftResponse)
async def update_draft(
    body: ComposeDraftUpdate,
    draft_id: uuid.UUID = Path(...),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    draft = await _get_owned_draft(db, draft_id, current_user)
    validated = _validate_update_candidate(draft, body)
    fields_set = body.model_fields_set
    draft.text = validated.text
    draft.channel_id = validated.channel_id
    draft.parent_cast_hash = validated.parent_cast_hash
    draft.parent_cast = (
        validated.parent_cast.model_dump(mode="json") if validated.parent_cast else None
    )
    draft.quote_cast = (
        validated.quote_cast.model_dump(mode="json") if validated.quote_cast else None
    )
    draft.media_embeds = _dump_media(validated.media_embeds)
    removed_voice_key: str | None = None
    if "voice_metadata" in fields_set:
        stored_key = (draft.voice_metadata or {}).get("object_key")
        if validated.voice_metadata:
            # object_key is server-owned (set by voice-upload-url); keep it so
            # a metadata PATCH can't detach the staged audio from the draft.
            new_metadata = validated.voice_metadata.model_dump(mode="json")
            if stored_key:
                new_metadata["object_key"] = stored_key
            draft.voice_metadata = new_metadata
        else:
            draft.voice_metadata = None
            removed_voice_key = stored_key
    draft.post_to_farcaster = validated.post_to_farcaster
    await db.commit()
    await db.refresh(draft)
    await _delete_owned_draft_voice(current_user, draft.id, removed_voice_key)
    return _draft_to_response(draft)


@router.delete("/{draft_id}")
async def delete_draft(
    draft_id: uuid.UUID = Path(...),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    draft = await _get_owned_draft(db, draft_id, current_user)
    object_key = (draft.voice_metadata or {}).get("object_key")
    await db.delete(draft)
    await db.commit()
    await _delete_owned_draft_voice(current_user, draft_id, object_key)
    return {"status": "ok"}


@router.post("/{draft_id}/voice-upload-url", response_model=DraftVoiceUploadUrlResponse)
async def create_voice_upload_url(
    body: DraftVoiceUploadUrlRequest,
    draft_id: uuid.UUID = Path(...),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    draft = await _get_owned_draft(db, draft_id, current_user)
    rate_key = f"drafts:voice_upload_rate:{current_user}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, DRAFT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if count > DRAFT_UPLOAD_RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Upload rate limit exceeded")

    upload_id = str(uuid.uuid4())
    ext = extension_for(body.content_type)
    object_key = f"{_owned_draft_voice_prefix(current_user, draft_id)}{upload_id}.{ext}"
    previous_key = (draft.voice_metadata or {}).get("object_key")
    upload_url = _get_storage().generate_presigned_upload_url(
        object_key,
        body.content_type,
    )
    metadata = DraftVoiceMetadata(
        duration_ms=body.duration_ms,
        content_type=body.content_type,
        waveform_peaks=body.waveform_peaks,
    )
    draft.voice_metadata = {
        **metadata.model_dump(mode="json"),
        "object_key": object_key,
    }
    await db.commit()
    if previous_key != object_key:
        await _delete_owned_draft_voice(current_user, draft_id, previous_key)
    expires_at = (
        datetime.now(timezone.utc) + timedelta(seconds=PRESIGNED_UPLOAD_TTL_SECONDS)
    ).isoformat()
    return DraftVoiceUploadUrlResponse(
        upload_url=upload_url,
        expires_at=expires_at,
        voice_metadata=metadata,
    )


@router.post("/{draft_id}/publish")
async def publish_draft(
    draft_id: uuid.UUID = Path(...),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    draft = await _get_owned_draft(db, draft_id, current_user)
    if draft.parent_cast_hash and draft.channel_id:
        raise HTTPException(status_code=400, detail="Replies cannot target a channel")

    # Claim the draft so overlapping publish requests can't each create a
    # voice note / cast from the same draft.
    lock_key = f"drafts:publish_lock:{draft_id}"
    if not await redis.set(lock_key, "1", nx=True, ex=DRAFT_PUBLISH_LOCK_SECONDS):
        raise HTTPException(status_code=409, detail="Draft is already being published")
    try:
        return await _publish_claimed_draft(db, draft, current_user)
    finally:
        await redis.delete(lock_key)


async def _publish_claimed_draft(
    db: AsyncSession, draft: ComposeDraft, current_user: int
) -> dict:

    voice = draft.voice_metadata or None
    # Fail fast (403 signer_not_linked) before any voice note is created.
    signer: Signer | None = None
    if not voice or draft.post_to_farcaster:
        with write_errors_as_http("drafts"):
            signer = await load_user_signer(db, current_user)
    result_payload: dict
    if voice:
        object_key = voice.get("object_key")
        if not object_key:
            raise HTTPException(status_code=400, detail="Voice draft is missing audio")
        if not _owned_draft_voice_key(current_user, draft.id, object_key):
            raise HTTPException(status_code=400, detail="Invalid voice draft audio")
        try:
            audio = await finalize_voice_upload(
                _get_storage(),
                staging_key=object_key,
                fid=current_user,
                content_type=voice.get("content_type", "audio/mp4"),
            )
        except VoiceUploadError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

        # Size, duration and waveform come from the server-side probe, never
        # from the client-supplied draft metadata.
        vn = await voice_note_service.create_voice_note(
            db=db,
            fid=current_user,
            upload_id=str(draft.id),
            duration_ms=audio.duration_ms,
            audio_size=audio.audio_size,
            caption=draft.text.strip() or None,
            object_key=audio.object_key,
            parent_cast_hash=draft.parent_cast_hash,
            waveform_peaks=audio.waveform_peaks or None,
        )
        await discard_staging_upload(_get_storage(), object_key)

        from app.workers.voice_note_worker import process_voice_note

        asyncio.create_task(process_voice_note(str(vn.id)))

        if signer is not None:
            embed_url = VOICE_NOTE_URL_TEMPLATE.format(voice_note_id=vn.id)
            try:
                with write_errors_as_http("drafts"):
                    vn.cast_hash = await _publish_draft_cast(
                        signer, draft, embed_urls=[embed_url]
                    )
            except HTTPException as exc:
                # The voice note itself is saved; only the mirror cast failed.
                logger.error(
                    "[drafts] voice draft cast failed: HTTP %s", exc.status_code
                )
            else:
                vn.cast_url = None
                await db.commit()
                await db.refresh(vn)
                await record_cast(
                    db, fid=current_user, cast_hash=vn.cast_hash, source="draft"
                )
        result_payload = {
            "voice_note": voice_note_service._voice_note_to_response(vn).model_dump(
                mode="json"
            )
        }
    else:
        embed_urls = _draft_embed_urls(draft)
        if not draft.text.strip() and not embed_urls and not draft.quote_cast:
            raise HTTPException(
                status_code=400,
                detail="Draft has no publishable content",
            )
        with write_errors_as_http("drafts"):
            cast_hash = await _publish_draft_cast(signer, draft, embed_urls=embed_urls)
        await record_cast(db, fid=current_user, cast_hash=cast_hash, source="draft")
        result_payload = cast_response(
            cast_hash, fid=current_user, text=draft.text.strip()
        )

    await db.delete(draft)
    await db.commit()
    return result_payload
