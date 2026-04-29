"""Tests for the GIF proxy router.

We mock httpx.AsyncClient so the upstream Giphy call never actually fires.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from jose import jwt

from app.config import settings


def _make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int(
                (datetime.now(timezone.utc) + timedelta(hours=72)).timestamp()
            ),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _giphy_payload(*, offset: int = 0, count: int = 1, total: int = 100) -> dict:
    return {
        "data": [
            {
                "id": "abc",
                "images": {
                    "original": {
                        "url": "https://media.giphy.com/abc.gif",
                        "width": "480",
                        "height": "270",
                    },
                    "fixed_width": {
                        "url": "https://media.giphy.com/abc-fw.gif",
                        "width": "200",
                        "height": "112",
                    },
                },
            }
        ],
        "pagination": {"offset": offset, "count": count, "total_count": total},
    }


def _stub_rate_limit_pass():
    """Configure the shared mock redis so rate-limit incr returns 1.

    The conftest mock_redis exposes ``incr`` as a generic AsyncMock attribute
    which returns another AsyncMock — ``count > N`` then explodes. Each gif
    test that exercises a happy path through the router calls this first.
    """
    from app.main import app

    app.state.redis.incr = AsyncMock(return_value=1)
    app.state.redis.expire = AsyncMock()


def _patch_httpx(payload: dict | None = None, status: int = 200):
    """Return (patch_target_class, captured_get_mock).

    Wire in via `patch("app.routers.gifs.httpx.AsyncClient", client_cls)`.
    """
    response = MagicMock()
    response.status_code = status
    response.text = "" if payload is None else "{...}"
    response.json = MagicMock(return_value=payload or {})

    get_mock = AsyncMock(return_value=response)

    client = AsyncMock()
    client.get = get_mock
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    client_cls = MagicMock(return_value=client)
    return client_cls, get_mock


def _forwarded_query(get_mock) -> dict:
    """Pull the query params off the URL the router actually called."""
    forwarded_url = get_mock.call_args.args[0]
    parsed = urlparse(forwarded_url)
    return {k: v[0] for k, v in parse_qs(parsed.query).items()}


@pytest.mark.asyncio
async def test_search_returns_transformed_shape(client, monkeypatch):
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")
    _stub_rate_limit_pass()

    client_cls, get_mock = _patch_httpx(_giphy_payload(offset=0, count=24, total=100))
    with patch("app.routers.gifs.httpx.AsyncClient", client_cls):
        response = await client.get(
            "/v1/gifs/search",
            params={"q": "cat"},
            headers=_make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["next_offset"] == 24
    assert len(body["results"]) == 1
    item = body["results"][0]
    assert item == {
        "id": "abc",
        "gifUrl": "https://media.giphy.com/abc.gif",
        "previewUrl": "https://media.giphy.com/abc-fw.gif",
        "width": 480,
        "height": 270,
    }

    # Confirm we forwarded the right query params (and api_key was not logged).
    get_mock.assert_awaited_once()
    forwarded_url = get_mock.call_args.args[0]
    forwarded_query = _forwarded_query(get_mock)
    assert "/search?" in forwarded_url
    assert forwarded_query["q"] == "cat"
    assert forwarded_query["api_key"] == "test-key"
    assert forwarded_query["rating"] == "pg-13"


@pytest.mark.asyncio
async def test_trending_returns_transformed_shape(client, monkeypatch):
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")
    _stub_rate_limit_pass()

    client_cls, get_mock = _patch_httpx(
        _giphy_payload(offset=24, count=24, total=40)
    )
    with patch("app.routers.gifs.httpx.AsyncClient", client_cls):
        response = await client.get(
            "/v1/gifs/trending",
            params={"offset": 24},
            headers=_make_auth_header(),
        )

    assert response.status_code == 200
    body = response.json()
    # offset(24) + count(24) = 48 >= total(40) → no more pages.
    assert body["next_offset"] is None
    assert len(body["results"]) == 1

    forwarded_url = get_mock.call_args.args[0]
    assert "/trending?" in forwarded_url


@pytest.mark.asyncio
async def test_search_requires_auth(client, monkeypatch):
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")
    response = await client.get("/v1/gifs/search", params={"q": "cat"})
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_trending_requires_auth(client, monkeypatch):
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")
    response = await client.get("/v1/gifs/trending")
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_giphy_500_returns_502(client, monkeypatch):
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")
    _stub_rate_limit_pass()

    client_cls, _ = _patch_httpx(payload={"error": "boom"}, status=500)
    with patch("app.routers.gifs.httpx.AsyncClient", client_cls):
        response = await client.get(
            "/v1/gifs/search",
            params={"q": "cat"},
            headers=_make_auth_header(),
        )

    assert response.status_code == 502
    body = response.json()
    # Generic message — must not leak Giphy's response body.
    assert "boom" not in str(body)


@pytest.mark.asyncio
async def test_empty_api_key_returns_503(client, monkeypatch):
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "")
    _stub_rate_limit_pass()

    response = await client.get(
        "/v1/gifs/search",
        params={"q": "cat"},
        headers=_make_auth_header(),
    )
    assert response.status_code == 503


# ---------------------------------------------------------------------------
# HIGH #1 — api_key must NOT be a live local at any frame that re-raises.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_api_key_not_in_locals_when_httpx_raises(client, monkeypatch):
    """When the upstream call blows up, no frame in the propagated traceback
    may carry ``api_key`` (or any value equal to GIPHY_API_KEY) as a local.

    This is the regression test for the Sentry frame-local capture leak.
    """
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "leak-canary-key")
    _stub_rate_limit_pass()

    # Build an httpx client mock that raises on .get() so we hit the
    # _GiphyUpstreamError -> sanitized 502 path.
    client_obj = AsyncMock()
    client_obj.get = AsyncMock(side_effect=httpx.ConnectTimeout("boom"))
    client_obj.__aenter__ = AsyncMock(return_value=client_obj)
    client_obj.__aexit__ = AsyncMock(return_value=False)
    client_cls = MagicMock(return_value=client_obj)

    captured: dict = {}

    # Wrap _safe_fetch_giphy so we can inspect the traceback frames at the
    # point _GiphyUpstreamError escaped — i.e. the exact frames that Sentry
    # would serialize via include_local_variables. The spy itself MUST NOT
    # bind api_key in its locals; we deliberately give it the same signature
    # as the real ``_fetch_giphy`` (path, query — no api_key parameter).
    import app.routers.gifs as gifs_module

    original_fetch = gifs_module._fetch_giphy

    def _walk_frames(exc):
        """Collect frames from the exception itself plus any chained
        ``__context__`` / ``__cause__`` so we cover anything Sentry might
        serialize."""
        frames: list = []
        seen: set[int] = set()
        stack = [exc]
        while stack:
            cur = stack.pop()
            if cur is None or id(cur) in seen:
                continue
            seen.add(id(cur))
            tb = cur.__traceback__
            while tb is not None:
                frames.append(tb.tb_frame)
                tb = tb.tb_next
            stack.append(cur.__context__)
            stack.append(cur.__cause__)
        return frames

    async def spy_fetch(path, query):
        try:
            return await original_fetch(path, query)
        except gifs_module._GiphyUpstreamError as exc:
            captured["frames"] = _walk_frames(exc)
            captured["exc"] = exc
            raise

    monkeypatch.setattr(gifs_module, "_fetch_giphy", spy_fetch)

    with patch("app.routers.gifs.httpx.AsyncClient", client_cls):
        response = await client.get(
            "/v1/gifs/search",
            params={"q": "cat"},
            headers=_make_auth_header(),
        )

    assert response.status_code == 502
    assert "frames" in captured, "spy never observed _GiphyUpstreamError"

    # Walk every frame, every local: the api_key must not appear in any
    # form Sentry would serialize — exact value, dict entry, or substring
    # of a URL/query string.
    canary = "leak-canary-key"
    for frame in captured["frames"]:
        for name, value in frame.f_locals.items():
            assert value != canary, (
                f"api_key leaked into frame local {frame.f_code.co_name}.{name}"
            )
            if isinstance(value, dict):
                assert "api_key" not in value, (
                    f"api_key leaked into dict local "
                    f"{frame.f_code.co_name}.{name}"
                )
                for v in value.values():
                    assert canary not in str(v), (
                        f"api_key value leaked into dict local "
                        f"{frame.f_code.co_name}.{name}"
                    )
            elif isinstance(value, str):
                assert canary not in value, (
                    f"api_key leaked into string local "
                    f"{frame.f_code.co_name}.{name}"
                )


# ---------------------------------------------------------------------------
# MEDIUM #2 — per-FID rate limit on /v1/gifs/{search,trending}.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rate_limit_returns_429_after_threshold(client, monkeypatch):
    """Once the per-FID counter exceeds the cap, the next call gets 429."""
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")

    from app.routers import gifs as gifs_module

    # Simulate the redis bucket already being above the limit.
    over_limit = gifs_module.GIFS_RATE_LIMIT_PER_MIN + 1
    # Override redis.incr to return over-limit count.
    from app.main import app

    app.state.redis.incr = AsyncMock(return_value=over_limit)
    app.state.redis.expire = AsyncMock()

    client_cls, _ = _patch_httpx(_giphy_payload())
    with patch("app.routers.gifs.httpx.AsyncClient", client_cls):
        response = await client.get(
            "/v1/gifs/search",
            params={"q": "cat"},
            headers=_make_auth_header(fid=42),
        )

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == str(
        gifs_module.GIFS_RATE_LIMIT_WINDOW_SEC
    )


@pytest.mark.asyncio
async def test_rate_limit_is_per_fid(client, monkeypatch):
    """Two distinct FIDs hit independent buckets."""
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")

    from app.main import app
    from app.routers import gifs as gifs_module

    seen_keys: list[str] = []

    async def fake_incr(key: str):
        seen_keys.append(key)
        # Always return 1 — first hit in each bucket, well below the cap.
        return 1

    app.state.redis.incr = fake_incr
    app.state.redis.expire = AsyncMock()

    client_cls, _ = _patch_httpx(_giphy_payload())
    with patch("app.routers.gifs.httpx.AsyncClient", client_cls):
        r1 = await client.get(
            "/v1/gifs/search",
            params={"q": "cat"},
            headers=_make_auth_header(fid=111),
        )
        r2 = await client.get(
            "/v1/gifs/search",
            params={"q": "cat"},
            headers=_make_auth_header(fid=222),
        )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert seen_keys == ["gifs:rl:111", "gifs:rl:222"]
    assert gifs_module.GIFS_RATE_LIMIT_PER_MIN > 0  # sanity


@pytest.mark.asyncio
async def test_rate_limit_shared_between_search_and_trending(client, monkeypatch):
    """search and trending tap the same bucket so a client can't bypass via
    the alternate endpoint."""
    monkeypatch.setattr(settings, "GIPHY_API_KEY", "test-key")

    from app.main import app

    seen_keys: list[str] = []

    async def fake_incr(key: str):
        seen_keys.append(key)
        return 1

    app.state.redis.incr = fake_incr
    app.state.redis.expire = AsyncMock()

    client_cls, _ = _patch_httpx(_giphy_payload())
    with patch("app.routers.gifs.httpx.AsyncClient", client_cls):
        await client.get(
            "/v1/gifs/search",
            params={"q": "cat"},
            headers=_make_auth_header(fid=99),
        )
        await client.get(
            "/v1/gifs/trending",
            headers=_make_auth_header(fid=99),
        )

    assert seen_keys == ["gifs:rl:99", "gifs:rl:99"]


# ---------------------------------------------------------------------------
# MEDIUM #3 — non-Giphy URLs in upstream payload must be dropped.
# ---------------------------------------------------------------------------


def test_transform_drops_non_giphy_gif_url():
    """A GIF whose original.url is not on giphy.com is excluded from results."""
    from app.routers.gifs import _transform_giphy_response

    payload = {
        "data": [
            {
                "id": "evil",
                "images": {
                    "original": {
                        "url": "https://example.com/evil.gif",
                        "width": "480",
                        "height": "270",
                    },
                    "fixed_width": {
                        "url": "https://media.giphy.com/evil-fw.gif",
                        "width": "200",
                        "height": "112",
                    },
                },
            },
            {
                "id": "good",
                "images": {
                    "original": {
                        "url": "https://media.giphy.com/good.gif",
                        "width": "480",
                        "height": "270",
                    },
                    "fixed_width": {
                        "url": "https://media.giphy.com/good-fw.gif",
                        "width": "200",
                        "height": "112",
                    },
                },
            },
        ],
        "pagination": {"offset": 0, "count": 2, "total_count": 2},
    }
    out = _transform_giphy_response(payload)
    ids = [r.id for r in out.results]
    assert "evil" not in ids
    assert "good" in ids


def test_transform_drops_non_https_url():
    """An http:// URL on giphy.com is still dropped — we require TLS."""
    from app.routers.gifs import _transform_giphy_response

    payload = {
        "data": [
            {
                "id": "insecure",
                "images": {
                    "original": {
                        "url": "http://media.giphy.com/x.gif",
                        "width": "1",
                        "height": "1",
                    },
                    "fixed_width": {
                        "url": "http://media.giphy.com/x-fw.gif",
                        "width": "1",
                        "height": "1",
                    },
                },
            }
        ],
        "pagination": {"offset": 0, "count": 1, "total_count": 1},
    }
    out = _transform_giphy_response(payload)
    assert out.results == []


