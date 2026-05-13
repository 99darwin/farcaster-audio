import logging

import pytest
from unittest.mock import patch, AsyncMock, MagicMock

import httpx

from app.config import settings
from app.models.user import User
from app.services.auth_service import _hash_token


# ---------------------------------------------------------------------------
# Cookie-based refresh token (juke.audio dashboard XSS hardening).
# These tests stub the network-touching helpers used by /v1/auth/login so we
# can exercise the cookie set/clear logic and refresh accept-from-cookie path
# without standing up a real Neynar mock.
# ---------------------------------------------------------------------------


def _login_payload(use_cookie: bool):
    payload = {"signer_uuid": "test-signer", "fid": 7777}
    if use_cookie:
        payload["use_cookie"] = True
    return payload


def _mock_signer_and_profile():
    return [
        patch(
            "app.routers.auth.verify_neynar_signer",
            new_callable=AsyncMock,
            return_value={"fid": 7777, "signer_uuid": "test-signer"},
        ),
        patch(
            "app.routers.auth.fetch_user_profile",
            new_callable=AsyncMock,
            return_value={
                "username": "tester",
                "display_name": "Tester",
                "pfp_url": None,
                "custody_address": None,
            },
        ),
    ]


class _FakeAsyncSession:
    """Minimal AsyncSession stand-in for auth/login tests.

    Avoids spinning up SQLite just to satisfy get_or_create_user, which only
    needs `execute(...).scalar_one_or_none()`, `add`, `commit`, `refresh`.
    """

    def __init__(self):
        self._user = None

    async def execute(self, _stmt):
        user = self._user

        class _Result:
            def scalar_one_or_none(self_inner):
                return user

        return _Result()

    def add(self, user):
        # SQLAlchemy column defaults (is_admin=False, etc.) only land on the
        # instance after INSERT + refresh, which our fake skips. Backfill the
        # column defaults so Pydantic LoginResponse validation doesn't see
        # `is_admin=None` on a brand-new user.
        if user.is_admin is None:
            user.is_admin = False
        if getattr(user, "is_agent", None) is None:
            user.is_agent = False
        if getattr(user, "developer_access_status", None) is None:
            user.developer_access_status = "none"
        self._user = user

    async def commit(self):
        pass

    async def refresh(self, _user):
        pass


@pytest.fixture
async def auth_client(client):
    from app.dependencies import get_db
    from app.main import app

    fake_session = _FakeAsyncSession()

    async def _override_get_db():
        yield fake_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield client, fake_session
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_login_with_use_cookie_sets_cookie_and_omits_body_token(auth_client):
    client, _ = auth_client
    signer_patch, profile_patch = _mock_signer_and_profile()
    with signer_patch, profile_patch:
        response = await client.post("/v1/auth/login", json=_login_payload(True))

    assert response.status_code == 200
    set_cookie = response.headers.get("set-cookie", "")
    assert "juke_refresh=" in set_cookie
    assert "HttpOnly" in set_cookie
    # Starlette renders SameSite as "lax" (lowercase value).
    assert "samesite=lax" in set_cookie.lower()
    assert "path=/v1/auth" in set_cookie.lower()
    # The body must not expose the refresh token to JS.
    body = response.json()
    assert not body.get("refresh_token")
    assert body["jwt"]
    assert body["expires_at"]
    assert body["user"]["fid"] == 7777


@pytest.mark.asyncio
async def test_login_without_use_cookie_returns_body_token(auth_client):
    client, _ = auth_client
    signer_patch, profile_patch = _mock_signer_and_profile()
    with signer_patch, profile_patch:
        response = await client.post("/v1/auth/login", json=_login_payload(False))

    assert response.status_code == 200
    # No Set-Cookie for backward-compatible callers.
    assert "juke_refresh" not in response.headers.get("set-cookie", "")
    body = response.json()
    assert isinstance(body.get("refresh_token"), str) and body["refresh_token"]


