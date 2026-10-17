from datetime import datetime, timedelta, timezone

from app.routers.spaces_discovery import _future_scheduled_rooms
from app.schemas.farcaster_spaces import AudioRoom, SpaceUser


def _room(room_id: str, scheduled_at: datetime | None) -> AudioRoom:
    return AudioRoom(
        id=room_id,
        host=SpaceUser(fid=1, username="host"),
        state="scheduled",
        scheduled_at=scheduled_at,
    )


def test_future_scheduled_filter_removes_past_schema_rows():
    now = datetime.now(tz=timezone.utc)

    result = _future_scheduled_rooms(
        [
            _room("past", now - timedelta(seconds=1)),
            _room("future", now + timedelta(hours=1)),
            _room("unknown", None),
        ]
    )

    assert [room.id for room in result] == ["future"]


def test_future_scheduled_filter_cleans_legacy_cached_dict_payloads():
    now = datetime.now(tz=timezone.utc)

    result = _future_scheduled_rooms(
        [
            {"id": "past", "scheduled_at": (now - timedelta(days=1)).isoformat()},
            {"id": "future", "scheduledAt": (now + timedelta(days=1)).isoformat()},
            {"id": "invalid", "scheduled_at": "not-a-date"},
        ]
    )

    assert [room["id"] for room in result] == ["future"]
