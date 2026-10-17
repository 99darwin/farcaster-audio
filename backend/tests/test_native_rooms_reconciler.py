"""Tests for :py:class:`NativeRoomsReconciler` — the background loop
that drops Juke native ``Room`` rows whose upstream counterpart on
``client.farcaster.xyz`` has fallen off the live list.

These tests pin down the per-pass decisions in ``reconcile_once``:

* Native rooms missing from the upstream live list AND older than the
  propagation grace window get marked ended + removed from Redis.
* Native rooms still present upstream stay untouched.
* Native rooms within the grace window are kept even when missing
  upstream (the upstream index lags a few minutes behind room create).
* Upstream failures translate to a counted error, NOT a raise — the
  loop must keep ticking on transient upstream blips.
* When the spaces service is unconfigured, the pass skips silently —
  there's no offline fallback to decide what's stale.

Tests use a fake :py:class:`FarcasterSpacesService` + an in-memory
DB stand-in so we don't need a real Postgres or upstream connection.
"""

from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.models.room import Room
from app.schemas.farcaster_spaces import (
    AudioRoom,
    FarcasterSpacesConfigError,
    SpaceUser,
)
from app.services.native_rooms_reconciler import NativeRoomsReconciler

# ---------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------


class _FakeScalarsResult:
    def __init__(self, items: list[Any]):
        self._items = items

    def all(self) -> list[Any]:
        return list(self._items)


class _FakeExecuteResult:
    def __init__(self, items: list[Any]):
        self._items = items

    def scalars(self) -> _FakeScalarsResult:
        return _FakeScalarsResult(self._items)


class _FakeSession:
    """Minimal AsyncSession stand-in for the reconciler.

    The reconciler issues one ``select(Room).where(...)`` per pass and
    calls ``await db.commit()`` after mutating each candidate. We don't
    parse the WHERE clause — the test fixture pre-filters the candidate
    list to match what the real query would return.
    """

    def __init__(self, candidates: list[Room]):
        self._candidates = candidates
        self.commit_count = 0
        self.committed_rooms: list[Room] = []

    async def execute(self, _stmt: Any) -> _FakeExecuteResult:
        return _FakeExecuteResult(self._candidates)

    async def commit(self) -> None:
        self.commit_count += 1
        # Snapshot every candidate's status at commit time so tests can
        # assert which rows got flipped (and in what order).
        self.committed_rooms.append(
            next(
                (r for r in self._candidates if r.status == "ended"),
                # Fall back to the last candidate so the count stays
                # meaningful even if our heuristic above misses.
                self._candidates[0] if self._candidates else None,
            )
        )

    async def rollback(self) -> None:
        return None

    async def close(self) -> None:
        return None


def _session_maker_for(session: _FakeSession):
    """Build a session_maker callable that yields the same session each
    time. The reconciler uses it as ``async with session_maker() as
    db:`` — return an async context manager wrapping the fake."""

    @asynccontextmanager
    async def _ctx():
        yield session

    def _factory():
        return _ctx()

    return _factory


def _make_room(
    *,
    farcaster_room_id: str | None = "fc-room-1",
    status: str = "active",
    started_at: datetime | None = None,
    scheduled_at: datetime | None = None,
    recording: bool = False,
    recording_id: str | None = None,
    created_by_app_id: uuid.UUID | None = None,
    metadata_: dict | None = None,
) -> Room:
    room = Room(
        title="Native space",
        host_fid=7777,
        status=status,
        started_at=started_at or (datetime.now(tz=timezone.utc) - timedelta(hours=1)),
        scheduled_at=scheduled_at,
        ended_at=None,
        livekit_room_id=None,
        allow_agents=False,
        recording=recording,
        recording_id=recording_id,
        is_farcaster_native=True,
        farcaster_room_id=farcaster_room_id,
        created_by_app_id=created_by_app_id,
        metadata_=(
            {"source": "backend-orchestrated"} if metadata_ is None else metadata_
        ),
    )
    room.id = uuid.uuid4()
    return room


