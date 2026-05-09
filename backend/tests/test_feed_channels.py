from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app


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
    def __init__(self):
        self.get_calls: list[dict] = []
        self.post_calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, **kwargs):
        self.get_calls.append({"url": url, **kwargs})
        if url.endswith("/farcaster/channel/search"):
            return _FakeResponse(
                {
                    "channels": [
                        {
                            "id": "base",
                            "name": "Base",
                            "description": "Base builders",
                            "image_url": "https://example.com/base.png",
                            "follower_count": 12345,
                        }
                    ]
                }
            )
        return _FakeResponse({"casts": [{"hash": "0xabc"}], "next": {"cursor": "next"}})

    async def post(self, url, **kwargs):
        self.post_calls.append({"url": url, **kwargs})
        return _FakeResponse({"cast": {"hash": "0xdef"}})


def _mock_db_returning_signer(
    signer_uuid: str = "12345678-1234-4234-9234-123456789abc",
):
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none = MagicMock(return_value=signer_uuid)
    scalar_result.scalars.return_value.all.return_value = []
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()
    return db


async def _override_db():
    yield _mock_db_returning_signer()


class _SpamService:
    def __init__(self):
        self.annotated = []

    async def annotate_casts(self, casts):
        self.annotated.append(casts)


@pytest.fixture
def feed_overrides():
    spam = _SpamService()
    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: spam
    try:
        yield spam
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


@pytest.mark.asyncio
async def test_channel_feed_proxies_neynar_channel_ids(client, feed_overrides):
    fake = _FakeNeynarClient()
    with patch("app.routers.feed.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/feed/channel/neynar?limit=10&cursor=abc",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    assert fake.get_calls[0]["url"].endswith("/farcaster/feed/channels")
    assert fake.get_calls[0]["params"] == {
        "channel_ids": "neynar",
        "limit": 10,
        "viewer_fid": 12345,
        "cursor": "abc",
    }
    assert feed_overrides.annotated == [[{"hash": "0xabc"}]]


@pytest.mark.asyncio
async def test_channel_search_proxies_neynar_channel_search(client, feed_overrides):
    fake = _FakeNeynarClient()
    with patch("app.routers.feed.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/feed/channels/search?q=ba&limit=8",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    assert fake.get_calls[0]["url"].endswith("/farcaster/channel/search")
    assert fake.get_calls[0]["params"] == {"q": "ba", "limit": 8}
    assert response.json() == {
        "channels": [
            {
                "id": "base",
                "name": "Base",
                "description": "Base builders",
                "image_url": "https://example.com/base.png",
                "follower_count": 12345,
            }
        ]
    }


@pytest.mark.asyncio
async def test_create_cast_sends_channel_id_for_top_level_cast(client, feed_overrides):
    fake = _FakeNeynarClient()
    with patch("app.routers.feed.httpx.AsyncClient", return_value=fake):
        response = await client.post(
            "/v1/feed/cast",
            json={"text": "gm", "channel_id": "neynar"},
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    assert fake.post_calls[0]["json"]["channel_id"] == "neynar"
    assert "parent" not in fake.post_calls[0]["json"]


@pytest.mark.asyncio
async def test_create_cast_rejects_reply_with_channel_id(client, feed_overrides):
    fake = _FakeNeynarClient()
    with patch("app.routers.feed.httpx.AsyncClient", return_value=fake):
        response = await client.post(
            "/v1/feed/cast",
            json={
                "text": "reply",
                "parent": "0x" + "a" * 40,
                "channel_id": "neynar",
            },
            headers=make_auth_header(),
        )

    assert response.status_code == 400
    assert fake.post_calls == []


@pytest.mark.asyncio
async def test_create_quote_cast_can_target_channel(client, feed_overrides):
    fake = _FakeNeynarClient()
    with patch("app.routers.feed.httpx.AsyncClient", return_value=fake):
        response = await client.post(
            "/v1/feed/cast",
            json={
                "text": "quoted",
                "channel_id": "neynar",
                "quote": {"fid": 3, "hash": "0x" + "b" * 40},
            },
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    payload = fake.post_calls[0]["json"]
    assert payload["channel_id"] == "neynar"
    assert payload["embeds"] == [{"cast_id": {"fid": 3, "hash": "0x" + "b" * 40}}]
