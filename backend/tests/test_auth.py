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
async def test_get_auth_url(client):
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {
        "authorization_url": "https://app.neynar.com/login?client_id=test"
    }

    mock_http_client = AsyncMock()
    mock_http_client.get = AsyncMock(return_value=mock_response)
    mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
    mock_http_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.routers.auth.httpx.AsyncClient", return_value=mock_http_client):
        response = await client.get("/v1/auth/neynar-auth-url")
    assert response.status_code == 200
    data = response.json()
    assert "authorization_url" in data
    assert "neynar.com" in data["authorization_url"]


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
