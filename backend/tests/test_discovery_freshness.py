"""
Discovery-freshness regressions (fix/space-discovery-freshness).

Two bugs, both about the "Live now" rail lagging reality:

  1. Listener counts on space cards only refreshed on the 30s poll because
     join/leave never emitted a discovery event — only the per-room channel.
     Fix: a throttled ``participants_changed`` discovery ping on join/leave.

  2. A room that emptied out (last participant leaves → auto-end) lingered as
     "live" until the poll because the auto-end branch never emitted
     ``room_ended`` on the discovery channel. Fix: emit it inline.

These exercise ``RoomService`` with mocked collaborators — no DB/Redis/LiveKit.
"""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.redis_service import RedisService
from app.services.room_service import RoomService

ROOM_ID = "00000000-0000-0000-0000-000000000001"


def _room(status="active"):
    return SimpleNamespace(
        id=uuid.UUID(ROOM_ID),
        title="Live room",
        host_fid=123,
        status=status,
        started_at=datetime.now(tz=timezone.utc),
        ended_at=None,
        scheduled_at=None,
        recording=False,
        cast_hash=None,
        allow_agents=True,
        farcaster_room_id=None,
        is_farcaster_native=False,
    )


def _leave_service(*, remaining_after_leave: int):
    """RoomService wired for ``leave_room`` with mocked collaborators."""
    redis = MagicMock()
    redis.remove_participant = AsyncMock()
    redis.remove_from_hand_queue = AsyncMock()
    redis.clear_user_active_room = AsyncMock()
    redis.publish_room_event = AsyncMock()
    redis.publish_room_discovery_event = AsyncMock()
    redis.clear_room_state = AsyncMock()
    redis.get_participant_count = AsyncMock(return_value=remaining_after_leave)
    redis.try_mark_participants_event = AsyncMock(return_value=True)

    db = MagicMock()
    db.execute = AsyncMock(
        return_value=SimpleNamespace(scalar_one_or_none=lambda: None)
    )
    db.commit = AsyncMock()

    service = RoomService(db=db, redis=redis, livekit=MagicMock())
    service._get_room_or_404 = AsyncMock(return_value=_room())
    return service, redis


# ---------------------------------------------------------------------------
# Bug 2 — emptied room drains immediately
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_leave_room_auto_end_emits_room_ended_discovery_event():
    service, redis = _leave_service(remaining_after_leave=0)

    await service.leave_room(room_id=ROOM_ID, fid=456)

    redis.clear_room_state.assert_awaited_once()
    redis.publish_room_discovery_event.assert_awaited_once()
    event = redis.publish_room_discovery_event.await_args.args[0]
    assert event["reason"] == "room_ended"
    assert event["status"] == "ended"
    assert event["room_id"] == ROOM_ID
    # An auto-ended room must NOT also emit a participants_changed ping.
    redis.try_mark_participants_event.assert_not_awaited()


# ---------------------------------------------------------------------------
# Bug 1 — listener count refreshes on leave/join without waiting for the poll
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_leave_room_still_live_emits_participants_changed():
    service, redis = _leave_service(remaining_after_leave=2)

    await service.leave_room(room_id=ROOM_ID, fid=456)

    # Still-live room: throttled participants_changed ping, no room_ended.
    redis.try_mark_participants_event.assert_awaited_once_with(ROOM_ID)
    redis.publish_room_discovery_event.assert_awaited_once()
    event = redis.publish_room_discovery_event.await_args.args[0]
    assert event["reason"] == "participants_changed"
    redis.clear_room_state.assert_not_awaited()


@pytest.mark.asyncio
async def test_publish_participants_changed_respects_throttle():
    redis = MagicMock()
    redis.try_mark_participants_event = AsyncMock(return_value=False)
    redis.publish_room_discovery_event = AsyncMock()
    service = RoomService(db=MagicMock(), redis=redis, livekit=MagicMock())

    await service._publish_participants_changed(ROOM_ID)

    # Throttle denied the slot → no discovery event this window.
    redis.publish_room_discovery_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_publish_participants_changed_never_raises_on_pubsub_failure():
    redis = MagicMock()
    redis.try_mark_participants_event = AsyncMock(return_value=True)
    redis.publish_room_discovery_event = AsyncMock(side_effect=RuntimeError("down"))
    service = RoomService(db=MagicMock(), redis=redis, livekit=MagicMock())

    # Best-effort: a pubsub hiccup must not fail the join/leave.
    await service._publish_participants_changed(ROOM_ID)


# ---------------------------------------------------------------------------
# Throttle primitive — leading-edge, one emit per window per room
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_try_mark_participants_event_is_leading_edge():
    raw = MagicMock()
    # First SET NX succeeds (key absent); subsequent ones return None.
    raw.set = AsyncMock(side_effect=[True, None, None])
    redis = RedisService(raw)

    assert await redis.try_mark_participants_event(ROOM_ID) is True
    assert await redis.try_mark_participants_event(ROOM_ID) is False
    assert await redis.try_mark_participants_event(ROOM_ID) is False

    # Uses SET NX EX so the slot self-expires — bounded event rate per room.
    first_call = raw.set.await_args_list[0]
    assert first_call.kwargs.get("nx") is True
    assert (
        first_call.kwargs.get("ex") == RedisService.PARTICIPANTS_EVENT_THROTTLE_SECONDS
    )
