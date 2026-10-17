"""Tests for the allowlisted, bounded voice audio pipeline (audio_probe)."""

import asyncio
import io
import shutil
import subprocess
import wave
from array import array
from pathlib import Path

import pytest

from app.services import audio_probe
from app.services.audio_probe import (
    MAX_ACCEPTED_DURATION_MS,
    PCM_SAMPLE_RATE,
    AudioValidationError,
    analyze_audio,
    compute_waveform_peaks,
    content_type_for_key,
    pcm_duration_ms,
    pcm_to_wav,
)

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
requires_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")


def _encode(tmp_path: Path, name: str, seconds: float, *codec_args: str) -> str:
    out = tmp_path / name
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            *codec_args,
            str(out),
        ],
        check=True,
    )
    return str(out)


def _pcm(samples: list[int]) -> bytes:
    return array("h", samples).tobytes()


# --- Real ffmpeg: format/codec allowlist and real-duration enforcement ---


@requires_ffmpeg
async def test_accepts_aac_m4a_and_measures_real_duration(tmp_path):
    path = _encode(tmp_path, "a.m4a", 3, "-c:a", "aac")
    result = await analyze_audio(path, "audio/mp4")
    assert result.demuxer == "mp4"
    assert result.codec == "aac"
    assert 2800 <= result.duration_ms <= 3200
    assert pcm_duration_ms(result.pcm) == result.duration_ms


@requires_ffmpeg
async def test_accepts_web_opus_uploaded_as_audio_mp4(tmp_path):
    """Firefox MediaRecorder webm/opus is uploaded under audio/mp4."""
    path = _encode(tmp_path, "a.webm", 2, "-c:a", "libopus")
    result = await analyze_audio(path, "audio/mp4")
    assert result.demuxer == "webm"
    assert result.codec == "opus"


@requires_ffmpeg
async def test_accepts_mp3(tmp_path):
    path = _encode(tmp_path, "a.mp3", 2, "-c:a", "libmp3lame")
    result = await analyze_audio(path, "audio/mp3")
    assert result.codec == "mp3"


@requires_ffmpeg
async def test_rejects_audio_longer_than_cap(tmp_path):
    path = _encode(tmp_path, "long.m4a", 70, "-c:a", "aac")
    with pytest.raises(AudioValidationError) as exc:
        await analyze_audio(path, "audio/mp4")
    assert exc.value.reason == "too_long"


@requires_ffmpeg
async def test_rejects_non_allowlisted_codec(tmp_path):
    path = _encode(tmp_path, "alac.m4a", 1, "-c:a", "alac")
    with pytest.raises(AudioValidationError) as exc:
        await analyze_audio(path, "audio/mp4")
    assert exc.value.reason == "unsupported_codec"


@requires_ffmpeg
async def test_rejects_non_allowlisted_container(tmp_path):
    path = _encode(tmp_path, "a.wav", 1, "-c:a", "pcm_s16le")
    with pytest.raises(AudioValidationError) as exc:
        await analyze_audio(path, "audio/mp4")
    assert exc.value.reason == "unsupported_format"


@requires_ffmpeg
async def test_rejects_hls_playlist_without_following_references(tmp_path):
    """Auto-probing would hand this to the HLS demuxer, which opens URLs."""
    secret = tmp_path / "secret.m4a"
    _encode(tmp_path, "secret.m4a", 1, "-c:a", "aac")
    playlist = tmp_path / "evil.m4a"
    playlist.write_text(
        "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n"
        f"file://{secret}\n#EXT-X-ENDLIST\n"
    )
    with pytest.raises(AudioValidationError) as exc:
        await analyze_audio(str(playlist), "audio/mp4")
    assert exc.value.reason == "unsupported_format"


@requires_ffmpeg
async def test_rejects_garbage_bytes(tmp_path):
    path = tmp_path / "junk.m4a"
    path.write_bytes(b"\x00\x01not audio at all" * 64)
    with pytest.raises(AudioValidationError):
        await analyze_audio(str(path), "audio/mp4")


async def test_rejects_unknown_content_type(tmp_path):
    with pytest.raises(AudioValidationError) as exc:
        await analyze_audio(str(tmp_path / "x"), "video/mp4")
    assert exc.value.reason == "unsupported_content_type"