def _make_upstream_audio_room(
    room_id: str,
    state: str = "live",
    started_at: datetime | None = None,
) -> AudioRoom:
    """Build an AudioRoom matching the upstream `result.rooms[]` shape."""
    return AudioRoom(
        id=room_id,
        title="Upstream live room",
        host=SpaceUser(fid=999, username="upstream-host"),
        state=state,
        started_at=started_at,
    )


def _fake_spaces_with_live(
    live_room_ids: list[str],
    *,
    get_room_return: Any = None,
    get_room_side_effect: Any = None,
) -> Any:
    """Fake FarcasterSpacesService.

    ``list_live_rooms`` returns the given ids as the capped GLOBAL live
    index. ``get_room`` models the AUTHORITATIVE per-room lookup the
    reconciler now performs for rooms ABSENT from that global list.

    Default per-room lookup returns ``None`` (upstream 404 → truly gone),
    which preserves the historical "absent from live list ⇒ drop"
    semantics that most tests rely on. Pass ``get_room_return`` to model a
    global-index gap (e.g. a live/scheduled room) or ``get_room_side_effect``
    to model a lookup error.
    """
    svc = AsyncMock()
    svc.list_live_rooms = AsyncMock(
        return_value=[_make_upstream_audio_room(rid) for rid in live_room_ids]
    )
    if get_room_side_effect is not None:
        svc.get_room = AsyncMock(side_effect=get_room_side_effect)
    else:
        svc.get_room = AsyncMock(return_value=get_room_return)
    return svc


def _fake_redis() -> Any:
    redis = AsyncMock()
    redis.add_active_room = AsyncMock(return_value=None)
    redis.remove_active_room = AsyncMock(return_value=None)
    redis.publish_room_discovery_event = AsyncMock(return_value=None)
    return redis


# ---------------------------------------------------------------------
# 1. Native rooms missing upstream get dropped
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_drops_rooms_missing_upstream():
    # Two candidate native rooms; only the second is still live upstream.
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    stale = _make_room(farcaster_room_id="fc-stale", started_at=old)
    live = _make_room(farcaster_room_id="fc-live", started_at=old)

    session = _FakeSession([stale, live])
    spaces = _fake_spaces_with_live(["fc-live"])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 2, "dropped": 1, "errors": 0}

    # Stale row marked ended; live row untouched.
    assert stale.status == "ended"
    assert stale.ended_at is not None
    assert live.status == "active"
    assert live.ended_at is None

    # Redis cleanup happened only for the dropped room.
    redis.remove_active_room.assert_awaited_once_with(str(stale.id))


# ---------------------------------------------------------------------
# 2. Native rooms present upstream are kept
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_keeps_rooms_present_upstream():
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    a = _make_room(farcaster_room_id="fc-a", started_at=old)
    b = _make_room(farcaster_room_id="fc-b", started_at=old)
    session = _FakeSession([a, b])
    spaces = _fake_spaces_with_live(["fc-a", "fc-b"])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 2, "dropped": 0, "errors": 0}
    assert a.status == "active"
    assert b.status == "active"
    redis.remove_active_room.assert_not_awaited()