@pytest.mark.asyncio
async def test_refresh_with_cookie_works_and_rotates_cookie(auth_client):
    client, fake_session = auth_client
    from jose import jwt as jose_jwt

    fid = 7777
    fake_session._user = User(
        fid=fid,
        signer_uuid="test-signer",
        username="tester",
        display_name="Tester",
        is_admin=False,
    )

    # Seed a refresh token directly into the mocked redis used by the client
    # fixture, then hit /refresh with the cookie set.
    from app.main import app

    token = "rt_test-cookie-refresh-token"
    redis = app.state.redis
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": str(fid)}

    async def _get(key):
        return stored.get(key)

    async def _delete(key):
        stored.pop(key, None)

    async def _set(key, value, **_):
        stored[key] = value

    redis.get = _get
    redis.delete = _delete
    redis.set = _set

    bearer = jose_jwt.encode(
        {"fid": fid, "exp": 0},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )

    with patch(
        "app.routers.auth.fetch_user_profile",
        new_callable=AsyncMock,
        return_value={},
    ):
        response = await client.post(
            "/v1/auth/refresh",
            cookies={"juke_refresh": token},
            headers={"Authorization": f"Bearer {bearer}"},
            json={},
        )

    assert response.status_code == 200
    set_cookie = response.headers.get("set-cookie", "")
    assert "juke_refresh=" in set_cookie
    assert "HttpOnly" in set_cookie
    body = response.json()
    # Cookie path: refresh token must not be echoed in the body.
    assert not body.get("refresh_token")


@pytest.mark.asyncio
async def test_refresh_with_body_works(auth_client):
    client, fake_session = auth_client
    from jose import jwt as jose_jwt

    fid = 7778
    fake_session._user = User(
        fid=fid,
        signer_uuid="test-signer",
        username="tester",
        display_name="Tester",
        is_admin=False,
    )

    from app.main import app

    token = "rt_test-body-refresh-token"
    redis = app.state.redis
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": str(fid)}

    async def _get(key):
        return stored.get(key)

    async def _delete(key):
        stored.pop(key, None)

    async def _set(key, value, **_):
        stored[key] = value

    redis.get = _get
    redis.delete = _delete
    redis.set = _set

    bearer = jose_jwt.encode(
        {"fid": fid, "exp": 0},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )

    with patch(
        "app.routers.auth.fetch_user_profile",
        new_callable=AsyncMock,
        return_value={},
    ):
        response = await client.post(
            "/v1/auth/refresh",
            headers={"Authorization": f"Bearer {bearer}"},
            json={"refresh_token": token},
        )

    assert response.status_code == 200
    # Body path: no cookie set, refresh token rotated in body.
    assert "juke_refresh" not in response.headers.get("set-cookie", "")
    body = response.json()
    assert isinstance(body.get("refresh_token"), str) and body["refresh_token"]


