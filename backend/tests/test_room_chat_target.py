import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.config import settings
from app.models.room import Room
from app.models.user import User
from app.services.room_service import RoomService
from tests.hypersnap_write_fakes import (
    install_system_signer,
    install_write_fakes,
    submit_error,
)

BRAND_FID = 999


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
        is_farcaster_native=False,
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
    service._sync_room_reply_webhook = MagicMock()
    install_system_signer(monkeypatch, brand_fid=BRAND_FID)

    response = await service.ensure_chat_target(str(room.id), fid=200)

    assert response.cast_hash == "0xfeed"
    assert room.cast_hash == "0xfeed"
    service._sync_room_reply_webhook.assert_called_once_with()
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
    monkeypatch.setattr(settings, "BRAND_FID", None)

    with pytest.raises(HTTPException) as exc:
        await service.ensure_chat_target(str(room.id), fid=200)

    assert exc.value.status_code == 503
    assert room.cast_hash is None
    service.db.commit.assert_not_called()


@pytest.mark.asyncio
async def test_system_chat_cast_is_signed_by_brand_and_mentions_host(monkeypatch):
    install_system_signer(monkeypatch, brand_fid=BRAND_FID)
    fakes = install_write_fakes(monkeypatch)
    room = _room()
    service = _service(room)

    cast_hash = await service._create_system_chat_cast(
        str(room.id), room.title, _host()
    )

    assert cast_hash == fakes.node.hashes[0]
    data = fakes.node.bodies[0]
    assert data.fid == BRAND_FID
    assert list(data.cast_add_body.mentions) == [100]
    assert "@alice" not in data.cast_add_body.text
    assert [e.url for e in data.cast_add_body.embeds] == [
        f"https://juke.audio/space/{room.id}"
    ]
    # The host's FID is already known: no username lookup upstream.
    assert fakes.reads.calls == []


@pytest.mark.asyncio
async def test_system_chat_cast_failure_is_502(monkeypatch):
    install_system_signer(monkeypatch, brand_fid=BRAND_FID)
    fakes = install_write_fakes(monkeypatch)
    fakes.node.errors = [submit_error(503)]
    room = _room()
    service = _service(room)

    with pytest.raises(HTTPException) as exc:
        await service._create_system_chat_cast(str(room.id), room.title, _host())

    assert exc.value.status_code == 502


@pytest.mark.asyncio
async def test_announce_room_signs_with_host_signer_and_records(monkeypatch):
    fakes = install_write_fakes(monkeypatch)
    recorded = AsyncMock()
    monkeypatch.setattr("app.services.room_service.record_cast", recorded)
    room = _room()
    service = _service(room)

    cast_hash = await service._announce_room(str(room.id), "Big space", _host())

    assert cast_hash == fakes.node.hashes[0]
    data = fakes.node.bodies[0]
    assert data.fid == 100
    assert data.cast_add_body.text == "Live now: Big space\n\nListen on Juke"
    assert [e.url for e in data.cast_add_body.embeds] == ["https://juke.audio"]
    recorded.assert_awaited_once()
    assert recorded.await_args.kwargs["source"] == "room_announcement"
    assert recorded.await_args.kwargs["cast_hash"] == cast_hash


@pytest.mark.asyncio
async def test_announce_room_without_linked_signer_is_best_effort(monkeypatch):
    fakes = install_write_fakes(monkeypatch, linked_fids=set())
    recorded = AsyncMock()
    monkeypatch.setattr("app.services.room_service.record_cast", recorded)
    room = _room()
    service = _service(room)

    cast_hash = await service._announce_room_scheduled(
        str(room.id), "Later", _host(), "tomorrow"
    )

    assert cast_hash is None
    assert fakes.node.attempts == 0
    recorded.assert_not_awaited()
