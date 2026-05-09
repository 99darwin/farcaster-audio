from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from app.services.room_service import RoomService


def make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


class _FakeResponse:
    def __init__(self, data: dict, status_code: int = 200):
        self.status_code = status_code
        self._data = data
        self.text = str(data)
        self.request = SimpleNamespace(url=SimpleNamespace(path="/mock"))

    def json(self):
        return self._data


class _FakeFeedClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, _url, **_kwargs):
        return _FakeResponse(
            {
                "casts": [
                    {"hash": "0x1", "author": {"fid": 1}, "text": "visible"},
                    {"hash": "0x2", "author": {"fid": 2}, "text": "blocked"},
                ],
                "next": {"cursor": None},
            }
        )


class _FakeUserClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, _url, **_kwargs):
        return _FakeResponse(
            {
                "users": [
                    {
                        "fid": 2,
                        "username": "blocked",
                        "display_name": "Blocked",
                        "viewer_context": {"following": False},
                    }
                ]
            }
        )


class _SpamService:
    async def annotate_casts(self, _casts):
        return None


def _result(*, scalars=None, scalar_one_or_none=None):
    result = MagicMock()
    result.scalars.return_value.all.return_value = scalars or []
    result.scalar_one_or_none.return_value = scalar_one_or_none
    return result


@pytest.fixture
def db_override():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result())
    db.commit = AsyncMock()

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


@pytest.mark.asyncio
async def test_block_and_unblock_are_idempotent(client, db_override):
    first_block = await client.post("/v1/users/2/block", headers=make_auth_header())
    second_block = await client.post("/v1/users/2/block", headers=make_auth_header())
    first_unblock = await client.delete("/v1/users/2/block", headers=make_auth_header())
    second_unblock = await client.delete(
        "/v1/users/2/block", headers=make_auth_header()
    )

    assert first_block.status_code == 201
    assert second_block.status_code == 201
    assert first_unblock.status_code == 200
    assert second_unblock.status_code == 200
    assert db_override.commit.await_count == 4


@pytest.mark.asyncio
async def test_self_block_returns_400(client, db_override):
    response = await client.post("/v1/users/12345/block", headers=make_auth_header())

    assert response.status_code == 400
    assert db_override.commit.await_count == 0


@pytest.mark.asyncio
async def test_get_user_includes_blocked_viewer_context(client, db_override):
    db_override.execute = AsyncMock(return_value=_result(scalar_one_or_none=99))

    with patch("app.routers.users.httpx.AsyncClient", return_value=_FakeUserClient()):
        response = await client.get("/v1/users/2", headers=make_auth_header())

    assert response.status_code == 200
    assert response.json()["user"]["viewer_context"]["blocked"] is True


@pytest.mark.asyncio
async def test_following_feed_filters_blocked_authors(client, db_override):
    db_override.execute = AsyncMock(return_value=_result(scalars=[2]))

    with patch("app.routers.feed.httpx.AsyncClient", return_value=_FakeFeedClient()):
        response = await client.get("/v1/feed/following", headers=make_auth_header())

    assert response.status_code == 200
    casts = response.json()["casts"]
    assert [cast["author"]["fid"] for cast in casts] == [1]


@pytest.mark.asyncio
async def test_blocked_user_cannot_join_blocker_hosted_room():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result(scalar_one_or_none=1))
    service = RoomService(db=db, redis=MagicMock(), livekit=MagicMock())
    service._get_room_or_404 = AsyncMock(
        return_value=SimpleNamespace(status="active", host_fid=12345)
    )

    with pytest.raises(Exception) as exc:
        await service.join_room(room_id="00000000-0000-0000-0000-000000000001", fid=2)

    assert getattr(exc.value, "status_code", None) == 403


@pytest.mark.asyncio
async def test_blocked_user_cannot_rsvp_to_blocker_hosted_room():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result(scalar_one_or_none=1))
    db.commit = AsyncMock()
    service = RoomService(db=db, redis=MagicMock(), livekit=MagicMock())
    service._get_room_or_404 = AsyncMock(
        return_value=SimpleNamespace(status="scheduled", host_fid=12345)
    )

    with pytest.raises(Exception) as exc:
        await service.register_rsvp(
            room_id="00000000-0000-0000-0000-000000000001",
            fid=2,
        )

    assert getattr(exc.value, "status_code", None) == 403
    assert db.commit.await_count == 0
