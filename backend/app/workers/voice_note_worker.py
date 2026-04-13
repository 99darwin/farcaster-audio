"""
Background tasks for voice note processing: waveform generation and transcription.

Called via asyncio.create_task() from the API router — no separate worker process needed.
"""

import logging
import tempfile
import uuid

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

MAX_WORKER_FILE_SIZE_BYTES = 10_485_760  # 10 MB


async def generate_waveform(voice_note_id: str) -> None:
    """Download audio from S3, extract 200 peaks via pydub, update DB."""
    from pydub import AudioSegment

    from app.database import async_session
    from app.models.voice_note import VoiceNote
    from app.services.storage_service import StorageService

    logger.info("[worker] Generating waveform for voice note %s", voice_note_id)

    storage = StorageService()

    # Fetch the voice note record to get the object key
    async with async_session() as db:
        from sqlalchemy import select

        result = await db.execute(
            select(VoiceNote).where(VoiceNote.id == uuid.UUID(voice_note_id))
        )
        vn = result.scalar_one_or_none()
        if not vn:
            logger.error("[worker] Voice note %s not found", voice_note_id)
            return
        object_key = vn.audio_url

    # Verify file size before downloading
    try:
        file_size = storage.get_object_size(object_key)
        if file_size > MAX_WORKER_FILE_SIZE_BYTES:
            logger.error("[worker] File %s too large (%d bytes), skipping waveform", object_key, file_size)
            return
    except Exception:
        logger.error("[worker] Failed to HEAD %s from S3", object_key, exc_info=True)
        return

    # Download to temp file
    with tempfile.NamedTemporaryFile(suffix=".m4a") as tmp:
        try:
            storage.download_file(object_key, tmp.name)
        except Exception:
            logger.error("[worker] Failed to download %s from S3", object_key, exc_info=True)
            return

        # Extract waveform peaks
        try:
            audio = AudioSegment.from_file(tmp.name)
            samples = audio.get_array_of_samples()
            num_peaks = 200
            chunk_size = max(len(samples) // num_peaks, 1)
            peaks: list[float] = []
            for i in range(num_peaks):
                chunk = samples[i * chunk_size : (i + 1) * chunk_size]
                if chunk:
                    peak = max(abs(s) for s in chunk)
                    peaks.append(float(peak))
            max_peak = max(peaks) if peaks else 1.0
            peaks = [p / max_peak for p in peaks]
        except Exception:
            logger.error("[worker] Failed to process audio for %s", voice_note_id, exc_info=True)
            return

    # Update DB
    async with async_session() as db:
        from sqlalchemy import update

        await db.execute(
            update(VoiceNote)
            .where(VoiceNote.id == uuid.UUID(voice_note_id))
            .values(waveform_peaks=peaks)
        )
        await db.commit()

    logger.info("[worker] Waveform generated for %s (%d peaks)", voice_note_id, len(peaks))


async def transcribe(voice_note_id: str) -> None:
    """Download audio from S3, POST to Deepgram Nova-3, update DB."""
    from app.database import async_session
    from app.models.voice_note import VoiceNote
    from app.services.storage_service import StorageService

    if not settings.DEEPGRAM_API_KEY:
        logger.warning("[worker] DEEPGRAM_API_KEY not set, skipping transcription for %s", voice_note_id)
        return

    logger.info("[worker] Transcribing voice note %s", voice_note_id)

    storage = StorageService()

    # Fetch the voice note record
    async with async_session() as db:
        from sqlalchemy import select

        result = await db.execute(
            select(VoiceNote).where(VoiceNote.id == uuid.UUID(voice_note_id))
        )
        vn = result.scalar_one_or_none()
        if not vn:
            logger.error("[worker] Voice note %s not found", voice_note_id)
            return
        object_key = vn.audio_url

    # Verify file size before downloading
    try:
        file_size = storage.get_object_size(object_key)
        if file_size > MAX_WORKER_FILE_SIZE_BYTES:
            logger.error("[worker] File %s too large (%d bytes), skipping transcription", object_key, file_size)
            return
    except Exception:
        logger.error("[worker] Failed to HEAD %s from S3", object_key, exc_info=True)
        return

    # Download to temp file and read bytes
    with tempfile.NamedTemporaryFile(suffix=".m4a") as tmp:
        try:
            storage.download_file(object_key, tmp.name)
            tmp.seek(0)
            audio_bytes = tmp.read()
        except Exception:
            logger.error("[worker] Failed to download %s from S3", object_key, exc_info=True)
            return

    # Call Deepgram
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.deepgram.com/v1/listen",
                params={
                    "model": "nova-3",
                    "smart_format": "true",
                    "punctuate": "true",
                },
                headers={
                    "Content-Type": "audio/mp4",
                    "Authorization": f"Token {settings.DEEPGRAM_API_KEY}",
                },
                content=audio_bytes,
                timeout=60.0,
            )
        if resp.status_code != 200:
            logger.error("[worker] Deepgram returned %s: %s", resp.status_code, resp.text[:500])
            return

        data = resp.json()
    except Exception:
        logger.error("[worker] Deepgram request failed for %s", voice_note_id, exc_info=True)
        return

    # Parse response
    results = data.get("results", {})
    channels = results.get("channels", [])
    if not channels:
        logger.warning("[worker] No channels in Deepgram response for %s", voice_note_id)
        return

    alternatives = channels[0].get("alternatives", [])
    if not alternatives:
        logger.warning("[worker] No alternatives in Deepgram response for %s", voice_note_id)
        return

    best = alternatives[0]
    transcript = best.get("transcript", "")
    detected_language = results.get("channels", [{}])[0].get("detected_language") or channels[0].get("detected_language")

    # Extract word-level timestamps
    words = best.get("words", [])
    transcript_words = [
        {
            "word": w.get("word", ""),
            "start_ms": int(w.get("start", 0) * 1000),
            "end_ms": int(w.get("end", 0) * 1000),
        }
        for w in words
    ]

    # Update DB
    async with async_session() as db:
        from sqlalchemy import update

        await db.execute(
            update(VoiceNote)
            .where(VoiceNote.id == uuid.UUID(voice_note_id))
            .values(
                transcript=transcript,
                transcript_lang=detected_language,
                transcript_words=transcript_words,
            )
        )
        await db.commit()

    logger.info("[worker] Transcription complete for %s (%d chars)", voice_note_id, len(transcript))


async def process_voice_note(voice_note_id: str) -> None:
    """Run waveform generation and transcription for a voice note."""
    try:
        await generate_waveform(voice_note_id)
    except Exception:
        logger.error("[worker] Waveform generation failed for %s", voice_note_id, exc_info=True)

    try:
        await transcribe(voice_note_id)
    except Exception:
        logger.error("[worker] Transcription failed for %s", voice_note_id, exc_info=True)
