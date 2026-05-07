import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.config import settings
from app.models.room import Room
from app.models.user import User
from app.services.room_service import RoomService


class _ScalarOne:
    def __init__(self, value):
        self.value = value

    def scalar_one(self):
        return self.value


def _room(*, status: str = "active", cast_hash: str | None = None) -> Room:
    return Room(
        id=uuid.uuid4(),
        title="Long space",
        host_fid=100,
        status=status,
        started_at=datetime.now(timezone.utc),
        cast_hash=cast_hash,
        recording=False,
        allow_agents=True,
    )


def _host() -> User:
    return User(
        fid=100,
        signer_uuid=str(uuid.uuid4()),
        username="alice",
        display_name="Alice",
        pfp_url=None,
        custody_address=None,
    )


def _service(room: Room) -> RoomService:
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_ScalarOne(room))
    db.commit = AsyncMock()
    db.refresh = AsyncMock()

    redis = AsyncMock()
    livekit = AsyncMock()
    return RoomService(db, redis, livekit)


@pytest.mark.asyncio
async def test_ensure_chat_target_is_idempotent_for_existing_cast(monkeypatch):
    room = _room(cast_hash="0xabc123")
    service = _service(room)
    service._get_room_or_404 = AsyncMock(return_value=room)
    service._get_participant_or_403 = AsyncMock(return_value={"role": "listener"})
    service._get_user = AsyncMock(return_value=_host())
    service._get_live_counts = AsyncMock(return_value=(2, 8))
    service._create_system_chat_cast = AsyncMock()

    response = await service.ensure_chat_target(str(room.id), fid=200)

    assert response.cast_hash == "0xabc123"
    service._create_system_chat_cast.assert_not_called()


@pytest.mark.asyncio
async def test_ensure_chat_target_creates_and_stores_system_cast(monkeypatch):
    room = _room()
    service = _service(room)
    service._get_room_or_404 = AsyncMock(return_value=room)
    service._get_participant_or_403 = AsyncMock(return_value={"role": "listener"})
    service._get_user = AsyncMock(return_value=_host())
    service._get_live_counts = AsyncMock(return_value=(1, 4))
    service._create_system_chat_cast = AsyncMock(return_value="0xfeed")
    service._register_cast_webhook = AsyncMock(return_value=("wh_123", "secret"))
    monkeypatch.setattr(settings, "JUKEAUDIO_SIGNER_UUID", str(uuid.uuid4()))

    response = await service.ensure_chat_target(str(room.id), fid=200)

    assert response.cast_hash == "0xfeed"
    assert room.cast_hash == "0xfeed"
    assert room.neynar_webhook_id == "wh_123"
    assert room.neynar_webhook_secret == "secret"
    service.db.commit.assert_called_once()
    service.db.refresh.assert_called_once_with(room)


@pytest.mark.asyncio
async def test_ensure_chat_target_rejects_non_active_room():
    room = _room(status="ended")
    service = _service(room)
    service._get_room_or_404 = AsyncMock(return_value=room)

    with pytest.raises(HTTPException) as exc:
        await service.ensure_chat_target(str(room.id), fid=200)

    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_ensure_chat_target_missing_system_signer_does_not_store(monkeypatch):
    room = _room()
    service = _service(room)
    service._get_room_or_404 = AsyncMock(return_value=room)
    service._get_participant_or_403 = AsyncMock(return_value={"role": "listener"})
    service._get_user = AsyncMock(return_value=_host())
    monkeypatch.setattr(settings, "JUKEAUDIO_SIGNER_UUID", "")

    with pytest.raises(HTTPException) as exc:
        await service.ensure_chat_target(str(room.id), fid=200)

    assert exc.value.status_code == 503
    assert room.cast_hash is None
    service.db.commit.assert_not_called()