# ---------------------------------------------------------------------
# 2b. Per-room authoritative confirmation before dropping. A room absent
#     from the capped GLOBAL live index is NOT proof it ended — the
#     reconciler must confirm via get_room before killing it. This is the
#     durable bug: Juke-orchestrated rooms aren't reliably in the global
#     list, so they were being false-dropped after the grace window.
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_absent_but_live_per_room_is_not_dropped():
    """Absent from the global live list but get_room reports state='live'
    → a global-index gap, NOT an ended room. Must be left in place."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    gap = _make_room(farcaster_room_id="fc-gap", started_at=old)
    session = _FakeSession([gap])
    spaces = _fake_spaces_with_live(
        [],  # missing from the global list
        get_room_return=_make_upstream_audio_room("fc-gap", state="live"),
    )
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 0, "errors": 0}
    assert gap.status == "active"
    assert gap.ended_at is None
    # The authoritative per-room lookup ran exactly once for the absent room.
    spaces.get_room.assert_awaited_once_with("fc-gap")
    redis.remove_active_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_absent_and_scheduled_per_room_is_not_dropped():
    """Absent globally but get_room reports state='scheduled' → not gone."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    sched = _make_room(farcaster_room_id="fc-sched", started_at=old)
    session = _FakeSession([sched])
    spaces = _fake_spaces_with_live(
        [],
        get_room_return=_make_upstream_audio_room("fc-sched", state="scheduled"),
    )
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 0, "errors": 0}
    assert sched.status == "active"
    redis.remove_active_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_absent_and_per_room_404_is_dropped():
    """Absent globally AND get_room returns None (upstream 404) → truly
    gone → drop."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    gone = _make_room(farcaster_room_id="fc-gone", started_at=old)
    session = _FakeSession([gone])
    spaces = _fake_spaces_with_live([], get_room_return=None)
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 1, "errors": 0}
    assert gone.status == "ended"
    assert gone.ended_at is not None
    spaces.get_room.assert_awaited_once_with("fc-gone")
    redis.remove_active_room.assert_awaited_once_with(str(gone.id))


@pytest.mark.asyncio
async def test_absent_and_per_room_ended_is_dropped():
    """Absent globally AND get_room returns state='ended' → drop."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    ended = _make_room(farcaster_room_id="fc-ended", started_at=old)
    session = _FakeSession([ended])
    spaces = _fake_spaces_with_live(
        [],
        get_room_return=_make_upstream_audio_room("fc-ended", state="ended"),
    )
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 1, "errors": 0}
    assert ended.status == "ended"
    redis.remove_active_room.assert_awaited_once_with(str(ended.id))


