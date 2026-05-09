import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import (
    _is_valid_neynar_signer,
    get_current_user,
    get_db,
    get_redis,
    require_non_demo_user,
)
from app.models.compose_draft import ComposeDraft
from app.models.user import User
from app.schemas.compose_draft import (
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
from app.services.media_embed import normalize_media_embed_url
from app.services.storage_service import StorageService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/drafts", tags=["drafts"])

NEYNAR_BASE = "https://api.neynar.com/v2"
DRAFT_UPLOAD_TTL_SECONDS = 3600
DRAFT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS = 3600
DRAFT_UPLOAD_RATE_LIMIT_MAX = 20
MAX_UPLOAD_SIZE_BYTES = 10_485_760
URL_PATTERN = re.compile(r"https?://[^\s]+")

_storage: StorageService | None = None


def _get_storage() -> StorageService:
    global _storage
    if _storage is None:
        _storage = StorageService()
    return _storage


def _neynar_headers() -> dict[str, str]:
    return {"accept": "application/json", "x-api-key": settings.NEYNAR_API_KEY}


async def _get_signer_uuid(db: AsyncSession, fid: int) -> str:
    result = await db.execute(select(User.signer_uuid).where(User.fid == fid))
    signer_uuid = result.scalar_one_or_none()
    if not signer_uuid:
        raise HTTPException(status_code=400, detail="No signer found for user")
    if not _is_valid_neynar_signer(signer_uuid):
        raise HTTPException(status_code=403, detail="Sign in with Farcaster to post.")
    return signer_uuid


def _draft_to_response(draft: ComposeDraft) -> ComposeDraftResponse:
    voice_metadata = dict(draft.voice_metadata or {}) or None
    if voice_metadata:
        voice_metadata.pop("object_key", None)
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


def _build_cast_payload(draft: ComposeDraft, signer_uuid: str) -> dict:
    url_embeds = [
        {"url": normalize_media_embed_url(item["url"])}
        for item in (draft.media_embeds or [])
        if item.get("url")
    ]
    url_embeds.extend(
        {"url": normalize_media_embed_url(url.rstrip(".,!?"))}
        for url in URL_PATTERN.findall(draft.text or "")
    )
    embeds = url_embeds[:3] if draft.quote_cast else url_embeds[:4]
    if draft.quote_cast:
        embeds.append(
            {
                "cast_id": {
                    "fid": draft.quote_cast["fid"],
                    "hash": draft.quote_cast["hash"],
                }
            }
        )
    payload: dict = {"signer_uuid": signer_uuid, "text": draft.text.strip()}
    if embeds:
        payload["embeds"] = embeds[:4]
    if draft.parent_cast_hash:
        payload["parent"] = draft.parent_cast_hash
    elif draft.channel_id:
        payload["channel_id"] = draft.channel_id
    return payload


def _build_voice_cast_payload(
    draft: ComposeDraft,
    signer_uuid: str,
    voice_note_id: uuid.UUID,
) -> dict:
    payload: dict = {
        "signer_uuid": signer_uuid,
        "text": draft.text.strip(),
        "embeds": [{"url": f"https://juke.audio/v/{voice_note_id}"}],
    }
    if draft.parent_cast_hash:
        payload["parent"] = draft.parent_cast_hash
    elif draft.channel_id:
        payload["channel_id"] = draft.channel_id
    return payload


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
        "voice_metadata": draft.voice_metadata,
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
            body.voice_metadata.model_dump(mode="json")
            if body.voice_metadata
            else None
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
        validated.parent_cast.model_dump(mode="json")
        if validated.parent_cast
        else None
    )
    draft.quote_cast = (
        validated.quote_cast.model_dump(mode="json") if validated.quote_cast else None
    )
    draft.media_embeds = _dump_media(validated.media_embeds)
    if "voice_metadata" in fields_set:
        draft.voice_metadata = (
            validated.voice_metadata.model_dump(mode="json")
            if validated.voice_metadata
            else None
        )
    draft.post_to_farcaster = validated.post_to_farcaster
    await db.commit()
    await db.refresh(draft)
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
    if object_key and _owned_draft_voice_key(current_user, draft.id, object_key):
        try:
            _get_storage().delete_object(object_key)
        except Exception:
            logger.warning(
                "[drafts] Failed to delete draft voice object %s",
                object_key,
                exc_info=True,
            )
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
    ext_map = {"audio/mp4": "m4a", "audio/aac": "aac", "audio/mp3": "mp3"}
    ext = ext_map.get(body.content_type, "m4a")
    object_key = f"voice-note-drafts/{current_user}/{draft_id}/{upload_id}.{ext}"
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
    expires_at = (
        datetime.now(timezone.utc) + timedelta(seconds=DRAFT_UPLOAD_TTL_SECONDS)
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
):
    draft = await _get_owned_draft(db, draft_id, current_user)
    if draft.parent_cast_hash and draft.channel_id:
        raise HTTPException(status_code=400, detail="Replies cannot target a channel")

    voice = draft.voice_metadata or None
    result_payload: dict
    if voice:
        object_key = voice.get("object_key")
        if not object_key:
            raise HTTPException(status_code=400, detail="Voice draft is missing audio")
        if not _owned_draft_voice_key(current_user, draft.id, object_key):
            raise HTTPException(status_code=400, detail="Invalid voice draft audio")
        storage = _get_storage()
        object_size = voice.get("audio_size") or 0
        try:
            object_size = storage.get_object_size(object_key)
            if object_size > MAX_UPLOAD_SIZE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="Uploaded file exceeds maximum size",
                )
        except HTTPException:
            raise
        except Exception:
            logger.warning(
                "[drafts] Could not verify object size for %s",
                object_key,
                exc_info=True,
            )

        vn = await voice_note_service.create_voice_note(
            db=db,
            fid=current_user,
            upload_id=str(draft.id),
            duration_ms=voice["duration_ms"],
            audio_size=object_size,
            caption=draft.text.strip() or None,
            object_key=object_key,
            parent_cast_hash=draft.parent_cast_hash,
        )
        if voice.get("waveform_peaks"):
            vn.waveform_peaks = voice["waveform_peaks"]
            await db.commit()
            await db.refresh(vn)

        from app.workers.voice_note_worker import process_voice_note

        asyncio.create_task(process_voice_note(str(vn.id)))

        if draft.post_to_farcaster:
            signer_uuid = await _get_signer_uuid(db, current_user)
            payload = _build_voice_cast_payload(draft, signer_uuid, vn.id)
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{NEYNAR_BASE}/farcaster/cast",
                    json=payload,
                    headers=_neynar_headers(),
                    timeout=15.0,
                )
            if resp.status_code == 200:
                cast_info = resp.json().get("cast", {})
                vn.cast_hash = cast_info.get("hash")
                vn.cast_url = cast_info.get("url") or cast_info.get("text")
                await db.commit()
                await db.refresh(vn)
            else:
                logger.error(
                    "[drafts] Neynar voice draft cast failed: %s",
                    resp.text[:500],
                )
        result_payload = {
            "voice_note": voice_note_service._voice_note_to_response(vn).model_dump(
                mode="json"
            )
        }
    else:
        signer_uuid = await _get_signer_uuid(db, current_user)
        payload = _build_cast_payload(draft, signer_uuid)
        if not payload["text"] and not payload.get("embeds"):
            raise HTTPException(
                status_code=400,
                detail="Draft has no publishable content",
            )

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{NEYNAR_BASE}/farcaster/cast",
                json=payload,
                headers=_neynar_headers(),
                timeout=15.0,
            )
        if resp.status_code != 200:
            logger.error("[drafts] Neynar draft cast failed: %s", resp.text[:500])
            status = 502 if resp.status_code >= 500 else resp.status_code
            raise HTTPException(status_code=status, detail="Upstream service error")
        result_payload = resp.json()

    await db.delete(draft)
    await db.commit()
    return result_payload
