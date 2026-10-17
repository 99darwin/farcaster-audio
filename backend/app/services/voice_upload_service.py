"""
Finalization of client-uploaded voice audio (voice notes and voice drafts).

Clients upload through a presigned PUT to a *staging* key. That URL keeps
working until it expires, so the staging object is never trusted directly.
Finalizing:

1. HEADs the staging object (fail closed) and rejects oversized uploads
   before doing any work;
2. server-side copies it to a fresh, random ``voice-notes/`` key that no
   presigned URL was ever issued for — the published audio is immutable from
   the client's point of view, so it can't be swapped after review;
3. re-checks the size of that immutable copy, downloads it and validates it
   with the allowlisted ffprobe/ffmpeg pipeline in ``audio_probe``;
4. returns server-derived size, duration and waveform peaks — client-supplied
   values are never stored.

Any failure deletes the immutable copy. The staging object is removed on
definitive rejections, and by the caller once the voice note is persisted; a
bucket lifecycle rule on the staging prefixes is the backstop for uploads that
are never finalized.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid
from dataclasses import dataclass

from botocore.exceptions import ClientError

from app.services.audio_probe import (
    CONTENT_TYPE_EXTENSIONS,
    MAX_VOICE_NOTE_DURATION_MS,
    AnalyzedAudio,
    AudioToolError,
    AudioValidationError,
    analyze_audio,
    compute_waveform_peaks,
)
from app.services.storage_service import StorageService

logger = logging.getLogger(__name__)

MAX_VOICE_UPLOAD_SIZE_BYTES = 10_485_760  # 10 MB
VOICE_NOTE_UPLOAD_PREFIX = "voice-note-uploads"
VOICE_NOTE_FINAL_PREFIX = "voice-notes"
HTTP_SERVICE_UNAVAILABLE = 503
_MISSING_OBJECT_CODES = frozenset({"404", "NoSuchKey", "NotFound"})


class VoiceUploadError(Exception):
    """Finalization failed; carries the HTTP status the router should return."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail

    @property
    def is_transient(self) -> bool:
        """Storage/tooling hiccup: the staged upload is kept and retryable."""
        return self.status_code == HTTP_SERVICE_UNAVAILABLE


@dataclass(frozen=True)
class FinalizedVoiceAudio:
    object_key: str
    audio_size: int
    duration_ms: int
    waveform_peaks: list[float]


def extension_for(content_type: str) -> str:
    return CONTENT_TYPE_EXTENSIONS.get(content_type, "m4a")


def build_voice_note_staging_key(fid: int, upload_id: str, content_type: str) -> str:
    return f"{VOICE_NOTE_UPLOAD_PREFIX}/{fid}/{upload_id}.{extension_for(content_type)}"


def _build_final_key(fid: int, content_type: str) -> str:
    return (
        f"{VOICE_NOTE_FINAL_PREFIX}/{fid}/{uuid.uuid4()}.{extension_for(content_type)}"
    )


def _is_missing_object(exc: ClientError) -> bool:
    return str(exc.response.get("Error", {}).get("Code")) in _MISSING_OBJECT_CODES


async def _delete_quietly(storage: StorageService, key: str) -> None:
    try:
        await asyncio.to_thread(storage.delete_object, key)
    except Exception:
        logger.warning("[voice_upload] Failed to delete %s", key, exc_info=True)


async def discard_staging_upload(storage: StorageService, staging_key: str) -> None:
    """Best-effort removal of a staging object after its voice note is saved."""
    await _delete_quietly(storage, staging_key)


async def _checked_size(storage: StorageService, key: str) -> int:
    """HEAD ``key`` and enforce the size cap. Fails closed on any error."""
    try:
        size = await asyncio.to_thread(storage.get_object_size, key)
    except ClientError as exc:
        if _is_missing_object(exc):
            raise VoiceUploadError(400, "Uploaded audio not found") from exc
        logger.warning("[voice_upload] HEAD failed for %s", key, exc_info=True)
        raise VoiceUploadError(
            HTTP_SERVICE_UNAVAILABLE, "Could not verify uploaded audio"
        ) from exc
    except Exception as exc:
        logger.warning("[voice_upload] HEAD failed for %s", key, exc_info=True)
        raise VoiceUploadError(
            HTTP_SERVICE_UNAVAILABLE, "Could not verify uploaded audio"
        ) from exc
    if size <= 0:
        raise VoiceUploadError(400, "Uploaded audio is empty")
    if size > MAX_VOICE_UPLOAD_SIZE_BYTES:
        raise VoiceUploadError(
            413,
            f"Uploaded file exceeds maximum size ({MAX_VOICE_UPLOAD_SIZE_BYTES} bytes)",
        )
    return size