async def test_decode_command_is_bounded_and_whitelisted(monkeypatch, tmp_path):
    """Every ffmpeg/ffprobe call forces -f, whitelists file I/O and caps -t."""
    calls: list[list[str]] = []

    async def fake_run(args, timeout):
        calls.append(args)
        if args[0] == "ffprobe":
            return 0, b'{"streams": [{"codec_name": "aac"}]}', b""
        return 0, _pcm([1000] * PCM_SAMPLE_RATE), b""

    monkeypatch.setattr(audio_probe, "_run", fake_run)
    result = await analyze_audio(str(tmp_path / "a.m4a"), "audio/mp4")

    assert result.duration_ms == 1000
    for args in calls:
        assert args[args.index("-f") + 1] in {"mp4", "webm", "ogg"}
        assert args[args.index("-protocol_whitelist") + 1] == "file"
    decode = calls[-1]
    assert decode[0] == "ffmpeg"
    assert (
        float(decode[decode.index("-t") + 1]) * 1000 < MAX_ACCEPTED_DURATION_MS + 1000
    )


async def test_falls_through_demuxers_in_allowlist_order(monkeypatch, tmp_path):
    tried: list[str] = []

    async def fake_run(args, timeout):
        demuxer = args[args.index("-f") + 1]
        if args[0] == "ffprobe":
            tried.append(demuxer)
            if demuxer == "ogg":
                return 0, b'{"streams": [{"codec_name": "opus"}]}', b""
            return 1, b"", b"invalid data"
        return 0, _pcm([5] * 1600), b""

    monkeypatch.setattr(audio_probe, "_run", fake_run)
    result = await analyze_audio(str(tmp_path / "a.m4a"), "audio/mp4")
    assert tried == ["mp4", "webm", "ogg"]
    assert result.demuxer == "ogg"


async def test_decode_timeout_is_a_validation_error(monkeypatch, tmp_path):
    monkeypatch.setattr(audio_probe, "PROBE_TIMEOUT_SECONDS", 0.2)
    sleeper = tmp_path / "ffprobe"
    sleeper.write_text("#!/bin/sh\nexec /bin/sleep 5\n")
    sleeper.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(AudioValidationError) as exc:
        await analyze_audio(str(tmp_path / "a.m4a"), "audio/mp4")
    assert exc.value.reason == "timeout"


async def test_timeout_survives_process_already_exited(monkeypatch):
    """kill() racing a just-exited child must still report a timeout."""

    class ExitedProc:
        returncode = None

        async def communicate(self):
            await asyncio.sleep(5)

        def kill(self):
            raise ProcessLookupError

        async def wait(self):
            return 0

    async def fake_exec(*args, **kwargs):
        return ExitedProc()

    monkeypatch.setattr(audio_probe.asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(AudioValidationError) as exc:
        await audio_probe._run(["ffprobe"], timeout=0.05)
    assert exc.value.reason == "timeout"


# --- Pure helpers ---


def test_waveform_peaks_normalized_and_bounded():
    pcm = _pcm([0, 100, -200, 50] * 1000)
    peaks = compute_waveform_peaks(pcm)
    assert len(peaks) == 200
    assert max(peaks) == 1.0
    assert all(0.0 <= p <= 1.0 for p in peaks)


def test_waveform_peaks_silence_does_not_divide_by_zero():
    assert compute_waveform_peaks(_pcm([0] * 4000)) == [0.0] * 200


def test_waveform_peaks_empty_input():
    assert compute_waveform_peaks(b"") == []


def test_waveform_peaks_handles_int16_min():
    peaks = compute_waveform_peaks(_pcm([-32768, 10] * 500))
    assert max(peaks) == 1.0


def test_pcm_to_wav_trims_to_sixty_seconds():
    pcm = b"\x01\x00" * (PCM_SAMPLE_RATE * 61)
    with wave.open(io.BytesIO(pcm_to_wav(pcm)), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getframerate() == PCM_SAMPLE_RATE
        assert wav.getnframes() == PCM_SAMPLE_RATE * 60


@pytest.mark.parametrize(
    "key,expected",
    [
        ("voice-notes/1/abc.m4a", "audio/mp4"),
        ("voice-notes/1/abc.aac", "audio/aac"),
        ("voice-notes/1/abc.mp3", "audio/mp3"),
        ("voice-notes/1/abc.m3u8", None),
        ("voice-notes/1/abc", None),
    ],
)
def test_content_type_for_key(key, expected):
    assert content_type_for_key(key) == expected
