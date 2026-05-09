from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from app.routers.feed import BOOKMARK_RATE_LIMIT_PER_MIN, MAX_BOOKMARKS_PER_USER
from app.services.cast_bookmark_service import annotate_bookmarked_casts


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


class _FakeNeynarClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, _url, **_kwargs):
        return _FakeResponse(
            {
                "casts": [
                    {
                        "hash": "0x" + "a" * 40,
                        "author": {"fid": 1},
                        "text": "bookmarked",
                        "viewer_context": {"liked": True},
                    },
                    {
                        "hash": "0x" + "b" * 40,
                        "author": {"fid": 2},
                        "text": "not bookmarked",
                    },
                ],
                "next": {"cursor": None},
            }
        )


class _SpamService:
    async def annotate_casts(self, _casts):
        return None


def _mock_db(bookmarked: list[str] | None = None):
    scalar_result = MagicMock()
    scalar_result.scalars.return_value.all.return_value = bookmarked or []
    scalar_result.scalar_one.return_value = 0
    scalar_result.scalar_one_or_none.return_value = None
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()
    return db


@pytest.fixture
def bookmark_overrides():
    db = _mock_db(["0x" + "a" * 40])

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
async def test_bookmark_create_and_delete_are_idempotent(client, bookmark_overrides):
    cast_hash = "0x" + "c" * 40

    first_create = await client.post(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )
    second_create = await client.post(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )
    first_delete = await client.delete(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )
    second_delete = await client.delete(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )

    assert first_create.status_code == 201
    assert second_create.status_code == 201
    assert first_delete.status_code == 200
    assert second_delete.status_code == 200
    assert bookmark_overrides.commit.await_count == 4


@pytest.mark.asyncio
async def test_bookmark_write_rate_limit_returns_429(client, bookmark_overrides):
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.expire = MagicMock()
    pipe.execute = AsyncMock(return_value=[BOOKMARK_RATE_LIMIT_PER_MIN + 1, True])
    app.state.redis.pipeline = MagicMock(return_value=pipe)

    response = await client.post(
        f"/v1/feed/bookmarks/{'0x' + 'f' * 40}",
        headers=make_auth_header(),
    )

    assert response.status_code == 429


@pytest.mark.asyncio
async def test_bookmark_capacity_limit_returns_429(client):
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = None
    scalar_result.scalar_one.return_value = MAX_BOOKMARKS_PER_USER
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        response = await client.post(
            f"/v1/feed/bookmarks/{'0x' + '1' * 40}",
            headers=make_auth_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)

    assert response.status_code == 429
    assert db.commit.await_count == 0


@pytest.mark.asyncio
async def test_following_feed_adds_bookmarked_viewer_context(client, bookmark_overrides):
    with patch("app.routers.feed.httpx.AsyncClient", return_value=_FakeNeynarClient()):
        response = await client.get("/v1/feed/following", headers=make_auth_header())

    assert response.status_code == 200
    casts = response.json()["casts"]
    assert casts[0]["viewer_context"] == {"liked": True, "bookmarked": True}
    assert casts[1]["viewer_context"] == {"bookmarked": False}


@pytest.mark.asyncio
async def test_bookmark_annotation_handles_thread_replies():
    root_hash = "0x" + "d" * 40
    reply_hash = "0x" + "e" * 40
    db = _mock_db([reply_hash])
    payload = {
        "conversation": {
            "cast": {
                "hash": root_hash,
                "author": {"fid": 1},
                "text": "root",
                "direct_replies": [
                    {
                        "hash": reply_hash,
                        "author": {"fid": 2},
                        "text": "reply",
                    }
                ],
            }
        }
    }

    await annotate_bookmarked_casts(db, 12345, payload)

    root = payload["conversation"]["cast"]
    reply = root["direct_replies"][0]
    assert root["viewer_context"] == {"bookmarked": False}
    assert reply["viewer_context"] == {"bookmarked": True}