async def _copy(storage: StorageService, source_key: str, dest_key: str) -> None:
    try:
        await asyncio.to_thread(storage.copy_object, source_key, dest_key)
    except ClientError as exc:
        if _is_missing_object(exc):
            raise VoiceUploadError(400, "Uploaded audio not found") from exc
        logger.warning("[voice_upload] copy failed for %s", source_key, exc_info=True)
        raise VoiceUploadError(
            HTTP_SERVICE_UNAVAILABLE, "Could not store uploaded audio"
        ) from exc
    except Exception as exc:
        logger.warning("[voice_upload] copy failed for %s", source_key, exc_info=True)
        raise VoiceUploadError(
            HTTP_SERVICE_UNAVAILABLE, "Could not store uploaded audio"
        ) from exc


async def _analyze_object(
    storage: StorageService, key: str, content_type: str
) -> AnalyzedAudio:
    # A private directory per upload: the mp4 demuxer can follow relative
    # data references, so the file must have no readable siblings.
    with tempfile.TemporaryDirectory(prefix="voice-upload-") as work_dir:
        local_path = os.path.join(work_dir, "audio")
        await asyncio.to_thread(storage.download_file, key, local_path)
        return await analyze_audio(local_path, content_type)


async def finalize_voice_upload(
    storage: StorageService,
    *,
    staging_key: str,
    fid: int,
    content_type: str,
) -> FinalizedVoiceAudio:
    """Validate a staged upload and promote it to an immutable key.

    The staging object is deleted on definitive rejections (too large, empty,
    invalid audio) and kept on transient 503s so the upload can be retried. On
    success it is also kept: callers call :func:`discard_staging_upload` once
    the voice note is persisted, so a failure in between stays retryable.
    """
    final_key = _build_final_key(fid, content_type)
    try:
        await _checked_size(storage, staging_key)
        await _copy(storage, staging_key, final_key)
    except VoiceUploadError as exc:
        if not exc.is_transient:
            await _delete_quietly(storage, staging_key)
        raise

    try:
        # Re-check the copy: the staging object could have been rewritten
        # between the first HEAD and the copy.
        audio_size = await _checked_size(storage, final_key)
        analyzed = await _analyze_object(storage, final_key, content_type)
    except VoiceUploadError as exc:
        await _delete_quietly(storage, final_key)
        if not exc.is_transient:
            await _delete_quietly(storage, staging_key)
        raise
    except AudioValidationError as exc:
        await _delete_quietly(storage, final_key)
        await _delete_quietly(storage, staging_key)
        logger.info("[voice_upload] Rejected upload from fid=%s: %s", fid, exc.reason)
        raise VoiceUploadError(422, "Unsupported or invalid audio") from exc
    except AudioToolError as exc:
        await _delete_quietly(storage, final_key)
        logger.error("[voice_upload] Audio tooling unavailable: %s", exc)
        raise VoiceUploadError(
            HTTP_SERVICE_UNAVAILABLE, "Audio processing unavailable"
        ) from exc
    except Exception as exc:
        await _delete_quietly(storage, final_key)
        logger.warning("[voice_upload] Failed to process %s", final_key, exc_info=True)
        raise VoiceUploadError(
            HTTP_SERVICE_UNAVAILABLE, "Could not verify uploaded audio"
        ) from exc

    return FinalizedVoiceAudio(
        object_key=final_key,
        audio_size=audio_size,
        duration_ms=max(1, min(analyzed.duration_ms, MAX_VOICE_NOTE_DURATION_MS)),
        waveform_peaks=compute_waveform_peaks(analyzed.pcm),
    )
