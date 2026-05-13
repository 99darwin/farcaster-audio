"""Tests for the /v1/search/* router (casts + miniapps)."""

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
    """Minimal stand-in for httpx.AsyncClient that lets each test inject
    routes keyed by URL substring."""

    def __init__(self, routes: dict[str, _FakeResponse]):
        self.routes = routes
        self.get_calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, **kwargs):
        self.get_calls.append({"url": url, **kwargs})
        for key, response in self.routes.items():
            if key in url:
                return response
        # Default — empty cast list, matches Neynar's shape.
        return _FakeResponse({"result": {"casts": [], "next": {"cursor": None}}})


def _mock_db_session():
    """A DB that returns no bookmarks and no blocked fids."""
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none = MagicMock(return_value=None)
    scalar_result.scalars.return_value.all.return_value = []
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()
    return db


async def _override_db():
    yield _mock_db_session()


class _SpamService:
    def __init__(self):
        self.annotated: list = []

    async def annotate_casts(self, casts):
        self.annotated.append(casts)


@pytest.fixture
def search_overrides():
    spam = _SpamService()
    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: spam
    try:
        yield spam
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


# ---------------------------------------------------------------------------
# /v1/search/casts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_plain_query_returns_hydrated_casts(client, search_overrides):
    fake = _FakeNeynarClient(
        {
            "/farcaster/cast/search": _FakeResponse(
                {
                    "result": {
                        "casts": [{"hash": "0xabc", "author": {"fid": 99}}],
                        "next": {"cursor": "page-2"},
                    }
                }
            ),
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/casts?q=juke+audio&sort=popular",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["casts"] == [
        {
            "hash": "0xabc",
            "author": {"fid": 99},
            "viewer_context": {"bookmarked": False},
        }
    ]
    assert body["next"] == {"cursor": "page-2"}
    assert body["meta"]["unknown_author"] is False
    assert body["meta"]["parsed"]["author_username"] is None
    assert body["meta"]["parsed"]["text"] == "juke audio"

    # Verify the upstream call carried the expected params.
    cast_call = next(
        c for c in fake.get_calls if "/farcaster/cast/search" in c["url"]
    )
    assert cast_call["params"]["q"] == "juke audio"
    assert cast_call["params"]["viewer_fid"] == 12345
    assert cast_call["params"]["sort_type"] == "algorithmic"
    assert "author_fid" not in cast_call["params"]
    # SpamService gets the cast list by reference before later hydration
    # mutates it in place. Assert by hash to avoid coupling to mutation order.
    assert len(search_overrides.annotated) == 1
    assert [c["hash"] for c in search_overrides.annotated[0]] == ["0xabc"]


@pytest.mark.asyncio
async def test_from_operator_resolves_and_forwards_author_fid(
    client, search_overrides
):
    fake = _FakeNeynarClient(
        {
            "/farcaster/user/by_username": _FakeResponse(
                {"user": {"fid": 3, "username": "dwr"}}
            ),
            "/farcaster/cast/search": _FakeResponse(
                {"result": {"casts": [], "next": {"cursor": None}}}
            ),
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/casts?q=from%3Adwr+hello",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["unknown_author"] is False
    assert body["meta"]["parsed"]["author_username"] == "dwr"

    # First call resolves user, second call hits cast/search with author_fid.
    user_call = next(
        c for c in fake.get_calls if "/farcaster/user/by_username" in c["url"]
    )
    assert user_call["params"]["username"] == "dwr"
    assert user_call["params"]["viewer_fid"] == 12345

    cast_call = next(
        c for c in fake.get_calls if "/farcaster/cast/search" in c["url"]
    )
    assert cast_call["params"]["author_fid"] == 3
    assert cast_call["params"]["q"] == "hello"


@pytest.mark.asyncio
async def test_unknown_author_returns_empty_with_meta_flag(client, search_overrides):
    fake = _FakeNeynarClient(
        {
            "/farcaster/user/by_username": _FakeResponse({}, status_code=404),
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/casts?q=from%3Anobody123",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["casts"] == []
    assert body["next"] == {"cursor": None}
    assert body["meta"]["unknown_author"] is True
    assert body["meta"]["parsed"]["author_username"] == "nobody123"
    # cast/search should NOT have been called when the author is unknown.
    assert all(
        "/farcaster/cast/search" not in c["url"] for c in fake.get_calls
    )


@pytest.mark.asyncio
async def test_sort_recent_forwards_desc_chron(client, search_overrides):
    fake = _FakeNeynarClient(
        {
            "/farcaster/cast/search": _FakeResponse(
                {"result": {"casts": [], "next": {"cursor": None}}}
            ),
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/casts?q=hello&sort=recent",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    cast_call = next(
        c for c in fake.get_calls if "/farcaster/cast/search" in c["url"]
    )
    assert cast_call["params"]["sort_type"] == "desc_chron"


# ---------------------------------------------------------------------------
# /v1/search/miniapps
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_miniapp_search_passthrough(client, search_overrides):
    fake = _FakeNeynarClient(
        {
            "/farcaster/frame/search": _FakeResponse(
                {
                    "frames": [
                        {
                            "name": "Base App",
                            "image_url": "https://example.com/base.png",
                            "frames_url": "https://example.com/base",
                            "author": {"fid": 1, "username": "v"},
                        }
                    ],
                    "next": {"cursor": "next-page"},
                }
            ),
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps?q=base",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["frames"] == [
        {
            "name": "Base App",
            "image_url": "https://example.com/base.png",
            "frames_url": "https://example.com/base",
            "author": {"fid": 1, "username": "v"},
        }
    ]
    assert body["next"] == {"cursor": "next-page"}
    assert body["meta"]["unsupported"] is False


@pytest.mark.asyncio
async def test_miniapp_search_404_returns_unsupported(client, search_overrides):
    fake = _FakeNeynarClient(
        {
            "/farcaster/frame/search": _FakeResponse({}, status_code=404),
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps?q=base",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "frames": [],
        "next": {"cursor": None},
        "meta": {"unsupported": True},
    }
