"""
Bounded, allowlisted ffmpeg/ffprobe helpers for user-uploaded voice audio.

Voice note bytes come straight from a presigned upload, so they are fully
attacker-controlled. Handing them to ffmpeg with auto-detection enabled
exposes every demuxer (HLS, concat, image2, ...) and lets a tiny file decode
into hours of PCM. Every invocation here therefore:

* forces the demuxer with ``-f`` from a per-content-type allowlist (never
  auto-probes) and restricts I/O with ``-protocol_whitelist file``;
* requires the first audio stream to use an allowlisted codec;
* caps decoding with ``-t`` so output (and memory) is bounded no matter what
  the container claims, and measures the *real* duration from the decoded
  samples instead of trusting container metadata;
* runs as an async subprocess with a hard timeout, so the event loop never
  blocks on decode work.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import logging
import sys
import wave
from array import array
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Demuxers tried, in order, for each upload content type. ``audio/mp4`` also
# accepts WebM/Ogg because the web composer uploads Firefox/older-Chromium
# MediaRecorder output (webm/ogg + opus) under an ``audio/mp4`` content type
# (see landing/lib/api/voice-notes.ts RECORDER_MIME_CANDIDATES).
ALLOWED_DEMUXERS: dict[str, tuple[str, ...]] = {
    "audio/mp4": ("mp4", "webm", "ogg"),
    "audio/aac": ("mp4", "aac"),
    "audio/mp3": ("mp3",),
}
ALLOWED_CODECS = frozenset({"aac", "mp3", "opus"})

# Server-generated object keys end in one of these; maps back to the upload
# content type so the worker can pick the same demuxer allowlist.
EXTENSION_CONTENT_TYPES: dict[str, str] = {
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "mp3": "audio/mp3",
}
CONTENT_TYPE_EXTENSIONS: dict[str, str] = {
    content_type: ext for ext, content_type in EXTENSION_CONTENT_TYPES.items()
}

MAX_VOICE_NOTE_DURATION_MS = 60_000
# Recorders overshoot the 60s cap slightly; anything past this is rejected.
DURATION_TOLERANCE_MS = 1_000
MAX_ACCEPTED_DURATION_MS = MAX_VOICE_NOTE_DURATION_MS + DURATION_TOLERANCE_MS
# Decode a little past the accepted max so "too long" is detectable.
DECODE_LIMIT_SECONDS = (MAX_ACCEPTED_DURATION_MS + 500) / 1000

PCM_SAMPLE_RATE = 16_000
PCM_SAMPLE_WIDTH_BYTES = 2  # s16le mono
WAVEFORM_PEAK_COUNT = 200

PROBE_TIMEOUT_SECONDS = 10.0
DECODE_TIMEOUT_SECONDS = 30.0
_STDERR_LOG_LIMIT = 500
# Cap concurrent ffprobe/ffmpeg pipelines so a burst of uploads from many
# fids can't exhaust the API host's CPU.
MAX_CONCURRENT_ANALYSES = 4
_analysis_slots = asyncio.Semaphore(MAX_CONCURRENT_ANALYSES)


class AudioValidationError(Exception):
    """The uploaded audio is not an acceptable voice note."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class AudioToolError(Exception):
    """ffmpeg/ffprobe could not be run (server-side problem, not the upload)."""


@dataclass(frozen=True)
class AnalyzedAudio:
    demuxer: str
    codec: str
    duration_ms: int
    pcm: bytes  # s16le mono at PCM_SAMPLE_RATE, capped at DECODE_LIMIT_SECONDS


def content_type_for_key(object_key: str) -> str | None:
    """Map a server-generated voice object key back to its upload content type."""
    _, _, ext = object_key.rpartition(".")
    return EXTENSION_CONTENT_TYPES.get(ext.lower())


async def _run(args: list[str], timeout: float) -> tuple[int, bytes, bytes]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        raise AudioToolError(f"failed to start {args[0]}: {exc}") from exc
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        raise AudioValidationError("timeout") from None
    return proc.returncode or 0, stdout, stderr