def test_transform_drops_when_preview_url_is_attacker_controlled():
    """If gifUrl is fine but previewUrl is not on giphy.com, drop the GIF."""
    from app.routers.gifs import _transform_giphy_response

    payload = {
        "data": [
            {
                "id": "split",
                "images": {
                    "original": {
                        "url": "https://media.giphy.com/legit.gif",
                        "width": "1",
                        "height": "1",
                    },
                    "fixed_width": {
                        "url": "https://evil.com/preview.gif",
                        "width": "1",
                        "height": "1",
                    },
                },
            }
        ],
        "pagination": {"offset": 0, "count": 1, "total_count": 1},
    }
    out = _transform_giphy_response(payload)
    assert out.results == []


def test_transform_accepts_giphy_subdomains():
    """media0.giphy.com, i.giphy.com, etc. are all valid Giphy hosts."""
    from app.routers.gifs import _transform_giphy_response

    for host in ("media.giphy.com", "media0.giphy.com", "i.giphy.com", "giphy.com"):
        payload = {
            "data": [
                {
                    "id": host,
                    "images": {
                        "original": {
                            "url": f"https://{host}/x.gif",
                            "width": "1",
                            "height": "1",
                        },
                        "fixed_width": {
                            "url": f"https://{host}/x-fw.gif",
                            "width": "1",
                            "height": "1",
                        },
                    },
                }
            ],
            "pagination": {"offset": 0, "count": 1, "total_count": 1},
        }
        out = _transform_giphy_response(payload)
        assert len(out.results) == 1, f"expected {host} to be allowed"