@pytest.mark.asyncio
async def test_per_room_lookup_error_does_not_drop():
    """A get_room exception is ambiguous — treat as a transient blip and
    LEAVE the room in place (counted as an error), never risk killing a
    live space on a lookup failure."""
    import httpx

    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    room = _make_room(farcaster_room_id="fc-blip", started_at=old)
    session = _FakeSession([room])
    spaces = _fake_spaces_with_live(
        [],
        get_room_side_effect=httpx.ConnectError("per-room lookup down"),
    )
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 0, "errors": 1}
    assert room.status == "active"
    assert room.ended_at is None
    redis.remove_active_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_per_room_lookup_skipped_when_present_in_global_list():
    """Rooms present in the cheap global live list must NOT incur a
    per-room lookup — the fan-out is bounded to absent rooms only."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    live = _make_room(farcaster_room_id="fc-live", started_at=old)
    session = _FakeSession([live])
    spaces = _fake_spaces_with_live(["fc-live"])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 0, "errors": 0}
    spaces.get_room.assert_not_awaited()


# ---------------------------------------------------------------------
# 3. Rooms within the propagation grace window are NOT dropped
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_skips_rooms_within_grace_window():
    """The DB-side WHERE clause filters by ``started_at < cutoff`` so
    rows within the grace window never reach the candidate list. We
    simulate that by passing an empty candidate list when the only
    room would have been within the grace window."""
    just_now = datetime.now(tz=timezone.utc) - timedelta(seconds=30)
    young = _make_room(farcaster_room_id="fc-young", started_at=just_now)

    # Stub the candidates list as empty — the real WHERE would exclude
    # this room because started_at >= cutoff (now - 300s).
    session = _FakeSession([])
    spaces = _fake_spaces_with_live([])  # not in upstream — would normally drop
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=300.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 0, "dropped": 0, "errors": 0}
    # Young room left untouched.
    assert young.status == "active"
    redis.remove_active_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconcile_skips_future_scheduled_room_before_expiry_grace():
    """The DB predicate must not consider future scheduled mirrors."""
    future = _make_room(
        farcaster_room_id="fc-future",
        status="scheduled",
        scheduled_at=datetime.now(tz=timezone.utc) + timedelta(hours=1),
    )
    session = _FakeSession([])
    spaces = _fake_spaces_with_live([])
    redis = _fake_redis()
    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        scheduled_expiry_grace_seconds=1800,
    )

    counts = await reconciler.reconcile_once()

    assert counts == {"checked": 0, "dropped": 0, "errors": 0}
    assert future.status == "scheduled"
    spaces.get_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconcile_expires_past_scheduled_mirror_only_after_authoritative_404():
    scheduled = _make_room(
        farcaster_room_id="fc-orphan",
        status="scheduled",
        scheduled_at=datetime.now(tz=timezone.utc) - timedelta(hours=2),
    )
    session = _FakeSession([scheduled])
    spaces = _fake_spaces_with_live([], get_room_return=None)
    redis = _fake_redis()
    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        scheduled_expiry_grace_seconds=1800,
    )

    counts = await reconciler.reconcile_once()

    assert counts == {"checked": 1, "dropped": 1, "errors": 0}
    assert scheduled.status == "ended"
    spaces.get_room.assert_awaited_once_with("fc-orphan")


@pytest.mark.asyncio
async def test_reconcile_keeps_past_scheduled_mirror_when_upstream_still_scheduled():
    scheduled = _make_room(
        farcaster_room_id="fc-delayed",
        status="scheduled",
        scheduled_at=datetime.now(tz=timezone.utc) - timedelta(hours=2),
    )
    session = _FakeSession([scheduled])
    spaces = _fake_spaces_with_live(
        [], get_room_return=_make_upstream_audio_room("fc-delayed", "scheduled")
    )
    redis = _fake_redis()
    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )

    counts = await reconciler.reconcile_once()

    assert counts == {"checked": 1, "dropped": 0, "errors": 0}
    assert scheduled.status == "scheduled"


@pytest.mark.asyncio
async def test_reconcile_promotes_scheduled_mirror_when_upstream_is_live():
    scheduled = _make_room(
        farcaster_room_id="fc-live-now",
        status="scheduled",
        scheduled_at=datetime.now(tz=timezone.utc) - timedelta(hours=2),
    )
    started = datetime.now(tz=timezone.utc) - timedelta(minutes=3)
    session = _FakeSession([scheduled])
    spaces = _fake_spaces_with_live(["fc-live-now"])
    spaces.list_live_rooms.return_value = [
        _make_upstream_audio_room("fc-live-now", "live", started)
    ]
    redis = _fake_redis()
    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )

    counts = await reconciler.reconcile_once()

    assert counts == {"checked": 1, "dropped": 0, "errors": 0}
    assert scheduled.status == "active"
    assert scheduled.started_at == started
    redis.add_active_room.assert_awaited_once_with(
        str(scheduled.id), started.timestamp()
    )
    event = redis.publish_room_discovery_event.await_args.args[0]
    assert event["reason"] == "room_reconciled_live"
    assert event["status"] == "active"


# ---------------------------------------------------------------------
# 4. Upstream failure → counted error, never raised
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_handles_upstream_failure():
    import httpx

    session = _FakeSession([])
    spaces = AsyncMock()
    spaces.list_live_rooms = AsyncMock(side_effect=httpx.ConnectError("upstream down"))
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )

    # Must NOT raise — must instead return error-counted dict.
    counts = await reconciler.reconcile_once()
    assert counts["errors"] == 1
    assert counts["checked"] == 0
    assert counts["dropped"] == 0


# ---------------------------------------------------------------------
# 5. Unconfigured service → silent skip
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_skips_when_unconfigured():
    session = _FakeSession([])
    spaces = AsyncMock()
    spaces.list_live_rooms = AsyncMock(
        side_effect=FarcasterSpacesConfigError("service not configured")
    )
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )

    counts = await reconciler.reconcile_once()
    # Silent skip — no errors counted, no drops.
    assert counts == {"checked": 0, "dropped": 0, "errors": 0}


# ---------------------------------------------------------------------
# 6. Native row missing farcaster_room_id → error counted, room left alone
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_skips_native_row_without_upstream_id():
    """A native row that's missing its ``farcaster_room_id`` is a
    create-time bug — the reconciler can't decide whether the upstream
    is gone so it logs + counts the error and leaves the row alone."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    bad = _make_room(farcaster_room_id=None, started_at=old)
    session = _FakeSession([bad])
    spaces = _fake_spaces_with_live(["fc-something-else"])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )
    counts = await reconciler.reconcile_once()
    assert counts["errors"] == 1
    assert counts["dropped"] == 0
    assert bad.status == "active"
    redis.remove_active_room.assert_not_awaited()


