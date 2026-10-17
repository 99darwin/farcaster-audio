"""Recording-agent dispatcher — drives an out-of-process Node worker
that joins a Farcaster-native LiveKit room as a passive listener and
writes mixed audio to S3.

Two-process design (Option A from the Phase-4 plan):

* The Python ``RecordingAgentService`` owns the subprocess lifecycle:
  spawn, JSON-line stdin/stdout protocol, SIGTERM-on-stop, finalize.
* The Node worker (``backend/recording_agent/worker.mjs``) holds the
  LiveKit + ffmpeg + S3 wiring. It receives a single JSON-line config
  on stdin and emits structured ``{event: ...}`` lines on stdout.

The wire protocol is intentionally minimal so the Python side stays
agnostic to the underlying media stack — if/when we swap ``@livekit/
rtc-node`` for native ffmpeg + GStreamer + custom mixing, the Python
orchestration is unchanged.

SECURITY:

* The bearer-derived join token + signaling URL are passed via the
  JSON-line stdin payload, NEVER as argv. Argv is world-readable on
  Linux via ``/proc/<pid>/cmdline``.
* The Node worker path is configuration-driven (``Settings.JUKE_
  RECORDING_AGENT_WORKER_PATH``) — the caller never injects arbitrary
  paths from user input.
* The worker is spawned with ``shell=False`` (``create_subprocess_exec``)
  so no shell metacharacter handling is involved.
* No bearer / token material is logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.config import Settings

logger = logging.getLogger(__name__)


# Hard upper bound on how long we wait for the worker to acknowledge a
# spawn-then-start. Keeps a misconfigured worker from wedging the
# request thread.
_START_HANDSHAKE_TIMEOUT_SECONDS = 15.0
# Same for the finalize handshake at stop time. Recordings finalize as
# fast as ffmpeg can flush + upload; 30s is generous.
_STOP_HANDSHAKE_TIMEOUT_SECONDS = 30.0


class RecordingAgentError(RuntimeError):
    """Raised when the Node worker fails to start, dies unexpectedly,
    or finalizes with an error."""


@dataclass
class _ActiveRecording:
    """In-memory handle to a running worker subprocess."""

    recording_id: str
    process: asyncio.subprocess.Process
    s3_target: str
    # Cached final URL once the worker emits ``finalized``. Populated
    # by ``stop_recording`` via the worker's stdout response so a
    # later GET on the room can serve it.
    finalized_url: str | None = None
    # Watchdog task — drains stdout in the background so the pipe
    # never fills and blocks the worker. Cancelled at stop.
    reader_task: asyncio.Task[None] | None = field(default=None)


class RecordingAgentService:
    """Spawn + supervise out-of-process Node recording workers.

    One instance per process; holds the active-recordings dict in
    memory. Multi-process deployments would need a Redis-backed
    registry — out of scope for Phase 4 part 1.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._active: dict[str, _ActiveRecording] = {}
        self._lock = asyncio.Lock()

    # -----------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------

    def active_recording_ids(self) -> list[str]:
        """Snapshot of the recording_ids this process currently owns.

        Used by the lifespan shutdown drain to finalize every in-flight
        worker before the process exits on SIGTERM (redeploy), so a
        recording can't be orphaned with its audio stranded in the
        worker's local temp file. Returns a copy so callers can stop
        recordings (mutating ``_active``) while iterating.
        """
        return list(self._active.keys())

    async def start_recording(
        self,
        *,
        room_id: str,
        signaling_url: str,
        token: str,
        s3_target: str,
    ) -> str:
        """Spawn the Node worker, hand it the join config, and wait for
        the ``started`` event. Returns an opaque ``recording_id`` the
        caller persists for ``stop_recording``.

        Raises ``RecordingAgentError`` on:
          * Worker process failed to spawn.
          * Worker emitted ``{"event": "error", ...}`` before ``started``.
          * Handshake timed out.
        """
        recording_id = uuid.uuid4().hex

        worker_path = self._settings.JUKE_RECORDING_AGENT_WORKER_PATH
        node_bin = self._settings.JUKE_RECORDING_AGENT_NODE_BIN

        try:
            process = await asyncio.create_subprocess_exec(
                node_bin,
                worker_path,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            logger.error(
                "[recording-agent] failed to spawn worker (bin=%s, path=%s): %s",
                node_bin,
                worker_path,
                type(exc).__name__,
            )
            raise RecordingAgentError("Failed to spawn recording-agent worker") from exc
        except OSError as exc:  # pragma: no cover - extremely rare
            logger.exception("[recording-agent] OSError spawning worker")
            raise RecordingAgentError("Failed to spawn recording-agent worker") from exc

        # Build the config payload. Note: ``token`` is a LiveKit JWT —
        # treat as secret. We pass via stdin (not argv) so it never
        # appears in /proc/<pid>/cmdline.
        config = {
            "recording_id": recording_id,
            "signaling_url": signaling_url,
            "token": token,
            "room_id": room_id,
            "s3_target": s3_target,
        }
        payload = (json.dumps(config) + "\n").encode("utf-8")

        assert process.stdin is not None
        assert process.stdout is not None
        try:
            process.stdin.write(payload)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            await self._terminate(process)
            raise RecordingAgentError(
                "Recording-agent worker closed stdin before handshake"
            ) from exc

        # Wait for the ``started`` event (or an immediate error).
        try:
            event = await asyncio.wait_for(
                self._read_event(process.stdout),
                timeout=_START_HANDSHAKE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError as exc:
            await self._terminate(process)
            raise RecordingAgentError(
                "Recording-agent worker did not acknowledge start in time"
            ) from exc

        if event.get("event") != "started":
            # Includes ``{"event": "error", ...}`` and any malformed
            # response. The worker may already be exiting — let it run
            # a beat longer so its final stderr lines flush before we
            # terminate. Drain BOTH streams fully so a chunked stderr
            # (warnings printed at module load + the real error printed
            # later) doesn't lose the back half of the diagnostic.
            stderr_dump = ""
            stdout_dump = ""
            try:
                # Wait up to 3s for the worker to exit on its own.
                # The race with _terminate is intentional — most workers
                # exit milliseconds after emitting an error event.
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except Exception:  # pragma: no cover — diagnostic best-effort
                pass
            try:
                if process.stderr is not None:
                    raw = await asyncio.wait_for(process.stderr.read(), timeout=1.0)
                    if raw:
                        stderr_dump = raw.decode("utf-8", errors="replace")
            except Exception:  # pragma: no cover
                pass
            try:
                if process.stdout is not None:
                    raw = await asyncio.wait_for(process.stdout.read(), timeout=1.0)
                    if raw:
                        stdout_dump = raw.decode("utf-8", errors="replace")
            except Exception:  # pragma: no cover
                pass
            await self._terminate(process)
            message = event.get("message") or "worker rejected start"
            # Log the FULL event dict (not just `message`) so we can see
            # what shape the worker actually emitted — `event.get` falls
            # back to the generic string when the message field is empty
            # or missing, and that string used to be the only signal.
            logger.warning(
                "[recording-agent] start rejected — event=%s "
                "stdout_after=%s stderr=%s",
                json.dumps(event),
                (stdout_dump.strip()[:1024] or "<empty>"),
                (stderr_dump.strip()[:4096] or "<empty>"),
            )
            raise RecordingAgentError(f"Recording-agent worker error: {message}")

        # Drain remaining stdout in the background so the pipe buffer
        # can't fill and block the worker. We don't act on these
        # events except logging — the only event we care about
        # post-start is ``finalized``, which ``stop_recording`` reads
        # synchronously after sending SIGTERM.
        reader_task = asyncio.create_task(
            self._drain_stdout(process, recording_id),
            name=f"recording-agent-reader:{recording_id}",
        )

        async with self._lock:
            self._active[recording_id] = _ActiveRecording(
                recording_id=recording_id,
                process=process,
                s3_target=s3_target,
                reader_task=reader_task,
            )

        logger.info(
            "[recording-agent] worker started recording_id=%s room_id=%s " "(pid=%s)",
            recording_id,
            room_id,
            process.pid,
        )
        return recording_id

    async def stop_recording(self, recording_id: str) -> str:
        """Signal the worker to finalize, await its ``finalized`` event,
        and return the final S3 URL.

        Raises ``RecordingAgentError`` if:
          * No active worker for that recording_id.
          * Worker emits ``{event: "error"}`` during finalize.
          * Worker exits without emitting ``finalized``.
        """
        async with self._lock:
            handle = self._active.get(recording_id)
        if handle is None:
            raise RecordingAgentError(
                f"No active recording-agent worker for id {recording_id}"
            )

        process = handle.process

        # Cancel the background drain so we can read the next stdout
        # event synchronously below. The reader task is best-effort
        # noise; cancellation is non-fatal.
        if handle.reader_task is not None and not handle.reader_task.done():
            handle.reader_task.cancel()
            try:
                await handle.reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

        # Send SIGTERM so the worker can finalize gracefully. On
        # Windows ``send_signal`` falls back to terminate() — fine for
        # dev, prod runs on Linux.
        if process.returncode is None:
            try:
                process.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass  # process already gone

        # Read events until we see ``finalized`` or ``error`` or EOF.
        finalized_url: str | None = None
        try:
            assert process.stdout is not None
            while True:
                try:
                    event = await asyncio.wait_for(
                        self._read_event(process.stdout),
                        timeout=_STOP_HANDSHAKE_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError as exc:
                    await self._terminate(process)
                    raise RecordingAgentError(
                        "Recording-agent worker finalize timed out"
                    ) from exc

                kind = event.get("event")
                if kind == "finalized":
                    url = event.get("url")
                    if not isinstance(url, str) or not url:
                        raise RecordingAgentError(
                            "Recording-agent finalize missing url"
                        )
                    finalized_url = url
                    break
                if kind == "error":
                    message = event.get("message") or "unknown worker error"
                    # Drain stderr so the operator-only diagnostic
                    # (worker name + AWS Code + status + endpoint, etc.)
                    # surfaces in our logs alongside the sanitized
                    # stdout message. Same pattern as the start path.
                    stderr_dump = ""
                    try:
                        if process.stderr is not None:
                            raw = await asyncio.wait_for(
                                process.stderr.read(), timeout=1.0
                            )
                            if raw:
                                stderr_dump = raw.decode("utf-8", errors="replace")
                    except Exception:  # pragma: no cover
                        pass
                    logger.warning(
                        "[recording-agent] finalize failed — event=%s " "stderr=%s",
                        json.dumps(event),
                        (stderr_dump.strip()[:4096] or "<empty>"),
                    )
                    raise RecordingAgentError(
                        f"Recording-agent worker error: {message}"
                    )
                # Any other event type (e.g. ``progress``) is informational.
                logger.debug(
                    "[recording-agent] %s event ignored during finalize: %s",
                    recording_id,
                    kind,
                )
        finally:
            # Wait for the process to actually exit so we don't leak
            # a zombie.
            try:
                await asyncio.wait_for(process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                await self._terminate(process)

            async with self._lock:
                self._active.pop(recording_id, None)

        assert finalized_url is not None
        logger.info(
            "[recording-agent] worker finalized recording_id=%s (rc=%s)",
            recording_id,
            process.returncode,
        )
        return finalized_url

    # -----------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------

    async def _read_event(self, stdout: asyncio.StreamReader) -> dict[str, Any]:
        """Read the next worker event from stdout.

        Some dependencies (notably ``@livekit/rtc-node``'s internal pino
        logger) write structured log lines to stdout that share the
        protocol's JSON-line shape but aren't worker events — they have
        no ``event`` field and instead use pino's ``level``/``msg``/
        ``name`` fields. Without filtering, the orchestrator would read
        one of those as the worker's "first event," see no ``event``
        key, and reject the start before our real ``{event: "started"}``
        ever lands.

        Discriminator: an event MUST have a non-empty string ``event``
        field. Non-conformant lines are logged at DEBUG and skipped so
        the protocol stays self-describing without depending on every
        upstream library to keep stdout clean.

        Raises ``RecordingAgentError`` on EOF without a real event,
        malformed UTF-8, or non-JSON-object input.
        """
        while True:
            raw = await stdout.readline()
            if not raw:
                raise RecordingAgentError(
                    "Recording-agent worker closed stdout unexpectedly"
                )
            try:
                decoded = json.loads(raw.decode("utf-8").strip())
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                # Non-JSON noise on stdout (a stray println, banner,
                # etc). Skip — operators can grep the worker's stderr
                # for any meaningful diagnostic.
                logger.debug("[recording-agent] skipping non-JSON stdout line")
                continue
            if not isinstance(decoded, dict):
                raise RecordingAgentError(
                    "Recording-agent worker event was not a JSON object"
                )
            ev = decoded.get("event")
            if not isinstance(ev, str) or not ev:
                # Library log line (pino-style or similar). Skip and
                # keep reading for the real worker event.
                logger.debug(
                    "[recording-agent] skipping non-event stdout line " "(keys=%s)",
                    sorted(decoded.keys()),
                )
                continue
            return decoded

    async def _drain_stdout(
        self,
        process: asyncio.subprocess.Process,
        recording_id: str,
    ) -> None:
        """Drain stdout in the background between start and stop so the
        pipe buffer can't block the worker.

        Events are logged at DEBUG only — operational signal lives on
        the start/stop synchronous reads.
        """
        assert process.stdout is not None
        try:
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    return
                try:
                    event = json.loads(raw.decode("utf-8").strip())
                except (UnicodeDecodeError, json.JSONDecodeError):
                    logger.debug(
                        "[recording-agent] %s emitted non-JSON drain line",
                        recording_id,
                    )
                    continue
                logger.debug(
                    "[recording-agent] %s drain event: %s",
                    recording_id,
                    event.get("event"),
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - best-effort
            logger.exception("[recording-agent] %s drain loop crashed", recording_id)

    async def _terminate(self, process: asyncio.subprocess.Process) -> None:
        """Force-stop a worker. Best-effort: send SIGTERM, wait briefly,
        then SIGKILL."""
        if process.returncode is not None:
            return
        try:
            process.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError:  # pragma: no cover
                logger.warning(
                    "[recording-agent] worker did not exit after SIGKILL " "(pid=%s)",
                    process.pid,
                )
