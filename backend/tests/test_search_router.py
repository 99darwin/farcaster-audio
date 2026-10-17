"""Tests for the /v1/search/* router (casts + miniapps)."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from tests.hypersnap_fake import V2, fake_hypersnap, reactions_by_fid  # noqa: F401


def make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


class _FakeResponse:
    def __init__(self, data: object, status_code: int = 200, json_error=None):
        self.status_code = status_code
        self._data = data
        self._json_error = json_error
        self.text = str(data)
        self.request = SimpleNamespace(url=SimpleNamespace(path="/mock"))

    def json(self):
        if self._json_error is not None:
            raise self._json_error
        return self._data


class _FakeNeynarClient:
    """Minimal stand-in for httpx.AsyncClient that lets each test inject
    routes keyed by URL substring."""

    def __init__(self, routes: dict[str, _FakeResponse | Exception]):
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
                if isinstance(response, Exception):
                    raise response
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
async def test_plain_query_returns_hydrated_casts(
    client, search_overrides, fake_hypersnap
):
    bare_hash = "a" * 40
    fake_hypersnap.route(
        f"{V2}/cast/search",
        {
            "result": {
                "casts": [{"hash": bare_hash, "author": {"fid": 99}}],
                "next": {"cursor": "page-2"},
            }
        },
    )
    fake_hypersnap.route(
        "/v1/reactionsByFid",
        lambda params: reactions_by_fid(
            ["0x" + bare_hash] if params["reaction_type"] == "Recast" else []
        ),
    )
    response = await client.get(
        "/v1/search/casts?q=juke+audio&sort=popular",
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["casts"] == [
        {
            "hash": "0x" + bare_hash,
            "author": {"fid": 99},
            "viewer_context": {
                "liked": False,
                "recasted": True,
                "bookmarked": False,
            },
        }
    ]
    assert body["next"] == {"cursor": "page-2"}
    assert body["meta"]["unknown_author"] is False
    assert body["meta"]["parsed"]["author_username"] is None
    assert body["meta"]["parsed"]["text"] == "juke audio"

    # Hypersnap has no viewer_fid and no sort_type; neither is forwarded.
    cast_call = fake_hypersnap.calls_to(f"{V2}/cast/search")[0]
    assert cast_call.params == {"q": "juke audio", "limit": "20"}
    assert len(search_overrides.annotated) == 1
    assert [c["hash"] for c in search_overrides.annotated[0]] == ["0x" + bare_hash]


@pytest.mark.asyncio
async def test_from_operator_resolves_and_forwards_author_fid(
    client, search_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        f"{V2}/user/by-username", {"user": {"fid": 3, "username": "dwr"}}
    )
    fake_hypersnap.route(
        f"{V2}/cast/search", {"result": {"casts": [], "next": {"cursor": None}}}
    )
    response = await client.get(
        "/v1/search/casts?q=from%3Adwr+hello",
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["unknown_author"] is False
    assert body["meta"]["parsed"]["author_username"] == "dwr"

    # Path moved from Neynar's user/by_username to Hypersnap's by-username.
    user_call = fake_hypersnap.calls_to(f"{V2}/user/by-username")[0]
    assert user_call.params == {"username": "dwr"}
    cast_call = fake_hypersnap.calls_to(f"{V2}/cast/search")[0]
    assert cast_call.params["author_fid"] == "3"
    assert cast_call.params["q"] == "hello"


@pytest.mark.asyncio
async def test_unknown_author_returns_empty_with_meta_flag(
    client, search_overrides, fake_hypersnap
):
    fake_hypersnap.route(f"{V2}/user/by-username", (404, {"message": "nope"}))
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
    assert fake_hypersnap.calls_to(f"{V2}/cast/search") == []


@pytest.mark.asyncio
async def test_sort_recent_is_accepted_but_not_forwarded(
    client, search_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        f"{V2}/cast/search", {"result": {"casts": [], "next": {"cursor": None}}}
    )
    response = await client.get(
        "/v1/search/casts?q=hello&sort=recent",
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    cast_call = fake_hypersnap.calls_to(f"{V2}/cast/search")[0]
    assert "sort_type" not in cast_call.params


@pytest.mark.asyncio
async def test_cast_search_upstream_5xx_maps_to_502(
    client, search_overrides, fake_hypersnap
):
    fake_hypersnap.route(f"{V2}/cast/search", (503, {"message": "down"}))
    response = await client.get("/v1/search/casts?q=hello", headers=make_auth_header())

    assert response.status_code == 502
    assert response.json() == {"detail": "Upstream service error"}


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
                            "title": "Legacy title",
                            "image": "https://example.com/base-preview.png",
                            "frames_url": "https://example.com/base",
                            "author": {"fid": 1, "username": "v"},
                            "manifest": {
                                "miniapp": {
                                    "name": "Base App",
                                    "description": "Build on Base",
                                    "icon_url": "https://example.com/base.png",
                                }
                            },
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
            "description": "Build on Base",
            "image_url": "https://example.com/base-preview.png",
            "frames_url": "https://example.com/base",
            "author": {"fid": 1, "username": "v"},
            "metrics": None,
            "rank": None,
        }
    ]
    assert body["next"] == {"cursor": "next-page"}
    assert body["meta"] == {
        "source": "neynar",
        "metrics_available": False,
        "unsupported": False,
    }
    search_call = fake.get_calls[0]
    assert search_call["url"].endswith("/farcaster/frame/search/")


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
        "meta": {
            "source": "fallback",
            "metrics_available": False,
            "unsupported": True,
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        "unexpected",
        {"result": None},
        {"result": []},
        {"frames": None, "next": []},
        {"frames": "not-a-list", "next": "not-an-object"},
    ],
)
async def test_miniapp_search_unexpected_payload_shapes_degrade_safely(
    client, search_overrides, payload
):
    fake = _FakeNeynarClient({"/farcaster/frame/search/": _FakeResponse(payload)})
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps?q=base",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["frames"] == []
    assert body["next"] == {"cursor": None}
    assert body["meta"]["metrics_available"] is False
    assert body["meta"]["source"] == (
        "neynar" if isinstance(payload, dict) else "fallback"
    )


@pytest.mark.asyncio
async def test_miniapp_search_invalid_json_and_network_error_degrade_safely(
    client, search_overrides
):
    invalid_json = _FakeNeynarClient(
        {
            "/farcaster/frame/search/": _FakeResponse(
                {}, json_error=ValueError("invalid json")
            )
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=invalid_json):
        invalid_response = await client.get(
            "/v1/search/miniapps?q=base", headers=make_auth_header()
        )

    timeout = _FakeNeynarClient(
        {"/farcaster/frame/search/": httpx.ReadTimeout("timeout")}
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=timeout):
        timeout_response = await client.get(
            "/v1/search/miniapps?q=base", headers=make_auth_header()
        )

    assert invalid_response.status_code == 200
    assert timeout_response.status_code == 200
    assert invalid_response.json()["meta"]["source"] == "fallback"
    assert timeout_response.json()["meta"]["source"] == "fallback"


@pytest.mark.asyncio
async def test_miniapp_search_filters_non_https_and_malformed_urls(
    client, search_overrides
):
    fake = _FakeNeynarClient(
        {
            "/farcaster/frame/search/": _FakeResponse(
                {
                    "frames": [
                        {"name": "HTTP", "frames_url": "http://example.com/app"},
                        {"name": "JS", "frames_url": "javascript:alert(1)"},
                        {
                            "name": "Credentials",
                            "frames_url": "https://user:pass@example.com/app",
                        },
                        {"name": "Malformed", "frames_url": "https://[bad"},
                        {
                            "name": "Safe",
                            "frames_url": "https://safe.example/app",
                            "image_url": "http://safe.example/icon.png",
                        },
                    ]
                }
            )
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps?q=safe", headers=make_auth_header()
        )

    assert response.status_code == 200
    assert response.json()["frames"] == [
        {
            "name": "Safe",
            "description": None,
            "image_url": None,
            "frames_url": "https://safe.example/app",
            "author": None,
            "metrics": None,
            "rank": None,
        }
    ]


@pytest.mark.asyncio
async def test_miniapp_search_truncates_to_neynar_query_limit(client, search_overrides):
    fake = _FakeNeynarClient(
        {"/farcaster/frame/search/": _FakeResponse({"frames": []})}
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            f"/v1/search/miniapps?q={'x' * 100}", headers=make_auth_header()
        )

    assert response.status_code == 200
    assert fake.get_calls[0]["params"]["q"] == "x" * 32


# ---------------------------------------------------------------------------
# /v1/search/miniapps/discover
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_miniapp_discovery_uses_catalog_and_fixed_contract(
    client, search_overrides
):
    fake = _FakeNeynarClient(
        {
            "/farcaster/frame/catalog/": _FakeResponse(
                {
                    "frames": [
                        {
                            "frames_url": "https://one.example/play",
                            "image": "https://one.example/cover.png",
                            "manifest": {
                                "miniapp": {
                                    "name": "One",
                                    "description": "First in catalog order",
                                }
                            },
                            "author": {"fid": 1, "username": "one"},
                        },
                        {
                            "frames_url": "https://two.example/play",
                            "title": "Two",
                            "metrics": {"opens": 42},
                            "rank": 7,
                        },
                    ],
                    "next": {"cursor": "catalog-page-2"},
                }
            )
        }
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps/discover?limit=2&cursor=page-1",
            headers=make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "frames": [
            {
                "name": "One",
                "description": "First in catalog order",
                "image_url": "https://one.example/cover.png",
                "frames_url": "https://one.example/play",
                "author": {"fid": 1, "username": "one"},
                "metrics": None,
                "rank": None,
            },
            {
                "name": "Two",
                "description": None,
                "image_url": None,
                "frames_url": "https://two.example/play",
                "author": None,
                "metrics": {"opens": 42},
                "rank": 7,
            },
        ],
        "next": {"cursor": "catalog-page-2"},
        "meta": {
            "source": "neynar",
            "metrics_available": True,
            "unsupported": False,
        },
    }
    catalog_call = fake.get_calls[0]
    assert catalog_call["params"] == {
        "limit": 2,
        "time_window": "7d",
        "cursor": "page-1",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [400, 403, 404, 405, 410, 422])
async def test_miniapp_discovery_unsupported_statuses_return_typed_empty(
    client, search_overrides, status_code
):
    fake = _FakeNeynarClient(
        {"/farcaster/frame/catalog/": _FakeResponse({}, status_code=status_code)}
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps/discover", headers=make_auth_header()
        )

    assert response.status_code == 200
    assert response.json() == {
        "frames": [],
        "next": {"cursor": None},
        "meta": {
            "source": "fallback",
            "metrics_available": False,
            "unsupported": True,
        },
    }


@pytest.mark.asyncio
async def test_miniapp_discovery_preserves_upstream_rate_limit(
    client, search_overrides
):
    fake = _FakeNeynarClient(
        {"/farcaster/frame/catalog/": _FakeResponse({}, status_code=429)}
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps/discover", headers=make_auth_header()
        )

    assert response.status_code == 429
    assert response.json() == {"detail": "Upstream service error"}


@pytest.mark.asyncio
async def test_miniapp_upstream_401_does_not_log_out_the_user(client, search_overrides):
    fake = _FakeNeynarClient(
        {"/farcaster/frame/search/": _FakeResponse({}, status_code=401)}
    )
    with patch("app.routers.search.httpx.AsyncClient", return_value=fake):
        response = await client.get(
            "/v1/search/miniapps?q=base", headers=make_auth_header()
        )

    assert response.status_code == 200
    assert response.json()["meta"] == {
        "source": "fallback",
        "metrics_available": False,
        "unsupported": False,
    }