# ---------------------------------------------------------------------
# 7. Redis failure during cleanup → still counts as dropped (the DB is
#    the source of truth; the registry will be reconciled on the next
#    pass).
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_swallows_redis_error_after_db_commit():
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    stale = _make_room(farcaster_room_id="fc-stale", started_at=old)
    session = _FakeSession([stale])
    spaces = _fake_spaces_with_live([])
    redis = AsyncMock()
    redis.remove_active_room = AsyncMock(side_effect=RuntimeError("redis"))
    redis.publish_room_discovery_event = AsyncMock(
        side_effect=RuntimeError("pubsub"),
    )

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )
    counts = await reconciler.reconcile_once()
    # Drop still counts because the DB committed first. Redis blip
    # gets swallowed at DEBUG level — same posture for the pub/sub call.
    assert counts == {"checked": 1, "dropped": 1, "errors": 0}
    assert stale.status == "ended"


@pytest.mark.asyncio
async def test_reconcile_publishes_discovery_event_on_drop():
    """When a room is dropped, the reconciler must publish a
    ``rooms_changed`` event on the discovery channel so connected
    clients refresh their rail immediately — matching the manual
    end-native-room handler's behavior."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    stale = _make_room(farcaster_room_id="fc-stale", started_at=old)
    session = _FakeSession([stale])
    spaces = _fake_spaces_with_live([])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )
    counts = await reconciler.reconcile_once()
    assert counts["dropped"] == 1
    # Discovery event published with the right shape.
    redis.publish_room_discovery_event.assert_awaited_once()
    event = redis.publish_room_discovery_event.await_args.args[0]
    assert event["type"] == "rooms_changed"
    assert event["reason"] == "room_reconciled"
    assert event["room_id"] == str(stale.id)
    assert event["status"] == "ended"


@pytest.mark.asyncio
async def test_reconcile_does_not_publish_when_no_drops():
    """When every native room is still live upstream there's nothing
    to drop, so we MUST NOT spam the discovery channel with no-op
    events."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    live = _make_room(farcaster_room_id="fc-live", started_at=old)
    session = _FakeSession([live])
    spaces = _fake_spaces_with_live(["fc-live"])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
    )
    counts = await reconciler.reconcile_once()
    assert counts["dropped"] == 0
    redis.publish_room_discovery_event.assert_not_awaited()


# ---------------------------------------------------------------------
# 7b. A stale native room WITH an active recording gets the recording
#     stopped BEFORE the row is flipped to ended. This is the orphaned-
#     recording fix: the reconciler is the only path that observes a
#     space ended from the Farcaster app, so it must finalize the agent.
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_stops_recording_before_dropping(monkeypatch):
    import app.services.livekit_service as livekit_mod
    import app.services.room_service as room_service_mod

    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    stale = _make_room(
        farcaster_room_id="fc-stale",
        started_at=old,
        recording=True,
        recording_id="rec-abc123",
    )
    session = _FakeSession([stale])
    spaces = _fake_spaces_with_live([])  # gone upstream → must drop
    redis = _fake_redis()

    # Stub LiveKitService so no real client is constructed.
    class _StubLiveKit:
        async def close(self) -> None:
            return None

    monkeypatch.setattr(livekit_mod, "LiveKitService", _StubLiveKit)

    # Capture the recording-stop call routed through RoomService.
    stop_mock = AsyncMock(return_value={"status": "stopped", "recording_url": "s3://x"})
    monkeypatch.setattr(
        room_service_mod.RoomService,
        "admin_stop_native_recording",
        stop_mock,
    )

    recording_agent = AsyncMock()
    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        recording_agent=recording_agent,
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 1, "errors": 0}

    # Recording was force-stopped with the system sentinel FID.
    stop_mock.assert_awaited_once()
    (called_room_id,) = stop_mock.await_args.args
    assert called_room_id == str(stale.id)
    assert stop_mock.await_args.kwargs["admin_fid"] == room_service_mod.SYSTEM_ACTOR_FID

    # And only then was the room flipped to ended.
    assert stale.status == "ended"


