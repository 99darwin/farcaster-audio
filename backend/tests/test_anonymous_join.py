import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.routers.participants import _enforce_anonymous_join_rate_limit
from app.routers.webhooks import _handle_participant_left
from app.services.livekit_service import (
    ANONYMOUS_LISTENER_TOKEN_TTL,
    LiveKitService,
)
from app.services.room_service import RoomService


class _FakePipeline:
    def __init__(self, execute_results=None):
        self.calls = []
        self.execute_results = execute_results or []

    def incr(self, key):
        self.calls.append(("incr", key))
        return self

    def expire(self, key, ttl):
        self.calls.append(("expire", key, ttl))
        return self

    def zremrangebyscore(self, key, min_score, max_score):
        self.calls.append(("zremrangebyscore", key, min_score, max_score))
        return self

    def zadd(self, key, mapping):
        self.calls.append(("zadd", key, mapping))
        return self

    def zcard(self, key):
        self.calls.append(("zcard", key))
        return self

    async def execute(self):
        return self.execute_results


class _FakeRawRedis:
    def __init__(self, execute_results):
        self.pipelines = [_FakePipeline(results) for results in execute_results]

    def pipeline(self):
        return self.pipelines.pop(0)


def _room(status="active"):
    return SimpleNamespace(
        id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
        title="Live room",
        host_fid=123,
        status=status,
        started_at=datetime.now(tz=timezone.utc),
        ended_at=None,
        scheduled_at=None,
        recording=False,
        cast_hash=None,
        allow_agents=True,
    )


def _host():
    return SimpleNamespace(
        fid=123,
        username="host",
        display_name="Host",
        pfp_url=None,
        custody_address=None,
    )


def _service(*, room_status="active", anonymous_count=1):
    redis = MagicMock()
    redis.redis = _FakeRawRedis([[], [0, anonymous_count]])
    redis.get_all_participants = AsyncMock(
        return_value=[
            {
                "fid": 123,
                "role": "host",
                "is_muted": False,
                "hand_raised": False,
                "display_name": "Host",
            },
            {
                "fid": 456,
                "role": "listener",
                "is_muted": True,
                "hand_raised": False,
                "display_name": "Named Listener",
            },
        ]
    )

    livekit = MagicMock()
    livekit.generate_anonymous_listener_token.return_value = "anon-token"

    service = RoomService(db=MagicMock(), redis=redis, livekit=livekit)
    service._get_room_or_404 = AsyncMock(return_value=_room(status=room_status))
    service._get_user = AsyncMock(return_value=_host())
    return service


@pytest.mark.asyncio
async def test_anonymous_join_returns_listen_only_shape_without_named_leakage():
    service = _service(anonymous_count=1)

    response = await service.join_room_anonymously(
        room_id="00000000-0000-0000-0000-000000000001",
        session_id="session-hash",
    )

    assert response.livekit_token == "anon-token"
    assert response.livekit_ws_url
    assert response.role == "listener"
    assert response.room.listener_count == 2
    assert [participant.fid for participant in response.participants] == [123, 456]
    assert all(
        participant.display_name != "Anonymous listener"
        for participant in response.participants
    )
    service.livekit.generate_anonymous_listener_token.assert_called_once_with(
        room_id="00000000-0000-0000-0000-000000000001",
        session_id="session-hash",
    )


@pytest.mark.asyncio
async def test_anonymous_join_requires_active_room():
    service = _service(room_status="ended")

    with pytest.raises(HTTPException) as exc:
        await service.join_room_anonymously(
            room_id="00000000-0000-0000-0000-000000000001",
            session_id="session-hash",
        )

    assert exc.value.status_code == 400
    service.livekit.generate_anonymous_listener_token.assert_not_called()


def test_anonymous_livekit_token_uses_subscribe_only_grant(monkeypatch):
    captured = {}

    class _Token:
        def __init__(self, api_key, api_secret):
            captured["api_key"] = api_key
            captured["api_secret"] = api_secret

        def with_identity(self, identity):
            captured["identity"] = identity
            return self

        def with_name(self, name):
            captured["name"] = name
            return self

        def with_metadata(self, metadata):
            captured["metadata"] = metadata
            return self

        def with_ttl(self, ttl):
            captured["ttl"] = ttl
            return self

        def with_grants(self, grant):
            captured["grant"] = grant
            return self

        def to_jwt(self):
            return "jwt"

    class _VideoGrants:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    monkeypatch.setattr("app.services.livekit_service.api.AccessToken", _Token)
    monkeypatch.setattr("app.services.livekit_service.api.VideoGrants", _VideoGrants)

    token = LiveKitService().generate_anonymous_listener_token(
        room_id="room-1",
        session_id="session-hash",
    )

    assert token == "jwt"
    assert captured["identity"] == "anon:session-hash"
    assert captured["name"] == "Anonymous listener"
    assert captured["ttl"] == ANONYMOUS_LISTENER_TOKEN_TTL
    assert captured["grant"].kwargs == {
        "room_join": True,
        "room": "room-1",
        "can_publish": False,
        "can_subscribe": True,
        "can_publish_data": False,
    }


@pytest.mark.asyncio
async def test_anonymous_join_rate_limit_returns_429():
    pipeline = _FakePipeline([1, True, 31, True])
    redis = MagicMock()
    redis.pipeline.return_value = pipeline
    request = SimpleNamespace(
        client=SimpleNamespace(host="203.0.113.10"),
        headers={"x-juke-session-id": "browser-session"},
    )

    with pytest.raises(HTTPException) as exc:
        await _enforce_anonymous_join_rate_limit(request, redis)

    assert exc.value.status_code == 429
    assert [call[0] for call in pipeline.calls].count("incr") == 2


@pytest.mark.asyncio
async def test_anonymous_livekit_leave_removes_anonymous_listener_only():
    redis_service = MagicMock()
    redis_service.remove_anonymous_listener = AsyncMock()
    redis_service.remove_participant = AsyncMock()
    db = AsyncMock()
    event = SimpleNamespace(
        room=SimpleNamespace(name="room-1"),
        participant=SimpleNamespace(identity="anon:session-hash"),
    )

    await _handle_participant_left(event, db, redis_service)

    redis_service.remove_anonymous_listener.assert_awaited_once_with(
        "room-1", "session-hash"
    )
    redis_service.remove_participant.assert_not_awaited()
    db.execute.assert_not_awaited()
