"""
Background processing for voice notes: waveform backfill and transcription.

Called via asyncio.create_task() from the API router — no separate worker
process needed, so nothing here may block the event loop: S3 I/O runs in a
thread and decoding runs in a bounded ffmpeg subprocess (see
``app.services.audio_probe``).
"""

import asyncio
import logging
import os
import tempfile
import uuid

import httpx
from sqlalchemy import select, update

from app.config import settings
from app.services.audio_probe import (
    AnalyzedAudio,
    analyze_audio,
    compute_waveform_peaks,
    content_type_for_key,
    pcm_to_wav,
)
from app.services.voice_upload_service import MAX_VOICE_UPLOAD_SIZE_BYTES

logger = logging.getLogger(__name__)

DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen"
DEEPGRAM_TIMEOUT_SECONDS = 60.0


async def _load_voice_note(voice_note_id: str):
    from app.database import async_session
    from app.models.voice_note import VoiceNote

    async with async_session() as db:
        result = await db.execute(
            select(VoiceNote).where(VoiceNote.id == uuid.UUID(voice_note_id))
        )
        return result.scalar_one_or_none()


async def _update_voice_note(voice_note_id: str, **values) -> None:
    from app.database import async_session
    from app.models.voice_note import VoiceNote

    async with async_session() as db:
        await db.execute(
            update(VoiceNote)
            .where(VoiceNote.id == uuid.UUID(voice_note_id))
            .values(**values)
        )
        await db.commit()


async def _download_and_analyze(object_key: str) -> AnalyzedAudio | None:
    """Fetch ``object_key`` and decode it through the allowlisted pipeline."""
    from app.services.storage_service import StorageService

    content_type = content_type_for_key(object_key)
    if content_type is None:
        logger.error("[worker] Unrecognized voice object key %s", object_key)
        return None

    storage = StorageService()
    try:
        file_size = await asyncio.to_thread(storage.get_object_size, object_key)
    except Exception:
        logger.error("[worker] Failed to HEAD %s from S3", object_key, exc_info=True)
        return None
    if file_size > MAX_VOICE_UPLOAD_SIZE_BYTES:
        logger.error(
            "[worker] File %s too large (%d bytes), skipping", object_key, file_size
        )
        return None

    try:
        # Private directory per file: no readable siblings for mp4 data refs.
        with tempfile.TemporaryDirectory(prefix="voice-note-") as work_dir:
            local_path = os.path.join(work_dir, "audio")
            await asyncio.to_thread(storage.download_file, object_key, local_path)
            return await analyze_audio(local_path, content_type)
    except Exception as exc:
        logger.error(
            "[worker] Failed to process %s: %s", object_key, type(exc).__name__
        )
        return None


async def _transcribe(voice_note_id: str, audio: AnalyzedAudio) -> None:
    """POST (at most 60s of) the decoded audio to Deepgram Nova-3."""
    wav_bytes = pcm_to_wav(audio.pcm)
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                DEEPGRAM_LISTEN_URL,
                params={
                    "model": "nova-3",
                    "smart_format": "true",
                    "punctuate": "true",
                    "detect_language": "true",
                },
                headers={
                    "Content-Type": "audio/wav",
                    "Authorization": f"Token {settings.DEEPGRAM_API_KEY}",
                },
                content=wav_bytes,
                timeout=DEEPGRAM_TIMEOUT_SECONDS,
            )
        if resp.status_code != 200:
            logger.error(
                "[worker] Deepgram returned %s: %s", resp.status_code, resp.text[:500]
            )
            return
        data = resp.json()
    except Exception:
        logger.error(
            "[worker] Deepgram request failed for %s", voice_note_id, exc_info=True
        )
        return

    channels = data.get("results", {}).get("channels", [])
    if not channels:
        logger.warning(
            "[worker] No channels in Deepgram response for %s", voice_note_id
        )
        return
    alternatives = channels[0].get("alternatives", [])
    if not alternatives:
        logger.warning(
            "[worker] No alternatives in Deepgram response for %s", voice_note_id
        )
        return

    best = alternatives[0]
    transcript = best.get("transcript", "")
    transcript_words = [
        {
            "word": w.get("word", ""),
            "start_ms": int(w.get("start", 0) * 1000),
            "end_ms": int(w.get("end", 0) * 1000),
        }
        for w in best.get("words", [])
    ]
    await _update_voice_note(
        voice_note_id,
        transcript=transcript,
        transcript_lang=channels[0].get("detected_language"),
        transcript_words=transcript_words,
    )
    logger.info(
        "[worker] Transcription complete for %s (%d chars)",
        voice_note_id,
        len(transcript),
    )


async def process_voice_note(voice_note_id: str) -> None:
    """Backfill the waveform if missing, then transcribe the voice note."""
    try:
        vn = await _load_voice_note(voice_note_id)
        if vn is None:
            logger.error("[worker] Voice note %s not found", voice_note_id)
            return
        needs_waveform = not vn.waveform_peaks
        needs_transcript = bool(settings.DEEPGRAM_API_KEY)
        if not needs_transcript:
            logger.warning(
                "[worker] DEEPGRAM_API_KEY not set, skipping transcription for %s",
                voice_note_id,
            )
        if not (needs_waveform or needs_transcript):
            return

        audio = await _download_and_analyze(vn.audio_url)
        if audio is None:
            return

        if needs_waveform:
            peaks = compute_waveform_peaks(audio.pcm)
            await _update_voice_note(voice_note_id, waveform_peaks=peaks)
            logger.info(
                "[worker] Waveform generated for %s (%d peaks)",
                voice_note_id,
                len(peaks),
            )
        if needs_transcript:
            await _transcribe(voice_note_id, audio)
    except Exception:
        logger.error("[worker] Processing failed for %s", voice_note_id, exc_info=True)