@pytest.mark.asyncio
async def test_reconcile_drops_recording_room_even_without_agent_wired(monkeypatch):
    """A recording room must still be dropped (not left lingering) when
    the recording-agent dispatcher isn't wired — we just can't finalize
    the file. The flag is left for a later manual admin clear."""
    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    stale = _make_room(
        farcaster_room_id="fc-stale",
        started_at=old,
        recording=True,
        recording_id="rec-abc123",
    )
    session = _FakeSession([stale])
    spaces = _fake_spaces_with_live([])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        recording_agent=None,  # not wired
        propagation_grace_seconds=60.0,
    )

    counts = await reconciler.reconcile_once()
    assert counts == {"checked": 1, "dropped": 1, "errors": 0}
    assert stale.status == "ended"


# ---------------------------------------------------------------------
# 8. Lifecycle — start + stop is idempotent and safe
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconciler_start_stop_is_idempotent():
    session = _FakeSession([])
    spaces = _fake_spaces_with_live([])
    redis = _fake_redis()

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        interval_seconds=0.05,
    )

    # Stop before start is a no-op.
    await reconciler.stop()

    await reconciler.start()
    first_task = reconciler._task
    # Re-start is a no-op while the task is alive.
    await reconciler.start()
    assert reconciler._task is first_task

    # Let the loop tick at least once.
    await asyncio.sleep(0.1)
    assert spaces.list_live_rooms.await_count >= 1

    await reconciler.stop()
    assert reconciler._task is None

    # Double-stop is a no-op.
    await reconciler.stop()


# ---------------------------------------------------------------------
# 9. Developer webhook dispatch — room.finished on native-room drop
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_webhook_dispatched_for_app_room(monkeypatch):
    """Dropping a native room whose ``created_by_app_id`` is set must
    dispatch ``room.finished`` with ``ended_via='upstream'``,
    ``ended_by_fid=None``, ``is_farcaster_native=True``, the upstream
    ``farcaster_room_id``, and the host_mode / farcaster_host_fid from
    the room's metadata_."""
    import app.services.native_rooms_reconciler as reconciler_mod

    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    app_id = uuid.uuid4()
    stale = _make_room(
        farcaster_room_id="fc-stale",
        started_at=old,
        created_by_app_id=app_id,
        metadata_={
            "source": "backend-orchestrated",
            "host_mode": "user_fid",
            "farcaster_host_fid": 12345,
        },
    )
    session = _FakeSession([stale])
    spaces = _fake_spaces_with_live([])  # gone upstream → must drop
    redis = _fake_redis()

    dispatch_mock = AsyncMock(return_value=None)
    monkeypatch.setattr(reconciler_mod, "dispatch_dev_webhook", dispatch_mock)

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )
    counts = await reconciler.reconcile_once()

    assert counts == {"checked": 1, "dropped": 1, "errors": 0}
    assert stale.status == "ended"

    dispatch_mock.assert_awaited_once()
    call_kwargs = dispatch_mock.await_args.kwargs
    assert call_kwargs["app_id"] == app_id
    assert call_kwargs["event_type"] == "room.finished"
    data = call_kwargs["data"]
    assert data["room_id"] == str(stale.id)
    assert data["host_fid"] == stale.host_fid
    assert data["ended_by_fid"] is None
    assert data["ended_via"] == "upstream"
    assert data["ended_at"] is not None
    # New fields — docs contract
    assert data["is_farcaster_native"] is True
    assert data["farcaster_room_id"] == "fc-stale"
    assert data["host_mode"] == "user_fid"
    assert data["farcaster_host_fid"] == 12345


