"""Tests for the lifespan shutdown recording-drain.

``_drain_active_recordings`` is the redeploy-safety net: on SIGTERM it
finalizes every in-flight native recording (flush + upload) before the
process exits, so a redeploy can't orphan one with its audio stranded in
the worker's local temp file.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import app.main as main_mod


class _FakeRoom:
    def __init__(self, recording_id: str):
        self.id = uuid.uuid4()
        self.recording_id = recording_id


class _FakeResult:
    def __init__(self, room):
        self._room = room

    def scalar_one_or_none(self):
        return self._room


def _patch_drain_deps(monkeypatch, *, rooms_by_rid):
    """Patch the symbols ``_drain_active_recordings`` imports lazily so the
    drain runs against fakes (no DB / LiveKit / Redis needed)."""

    class _FakeDB:
        async def execute(self, stmt):
            # The drain issues exactly one select(Room).where(recording_id==..).
            # Return whichever room the current _finalize_one is looking for by
            # scanning the compiled bind — simpler: stash on the session.
            return _FakeResult(self._next_room)

    @asynccontextmanager
    async def _fake_session():
        db = _FakeDB()
        db._next_room = _patch_drain_deps._current_room
        yield db

    monkeypatch.setattr("app.database.async_session", _fake_session)

    class _StubLiveKit:
        async def close(self):
            return None

    monkeypatch.setattr("app.services.livekit_service.LiveKitService", _StubLiveKit)

    import app.services.room_service as rs_mod

    stop_mock = AsyncMock(return_value={"status": "stopped", "recording_url": "s3://x"})
    monkeypatch.setattr(rs_mod.RoomService, "admin_stop_native_recording", stop_mock)
    return stop_mock


def _make_app(active_ids):
    recording_agent = SimpleNamespace(
        active_recording_ids=lambda: list(active_ids),
        stop_recording=AsyncMock(),
    )
    app = SimpleNamespace(
        state=SimpleNamespace(
            recording_agent_service=recording_agent,
            farcaster_spaces_service=MagicMock(),
            redis=MagicMock(),
        )
    )
    return app


@pytest.mark.asyncio
async def test_drain_finalizes_each_active_recording(monkeypatch):
    rid = "rec-abc123"
    room = _FakeRoom(rid)
    _patch_drain_deps._current_room = room
    stop_mock = _patch_drain_deps(monkeypatch, rooms_by_rid={rid: room})

    app = _make_app([rid])
    await main_mod._drain_active_recordings(app)

    stop_mock.assert_awaited_once()
    (called_room_id,) = stop_mock.await_args.args
    assert called_room_id == str(room.id)


@pytest.mark.asyncio
async def test_drain_noop_when_nothing_active(monkeypatch):
    stop_mock = _patch_drain_deps(monkeypatch, rooms_by_rid={})
    _patch_drain_deps._current_room = None

    app = _make_app([])
    await main_mod._drain_active_recordings(app)

    stop_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_drain_noop_when_services_unconfigured():
    # No recording_agent wired (e.g. raw ASGI test app) — must not raise.
    app = SimpleNamespace(
        state=SimpleNamespace(
            recording_agent_service=None,
            farcaster_spaces_service=None,
            redis=MagicMock(),
        )
    )
    await main_mod._drain_active_recordings(app)


@pytest.mark.asyncio
async def test_drain_swallows_finalize_errors(monkeypatch):
    rid = "rec-err"
    room = _FakeRoom(rid)
    _patch_drain_deps._current_room = room
    stop_mock = _patch_drain_deps(monkeypatch, rooms_by_rid={rid: room})
    stop_mock.side_effect = RuntimeError("worker wedged")

    app = _make_app([rid])
    # Must NOT raise — a wedged worker can't block the rest of shutdown.
    await main_mod._drain_active_recordings(app)
    stop_mock.assert_awaited_once()
