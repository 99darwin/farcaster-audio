"""Tests for the non-blocking, bounded voice note worker."""

import io
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.audio_probe import PCM_SAMPLE_RATE, AnalyzedAudio
from app.workers import voice_note_worker

VN_ID = "00000000-0000-4000-8000-000000000001"


def _audio(seconds: int = 61) -> AnalyzedAudio:
    return AnalyzedAudio(
        demuxer="mp4",
        codec="aac",
        duration_ms=seconds * 1000,
        pcm=b"\x10\x00" * (PCM_SAMPLE_RATE * seconds),
    )


@pytest.fixture
def worker(monkeypatch):
    update = AsyncMock()
    monkeypatch.setattr(voice_note_worker, "_update_voice_note", update)
    monkeypatch.setattr(
        voice_note_worker,
        "_load_voice_note",
        AsyncMock(
            return_value=SimpleNamespace(
                audio_url="voice-notes/1/a.m4a", waveform_peaks=None
            )
        ),
    )
    monkeypatch.setattr(
        voice_note_worker, "_download_and_analyze", AsyncMock(return_value=_audio())
    )
    return update


async def test_backfills_waveform_without_deepgram(worker, monkeypatch):
    monkeypatch.setattr(voice_note_worker.settings, "DEEPGRAM_API_KEY", "")
    transcribe = AsyncMock()
    monkeypatch.setattr(voice_note_worker, "_transcribe", transcribe)

    await voice_note_worker.process_voice_note(VN_ID)

    peaks = worker.await_args.kwargs["waveform_peaks"]
    assert len(peaks) == 200
    transcribe.assert_not_awaited()


async def test_skips_download_when_nothing_to_do(worker, monkeypatch):
    monkeypatch.setattr(voice_note_worker.settings, "DEEPGRAM_API_KEY", "")
    voice_note_worker._load_voice_note.return_value.waveform_peaks = [0.1]

    await voice_note_worker.process_voice_note(VN_ID)

    voice_note_worker._download_and_analyze.assert_not_awaited()
    worker.assert_not_awaited()


async def test_deepgram_receives_at_most_sixty_seconds(worker, monkeypatch):
    monkeypatch.setattr(voice_note_worker.settings, "DEEPGRAM_API_KEY", "test")
    sent: dict = {}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, **kwargs):
            sent.update(kwargs)
            return MagicMock(
                status_code=200,
                json=lambda: {
                    "results": {
                        "channels": [
                            {
                                "detected_language": "en",
                                "alternatives": [{"transcript": "gm", "words": []}],
                            }
                        ]
                    }
                },
            )

    monkeypatch.setattr(voice_note_worker.httpx, "AsyncClient", FakeClient)

    await voice_note_worker.process_voice_note(VN_ID)

    with wave.open(io.BytesIO(sent["content"]), "rb") as wav:
        assert wav.getnframes() <= PCM_SAMPLE_RATE * 60
    assert worker.await_args.kwargs["transcript"] == "gm"


async def test_rejected_audio_is_not_processed(worker, monkeypatch):
    monkeypatch.setattr(voice_note_worker.settings, "DEEPGRAM_API_KEY", "test")
    voice_note_worker._download_and_analyze.return_value = None
    transcribe = AsyncMock()
    monkeypatch.setattr(voice_note_worker, "_transcribe", transcribe)

    await voice_note_worker.process_voice_note(VN_ID)

    transcribe.assert_not_awaited()
    worker.assert_not_awaited()


async def test_download_skips_unknown_extension():
    assert await voice_note_worker._download_and_analyze("voice-notes/1/a.m3u8") is None


async def test_download_skips_oversized_object(monkeypatch):
    storage = MagicMock()
    storage.get_object_size.return_value = 50 * 1024 * 1024
    monkeypatch.setattr("app.services.storage_service.StorageService", lambda: storage)

    assert await voice_note_worker._download_and_analyze("voice-notes/1/a.m4a") is None
    storage.download_file.assert_not_called()