async def _probe_codec(path: str, demuxer: str) -> str | None:
    """Return the first audio stream's codec if ``path`` parses as ``demuxer``."""
    returncode, stdout, _ = await _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-f",
            demuxer,
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "json",
            path,
        ],
        PROBE_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        return None
    try:
        streams = json.loads(stdout or b"{}").get("streams") or []
    except (ValueError, AttributeError):
        return None
    if not streams:
        return None
    codec = streams[0].get("codec_name")
    return codec if isinstance(codec, str) else None


async def _decode_pcm(path: str, demuxer: str) -> bytes:
    returncode, stdout, stderr = await _run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-f",
            demuxer,
            "-i",
            path,
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-t",
            f"{DECODE_LIMIT_SECONDS:.3f}",
            "-ac",
            "1",
            "-ar",
            str(PCM_SAMPLE_RATE),
            "-f",
            "s16le",
            "pipe:1",
        ],
        DECODE_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        logger.info(
            "[audio_probe] decode failed (%s): %s",
            demuxer,
            stderr[:_STDERR_LOG_LIMIT].decode("utf-8", "replace"),
        )
        raise AudioValidationError("decode_failed")
    return stdout


def pcm_duration_ms(pcm: bytes) -> int:
    samples = len(pcm) // PCM_SAMPLE_WIDTH_BYTES
    return samples * 1000 // PCM_SAMPLE_RATE


async def analyze_audio(path: str, content_type: str) -> AnalyzedAudio:
    """Validate an uploaded voice file and decode it to bounded mono PCM.

    Raises :class:`AudioValidationError` when the file is not an allowlisted
    container/codec, is empty, or decodes to more than
    ``MAX_ACCEPTED_DURATION_MS``; :class:`AudioToolError` when ffmpeg itself
    is unavailable.
    """
    demuxers = ALLOWED_DEMUXERS.get(content_type)
    if not demuxers:
        raise AudioValidationError("unsupported_content_type")
    async with _analysis_slots:
        return await _analyze_with(path, demuxers)


async def _analyze_with(path: str, demuxers: tuple[str, ...]) -> AnalyzedAudio:
    for demuxer in demuxers:
        codec = await _probe_codec(path, demuxer)
        if codec is None:
            continue
        if codec not in ALLOWED_CODECS:
            raise AudioValidationError("unsupported_codec")
        pcm = await _decode_pcm(path, demuxer)
        duration_ms = pcm_duration_ms(pcm)
        if duration_ms <= 0:
            raise AudioValidationError("empty_audio")
        if duration_ms > MAX_ACCEPTED_DURATION_MS:
            raise AudioValidationError("too_long")
        return AnalyzedAudio(
            demuxer=demuxer, codec=codec, duration_ms=duration_ms, pcm=pcm
        )

    raise AudioValidationError("unsupported_format")


def _pcm_samples(pcm: bytes) -> array:
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % PCM_SAMPLE_WIDTH_BYTES])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def compute_waveform_peaks(
    pcm: bytes, num_peaks: int = WAVEFORM_PEAK_COUNT
) -> list[float]:
    """Return ``num_peaks`` normalized (0..1) absolute peaks of s16le PCM.

    Uses C-level ``max``/``min`` over array slices rather than a per-sample
    Python loop.
    """
    samples = _pcm_samples(pcm)
    if not samples:
        return []
    chunk_size = max(len(samples) // num_peaks, 1)
    peaks: list[float] = []
    for i in range(num_peaks):
        chunk = samples[i * chunk_size : (i + 1) * chunk_size]
        if not chunk:
            break
        peaks.append(float(max(max(chunk), -min(chunk))))
    top = max(peaks)
    if top <= 0:
        return [0.0] * len(peaks)
    return [min(p / top, 1.0) for p in peaks]


def pcm_to_wav(pcm: bytes, max_ms: int = MAX_VOICE_NOTE_DURATION_MS) -> bytes:
    """Wrap (at most ``max_ms`` of) s16le mono PCM in a WAV container."""
    max_bytes = PCM_SAMPLE_RATE * PCM_SAMPLE_WIDTH_BYTES * max_ms // 1000
    clipped = pcm[: min(len(pcm), max_bytes)]
    clipped = clipped[: len(clipped) - len(clipped) % PCM_SAMPLE_WIDTH_BYTES]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(PCM_SAMPLE_WIDTH_BYTES)
        wav.setframerate(PCM_SAMPLE_RATE)
        wav.writeframes(clipped)
    return buf.getvalue()
