"""H1: partner-minted JWTs on ``/leave`` and ``/token`` are confined to a
listener seat in a room created by the minting partner app; first-party
behaviour is unchanged."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from jose import jwt

from app.config import settings
from app.main import app
from app.routers.participants import get_room_service
from app.schemas.participant import TokenRefreshResponse
from app.services.auth_service import create_partner_jwt

ROOM_ID = "room-partner-scope"
FID = 9001
PARTNER_APP_ID = uuid.uuid4()


class _FakeRedis:
    def __init__(self, participants: dict[int, dict]):
        self.participants = participants

    async def get_participant(self, room_id: str, fid: int) -> dict | None:
        assert room_id == ROOM_ID
        return self.participants.get(fid)


class _FakeRoomService:
    def __init__(
        self, participants: dict[int, dict], created_by_app_id: uuid.UUID | None
    ):
        self.redis = _FakeRedis(participants)
        self.room = SimpleNamespace(created_by_app_id=created_by_app_id)
        self.left: list[tuple[str, int]] = []
        self.refreshed: list[tuple[str, int]] = []

    async def _get_room_or_404(self, room_id: str):
        if room_id != ROOM_ID:
            raise HTTPException(status_code=404, detail="Room not found")
        return self.room

    async def leave_room(self, *, room_id: str, fid: int) -> None:
        self.left.append((room_id, fid))

    async def refresh_token(self, *, room_id: str, fid: int) -> TokenRefreshResponse:
        self.refreshed.append((room_id, fid))
        return TokenRefreshResponse(livekit_token="lk", expires_at="2030-01-01")


@pytest.fixture
def install_service():
    def _install(
        participants: dict[int, dict],
        created_by_app_id: uuid.UUID | None = PARTNER_APP_ID,
    ) -> _FakeRoomService:
        service = _FakeRoomService(participants, created_by_app_id)

        async def _override():
            yield service

        app.dependency_overrides[get_room_service] = _override
        return service

    yield _install
    app.dependency_overrides.pop(get_room_service, None)


def _partner_headers(
    fid: int = FID, partner_app_id: uuid.UUID = PARTNER_APP_ID
) -> dict[str, str]:
    token, _ = create_partner_jwt(
        fid=fid, partner_app_id=str(partner_app_id), ttl_seconds=300
    )
    return {"Authorization": f"Bearer {token}"}


def _first_party_headers(fid: int = FID) -> dict[str, str]:
    exp = int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())
    token = jwt.encode(
        {"fid": fid, "exp": exp}, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM
    )
    return {"Authorization": f"Bearer {token}"}


def _calls(service: _FakeRoomService, action: str) -> list[tuple[str, int]]:
    return service.left if action == "leave" else service.refreshed


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["leave", "token"])
async def test_partner_listener_can_leave_and_refresh(client, install_service, action):
    service = install_service({FID: {"role": "listener"}})
    response = await client.post(
        f"/v1/rooms/{ROOM_ID}/{action}", headers=_partner_headers()
    )
    assert response.status_code == 200, response.text
    assert _calls(service, action) == [(ROOM_ID, FID)]


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["leave", "token"])
@pytest.mark.parametrize("role", ["host", "co_host", "speaker", None])
async def test_partner_refused_outside_listener_seat(
    client, install_service, action, role
):
    participants = {FID: {"role": role}} if role else {}
    service = install_service(participants)
    response = await client.post(
        f"/v1/rooms/{ROOM_ID}/{action}", headers=_partner_headers()
    )
    assert response.status_code == 403, response.text
    assert service.left == []
    assert service.refreshed == []


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["leave", "token"])
@pytest.mark.parametrize(
    "room_app_id",
    [uuid.uuid4(), None],
    ids=["other_app_room", "first_party_room"],
)
async def test_partner_refused_in_rooms_of_other_apps(
    client, install_service, action, room_app_id
):
    """One partner app can't refresh or drop a listener in another app's
    (or a first-party) room."""
    service = install_service({FID: {"role": "listener"}}, room_app_id)
    response = await client.post(
        f"/v1/rooms/{ROOM_ID}/{action}", headers=_partner_headers()
    )
    assert response.status_code == 403, response.text
    assert service.left == []
    assert service.refreshed == []


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["leave", "token"])
@pytest.mark.parametrize("role", ["host", "speaker"])
async def test_first_party_unchanged(client, install_service, action, role):
    service = install_service({FID: {"role": role}}, None)
    response = await client.post(
        f"/v1/rooms/{ROOM_ID}/{action}", headers=_first_party_headers()
    )
    assert response.status_code == 200, response.text
    assert _calls(service, action) == [(ROOM_ID, FID)]