@pytest.mark.asyncio
async def test_webhook_new_fields_null_for_legacy_rows(monkeypatch):
    """Legacy native rows whose metadata_ lacks host_mode / farcaster_host_fid
    (or where metadata_ is entirely None) must still produce a valid
    ``room.finished`` payload — those fields arrive as None, but
    ``is_farcaster_native`` is always True and ``farcaster_room_id`` is
    populated from the column directly."""
    import app.services.native_rooms_reconciler as reconciler_mod

    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    app_id = uuid.uuid4()

    # Legacy row: metadata_ present but no host_mode / farcaster_host_fid keys.
    legacy_partial = _make_room(
        farcaster_room_id="fc-legacy-partial",
        started_at=old,
        created_by_app_id=app_id,
        metadata_={"source": "backend-orchestrated"},  # no host_mode key
    )
    # Extreme legacy: metadata_ is None.
    legacy_none = _make_room(
        farcaster_room_id="fc-legacy-none",
        started_at=old,
        created_by_app_id=app_id,
        metadata_=None,
    )
    # Force metadata_ to None on the ORM object (the helper defaults to {}).
    legacy_none.metadata_ = None

    for stale in [legacy_partial, legacy_none]:
        session = _FakeSession([stale])
        spaces = _fake_spaces_with_live([])
        redis = _fake_redis()
        dispatch_mock = AsyncMock(return_value=None)
        monkeypatch.setattr(reconciler_mod, "dispatch_dev_webhook", dispatch_mock)

        reconciler = NativeRoomsReconciler(
            farcaster_spaces=spaces,
            redis=redis,
            session_maker=_session_maker_for(session),
            propagation_grace_seconds=60.0,
        )
        counts = await reconciler.reconcile_once()

        assert counts == {
            "checked": 1,
            "dropped": 1,
            "errors": 0,
        }, stale.farcaster_room_id
        dispatch_mock.assert_awaited_once()
        data = dispatch_mock.await_args.kwargs["data"]
        assert data["is_farcaster_native"] is True, stale.farcaster_room_id
        assert data["farcaster_room_id"] == stale.farcaster_room_id
        assert data["host_mode"] is None, stale.farcaster_room_id
        assert data["farcaster_host_fid"] is None, stale.farcaster_room_id


@pytest.mark.asyncio
async def test_no_webhook_without_app_id(monkeypatch):
    """A native room without ``created_by_app_id`` (iOS-created) must NOT
    trigger any developer webhook on drop."""
    import app.services.native_rooms_reconciler as reconciler_mod

    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    stale = _make_room(
        farcaster_room_id="fc-stale",
        started_at=old,
        created_by_app_id=None,
    )
    session = _FakeSession([stale])
    spaces = _fake_spaces_with_live([])
    redis = _fake_redis()

    dispatch_mock = AsyncMock(return_value=None)
    monkeypatch.setattr(reconciler_mod, "dispatch_dev_webhook", dispatch_mock)

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )
    counts = await reconciler.reconcile_once()

    assert counts == {"checked": 1, "dropped": 1, "errors": 0}
    assert stale.status == "ended"
    dispatch_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_webhook_failure_does_not_block_drop(monkeypatch):
    """A ``dispatch_dev_webhook`` exception must be swallowed — neither
    the row flip nor the processing of subsequent rooms in the same pass
    may be blocked."""
    import app.services.native_rooms_reconciler as reconciler_mod

    old = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    app_id = uuid.uuid4()
    room_a = _make_room(
        farcaster_room_id="fc-a",
        started_at=old,
        created_by_app_id=app_id,
    )
    room_b = _make_room(
        farcaster_room_id="fc-b",
        started_at=old,
        created_by_app_id=app_id,
    )
    session = _FakeSession([room_a, room_b])
    spaces = _fake_spaces_with_live([])  # both gone upstream
    redis = _fake_redis()

    # First call raises; second must still fire and both rows must be ended.
    dispatch_mock = AsyncMock(side_effect=[RuntimeError("webhook down"), None])
    monkeypatch.setattr(reconciler_mod, "dispatch_dev_webhook", dispatch_mock)

    reconciler = NativeRoomsReconciler(
        farcaster_spaces=spaces,
        redis=redis,
        session_maker=_session_maker_for(session),
        propagation_grace_seconds=60.0,
    )
    counts = await reconciler.reconcile_once()

    # Both rooms dropped despite the first dispatch raising.
    assert counts == {"checked": 2, "dropped": 2, "errors": 0}
    assert room_a.status == "ended"
    assert room_b.status == "ended"
    assert dispatch_mock.await_count == 2