@pytest.mark.asyncio
async def test_refresh_rejects_when_no_cookie_or_body(auth_client):
    client, _ = auth_client
    from jose import jwt as jose_jwt

    bearer = jose_jwt.encode(
        {"fid": 7779, "exp": 0},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    response = await client.post(
        "/v1/auth/refresh",
        headers={"Authorization": f"Bearer {bearer}"},
        json={},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_logout_clears_cookie(client):
    response = await client.post(
        "/v1/auth/logout",
        cookies={"juke_refresh": "rt_anything"},
    )
    assert response.status_code == 204
    set_cookie = response.headers.get("set-cookie", "")
    assert "juke_refresh=" in set_cookie
    # Max-Age=0 signals immediate expiry.
    assert "max-age=0" in set_cookie.lower()


@pytest.mark.asyncio
async def test_logout_revokes_refresh_token(client):
    from app.main import app

    token = "rt_test-logout-revoke"
    redis = app.state.redis
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": "9999"}

    async def _get(key):
        return stored.get(key)

    async def _delete(key):
        stored.pop(key, None)

    redis.get = _get
    redis.delete = _delete

    response = await client.post(
        "/v1/auth/logout",
        cookies={"juke_refresh": token},
    )
    assert response.status_code == 204
    # Token must be gone from Redis after logout — replay protection.
    assert await redis.get(f"refresh_token:{token_hash}") is None


@pytest.mark.asyncio
async def test_login_invalid_signer(client):
    """Login should fail with invalid signer."""
    with patch(
        "app.routers.auth.verify_neynar_signer",
        new_callable=AsyncMock,
        side_effect=httpx.HTTPStatusError("Invalid", request=None, response=MagicMock(status_code=401)),
    ):
        response = await client.post(
            "/v1/auth/login",
            json={
                "signer_uuid": "invalid-signer",
                "fid": 12345,
            },
        )
        assert response.status_code in (401, 500)


@pytest.mark.asyncio
async def test_login_missing_fields(client):
    """Login should fail with missing required fields."""
    response = await client.post("/v1/auth/login", json={})
    assert response.status_code == 422  # Validation error


@pytest.mark.asyncio
async def test_protected_endpoint_no_token(client):
    """Protected endpoints should return 401 without token."""
    response = await client.post("/v1/rooms", json={"title": "test"})
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_protected_endpoint_invalid_token(client):
    """Protected endpoints should return 401 with invalid token."""
    response = await client.post(
        "/v1/rooms",
        json={"title": "test"},
        headers={"Authorization": "Bearer invalid-token"},
    )
    assert response.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Stream A follow-ups: signer endpoints, audit logging, proxy-aware IP,
# and per-IP / per-uuid rate limits.
# ---------------------------------------------------------------------------


def _http_status_error(status_code: int, body: str = "") -> httpx.HTTPStatusError:
    """Build an httpx.HTTPStatusError with a populated response body.

    The auth router logs `exc.response.text`, so the response mock must
    expose both a status_code and a `.text` attribute.
    """
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = body
    return httpx.HTTPStatusError("upstream error", request=None, response=resp)


@pytest.mark.asyncio
async def test_signer_status_accepts_post_body(client):
    """POST with JSON body works, and GET on the same path is 405."""
    with patch(
        "app.routers.auth.lookup_signer_status",
        new_callable=AsyncMock,
        return_value={"status": "pending_approval", "fid": None},
    ):
        response = await client.post(
            "/v1/auth/signer/status",
            json={"signer_uuid": "abc"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body == {"status": "pending_approval", "fid": None}

    # GET on /signer/status must NOT exist — guards against an accidental
    # reintroduction of the querystring variant (#16) which would leak
    # signer_uuid into access logs / Referer headers.
    get_response = await client.get(
        "/v1/auth/signer/status",
        params={"signer_uuid": "abc"},
    )
    assert get_response.status_code == 405


@pytest.mark.asyncio
async def test_signer_status_per_uuid_rate_limit(client):
    """31st poll for one signer_uuid (within 24h) returns 429 + Retry-After.

    The route calls redis.incr twice in sequence: per-IP first, then
    per-UUID. Sequence the side_effect: per-IP returns 1 (well under
    the 120/min cap), per-UUID returns 31 (one above the 30/24h cap).
    """
    from app.main import app

    app.state.redis.incr = AsyncMock(side_effect=[1, 31])
    app.state.redis.ttl = AsyncMock(return_value=12345)

    with patch(
        "app.routers.auth.lookup_signer_status",
        new_callable=AsyncMock,
        return_value={"status": "pending_approval", "fid": None},
    ):
        response = await client.post(
            "/v1/auth/signer/status",
            json={"signer_uuid": "leaky-uuid"},
        )

    assert response.status_code == 429
    assert "this signer" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_signer_status_per_ip_rate_limit(client):
    """121st request from one IP within 60s returns 429."""
    from app.main import app

    # First incr (per-IP) overshoots the 120/min cap; per-UUID incr
    # never runs because the 429 short-circuits the route.
    app.state.redis.incr = AsyncMock(side_effect=[121, 1])

    with patch(
        "app.routers.auth.lookup_signer_status",
        new_callable=AsyncMock,
        return_value={"status": "pending_approval", "fid": None},
    ):
        response = await client.post(
            "/v1/auth/signer/status",
            json={"signer_uuid": "abc"},
        )

    assert response.status_code == 429
    assert "polling" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_login_rate_limit_returns_429(auth_client):
    """11th login attempt from one IP within 60s returns 429 + Retry-After."""
    from app.main import app

    # Force the over-limit branch on the first request: per-IP incr returns 11.
    app.state.redis.incr = AsyncMock(return_value=11)
    app.state.redis.ttl = AsyncMock(return_value=42)

    client, _ = auth_client
    signer_patch, profile_patch = _mock_signer_and_profile()
    with signer_patch, profile_patch:
        response = await client.post(
            "/v1/auth/login",
            json={"signer_uuid": "test-signer", "fid": 7777},
        )

    assert response.status_code == 429
    assert response.headers.get("retry-after") == "42"
    assert "login" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_signer_neynar_502_logs_failure(client, caplog):
    """Upstream 502 surfaces as 502 + emits a `signer_create_failed` audit log."""
    caplog.set_level(logging.INFO, logger="app.routers.auth")
    with patch(
        "app.routers.auth.create_and_register_signer",
        new_callable=AsyncMock,
        side_effect=_http_status_error(502, body="neynar down"),
    ):
        response = await client.post("/v1/auth/signer/create")

    assert response.status_code == 502

    audit_records = [
        r for r in caplog.records
        if getattr(r, "event", None) == "signer_create_failed"
    ]
    assert audit_records, "expected at least one signer_create_failed log"
    rec = audit_records[0]
    assert rec.error == "neynar_upstream_error"
    assert rec.signer_uuid is None
    assert hasattr(rec, "ip")
    assert hasattr(rec, "user_agent")


@pytest.mark.asyncio
async def test_create_signer_misconfigured_raises_500(client, caplog):
    """ValueError from create_and_register_signer surfaces as 500 + audit log."""
    caplog.set_level(logging.INFO, logger="app.routers.auth")
    with patch(
        "app.routers.auth.create_and_register_signer",
        new_callable=AsyncMock,
        side_effect=ValueError("FARCASTER_APP_FID is not configured"),
    ):
        response = await client.post("/v1/auth/signer/create")

    assert response.status_code == 500

    audit_records = [
        r for r in caplog.records
        if getattr(r, "event", None) == "signer_create_failed"
    ]
    assert audit_records, "expected at least one signer_create_failed log"
    assert audit_records[0].error == "misconfigured"


@pytest.mark.asyncio
async def test_create_signer_emits_audit_log_on_success(client, caplog):
    """Successful signer creation emits a structured `signer_created` log."""
    caplog.set_level(logging.INFO, logger="app.routers.auth")
    fake_result = {
        "signer_uuid": "fake-uuid-1234",
        "signer_approval_url": "https://example.com/approve",
        "public_key": "0xdeadbeef",
    }
    with patch(
        "app.routers.auth.create_and_register_signer",
        new_callable=AsyncMock,
        return_value=fake_result,
    ):
        response = await client.post(
            "/v1/auth/signer/create",
            headers={"User-Agent": "Mozilla/5.0 (test)"},
        )

    assert response.status_code == 200
    assert response.json()["signer_uuid"] == "fake-uuid-1234"

    audit_records = [
        r for r in caplog.records
        if getattr(r, "event", None) == "signer_created"
    ]
    assert audit_records, "expected at least one signer_created log"
    rec = audit_records[0]
    assert rec.signer_uuid == "fake-uuid-1234"
    assert rec.user_agent == "Mozilla/5.0 (test)"
    assert hasattr(rec, "ip")
    assert hasattr(rec, "app_fid")


def test_client_ip_helper_parses_xff_leftmost():
    """`_client_ip` parses XFF leftmost, falls back through real-ip → peer → 'unknown'."""
    from app.routers.auth import _client_ip

    def _make_request(headers: dict, client_host: str | None = "10.99.99.99"):
        """Build a stand-in `Request` covering the fields _client_ip touches."""
        req = MagicMock()
        # Use a real Headers-compatible dict (case-insensitive .get).
        # MagicMock's default would record .get() calls but never return data.
        class _Headers:
            def __init__(self, d):
                self._d = {k.lower(): v for k, v in d.items()}
            def get(self, key, default=""):
                return self._d.get(key.lower(), default)
        req.headers = _Headers(headers)
        if client_host is None:
            req.client = None
        else:
            client = MagicMock()
            client.host = client_host
            req.client = client
        return req

    # 1. Leftmost XFF wins, even when intermediate proxies are present.
    req = _make_request(
        {"x-forwarded-for": "203.0.113.1, 10.0.0.1, 10.0.0.2"}
    )
    assert _client_ip(req) == "203.0.113.1"

    # 2. Empty XFF falls through to X-Real-IP.
    req = _make_request(
        {"x-forwarded-for": "", "x-real-ip": "198.51.100.7"}
    )
    assert _client_ip(req) == "198.51.100.7"

    # 3. No XFF, no X-Real-IP → request.client.host.
    req = _make_request({}, client_host="10.99.99.99")
    assert _client_ip(req) == "10.99.99.99"

    # 4. All sources missing → "unknown" sentinel.
    req = _make_request({}, client_host=None)
    assert _client_ip(req) == "unknown"

    # 5. XFF with only whitespace falls through (defensive — guard against
    #    a single-stripped-empty-element returning "").
    req = _make_request(
        {"x-forwarded-for": "   ", "x-real-ip": "198.51.100.9"}
    )
    assert _client_ip(req) == "198.51.100.9"
