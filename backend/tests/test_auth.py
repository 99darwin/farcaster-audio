
import pytest
from unittest.mock import patch, AsyncMock, MagicMock

import httpx
from fastapi import HTTPException

from app.config import settings
from app.models.user import User
from app.services.auth_service import _hash_token

# ---------------------------------------------------------------------------
# Cookie-based refresh token (juke.audio dashboard XSS hardening).
# These tests stub the network-touching helpers used by
# /v1/auth/protocol so we can exercise the cookie set/clear logic and
# refresh accept-from-cookie path without a chain or Hypersnap.
# ---------------------------------------------------------------------------


def _login_payload(use_cookie: bool):
    payload = {
        "token": "hqa1.e30.e30",
    }
    if use_cookie:
        payload["use_cookie"] = True
    return payload


def _protocol_claims(fid: int = 7777):
    from datetime import datetime, timezone

    from app.services.siwf_service import ProtocolAuthClaims

    now = datetime.now(timezone.utc)
    return ProtocolAuthClaims(
        fid=fid,
        address="0x" + "ab" * 20,
        method="authAddress",
        domain="juke.audio",
        nonce="0123456789abcdef",
        issued_at=now,
        expires_at=now,
    )


def _mock_signer_and_profile():
    return [
        patch(
            "app.routers.auth.verify_protocol_auth_token",
            new_callable=AsyncMock,
            return_value=_protocol_claims(),
        ),
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
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
        patch(
            "app.routers.auth.user_signer_service.has_approved_signer",
            new_callable=AsyncMock,
            return_value=False,
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
    verify_patch, nonce_patch, profile_patch, signer_patch = _mock_signer_and_profile()
    with verify_patch, nonce_patch, profile_patch, signer_patch:
        response = await client.post("/v1/auth/protocol", json=_login_payload(True))

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
    assert body["user"]["signer_status"] in {"none", "pending", "approved", "revoked"}
    assert "encrypted_private_key" not in str(body)


@pytest.mark.asyncio
async def test_login_without_use_cookie_returns_body_token(auth_client):
    client, _ = auth_client
    verify_patch, nonce_patch, profile_patch, signer_patch = _mock_signer_and_profile()
    with verify_patch, nonce_patch, profile_patch, signer_patch:
        response = await client.post("/v1/auth/protocol", json=_login_payload(False))

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

    async def _getdel(key):
        return stored.pop(key, None)

    redis.get = _get
    redis.delete = _delete
    redis.getdel = _getdel
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

    async def _getdel(key):
        return stored.pop(key, None)

    redis.get = _get
    redis.delete = _delete
    redis.getdel = _getdel
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


def _install_fake_redis(stored: dict):
    """Wire stub get/delete/set onto the app's shared mocked redis.

    Returns nothing — callers seed `stored` ahead of time and inspect it
    afterward to confirm rotation/deletion semantics.
    """
    from app.main import app

    redis = app.state.redis

    async def _get(key):
        return stored.get(key)

    async def _delete(key):
        stored.pop(key, None)

    async def _set(key, value, **_):
        stored[key] = value

    async def _getdel(key):
        return stored.pop(key, None)

    redis.get = _get
    redis.delete = _delete
    redis.getdel = _getdel
    redis.set = _set
    return redis


@pytest.mark.asyncio
async def test_refresh_with_cookie_only_succeeds(auth_client):
    """Cold-start path: valid juke_refresh cookie, no Authorization header → 200."""
    client, fake_session = auth_client

    fid = 8001
    fake_session._user = User(
        fid=fid,
        signer_uuid="test-signer",
        username="tester",
        display_name="Tester",
        is_admin=False,
    )

    token = "rt_test-cookie-only-refresh"
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": str(fid)}
    _install_fake_redis(stored)

    with patch(
        "app.routers.auth.fetch_user_profile",
        new_callable=AsyncMock,
        return_value={},
    ):
        response = await client.post(
            "/v1/auth/refresh",
            cookies={"juke_refresh": token},
            json={},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["jwt"]
    # Cookie path: refresh token must not leak in the body.
    assert not body.get("refresh_token")
    # Set-Cookie should rotate the refresh cookie.
    set_cookie = response.headers.get("set-cookie", "")
    assert "juke_refresh=" in set_cookie
    assert "HttpOnly" in set_cookie
    # Old token must be gone (single-use).
    assert f"refresh_token:{token_hash}" not in stored


@pytest.mark.asyncio
async def test_refresh_with_cookie_only_no_cookie_401s(auth_client):
    """Truly empty refresh attempt — no cookie, no bearer, no body → 401."""
    client, _ = auth_client

    response = await client.post("/v1/auth/refresh", json={})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_refresh_with_cookie_only_invalid_cookie_401s(auth_client):
    """Bogus cookie value with no bearer → 401 (consume_refresh_token returns None)."""
    client, _ = auth_client

    # Seed redis with *nothing* so any token lookup misses.
    _install_fake_redis({})

    response = await client.post(
        "/v1/auth/refresh",
        cookies={"juke_refresh": "rt_does-not-exist"},
        json={},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_refresh_with_bearer_and_cookie_still_works(auth_client):
    """Existing path: bearer JWT + matching refresh cookie → 200, sanity check."""
    client, fake_session = auth_client
    from jose import jwt as jose_jwt

    fid = 8002
    fake_session._user = User(
        fid=fid,
        signer_uuid="test-signer",
        username="tester",
        display_name="Tester",
        is_admin=False,
    )

    token = "rt_test-bearer-and-cookie"
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": str(fid)}
    _install_fake_redis(stored)

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

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["jwt"]
    assert not body.get("refresh_token")


@pytest.mark.asyncio
async def test_refresh_with_mismatched_bearer_and_cookie_401s(auth_client):
    """Bearer FID and refresh-token FID don't match → 401 (defense in depth)."""
    client, fake_session = auth_client
    from jose import jwt as jose_jwt

    cookie_fid = 8003
    bearer_fid = 9999  # different FID
    fake_session._user = User(
        fid=cookie_fid,
        signer_uuid="test-signer",
        username="tester",
        display_name="Tester",
        is_admin=False,
    )

    token = "rt_test-mismatch"
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": str(cookie_fid)}
    _install_fake_redis(stored)

    bearer = jose_jwt.encode(
        {"fid": bearer_fid, "exp": 0},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )

    response = await client.post(
        "/v1/auth/refresh",
        cookies={"juke_refresh": token},
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


def _stub_dc_token_delete(monkeypatch) -> list[int]:
    """Record ``delete_direct_cast_token`` calls instead of hitting Postgres."""
    from app.services import farcaster_token_service

    deleted: list[int] = []

    async def _delete_token(db, fid):
        deleted.append(fid)

    monkeypatch.setattr(
        farcaster_token_service, "delete_direct_cast_token", _delete_token
    )
    return deleted


@pytest.mark.asyncio
async def test_logout_revokes_refresh_token(client, monkeypatch):
    from app.main import app

    token = "rt_test-logout-revoke"
    redis = app.state.redis
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": "9999"}

    async def _get(key):
        return stored.get(key)

    async def _getdel(key):
        return stored.pop(key, None)

    redis.get = _get
    redis.getdel = _getdel

    deleted = _stub_dc_token_delete(monkeypatch)

    response = await client.post(
        "/v1/auth/logout",
        cookies={"juke_refresh": token},
    )
    assert response.status_code == 204
    # Token must be gone from Redis after logout — replay protection.
    assert await redis.get(f"refresh_token:{token_hash}") is None
    # The fid's stored Direct Casts token is forgotten too.
    assert deleted == [9999]


@pytest.mark.asyncio
async def test_logout_revokes_refresh_token_from_body(client, monkeypatch):
    """iOS has no HttpOnly cookie, so it sends the refresh token in the body.
    Revocation must work identically in that path."""
    from app.main import app

    token = "rt_test-logout-body-revoke"
    redis = app.state.redis
    token_hash = _hash_token(token)
    stored = {f"refresh_token:{token_hash}": "9999"}

    async def _get(key):
        return stored.get(key)

    async def _getdel(key):
        return stored.pop(key, None)

    redis.get = _get
    redis.getdel = _getdel

    deleted = _stub_dc_token_delete(monkeypatch)

    response = await client.post(
        "/v1/auth/logout",
        json={"refresh_token": token},
    )
    assert response.status_code == 204
    assert await redis.get(f"refresh_token:{token_hash}") is None
    assert deleted == [9999]


@pytest.mark.asyncio
async def test_logout_with_empty_body_is_idempotent(client):
    """Logout must not require a body — already-logged-out clients and fresh
    installs should still get 204."""
    response = await client.post("/v1/auth/logout")
    assert response.status_code == 204


def _bearer(fid: int, **claims) -> dict[str, str]:
    from app.services.auth_service import create_jwt, create_partner_jwt

    if claims.get("source") == "partner":
        token, _ = create_partner_jwt(fid=fid, partner_app_id="app", ttl_seconds=60)
    else:
        token, _ = create_jwt(fid)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_logout_with_access_jwt_only_deletes_dc_token(client, monkeypatch):
    """A refresh that raced logout already consumed the refresh token; the
    access JWT still identifies whose Direct Casts token to delete."""
    _install_fake_redis({})
    deleted = _stub_dc_token_delete(monkeypatch)
    response = await client.post(
        "/v1/auth/logout",
        cookies={"juke_refresh": "rt_already-consumed"},
        headers=_bearer(4242),
    )
    assert response.status_code == 204
    assert deleted == [4242]


@pytest.mark.asyncio
async def test_logout_bearer_and_refresh_same_fid_deletes_once(client, monkeypatch):
    token = "rt_test-logout-both"
    _install_fake_redis({f"refresh_token:{_hash_token(token)}": "4242"})
    deleted = _stub_dc_token_delete(monkeypatch)
    response = await client.post(
        "/v1/auth/logout", json={"refresh_token": token}, headers=_bearer(4242)
    )
    assert response.status_code == 204
    assert deleted == [4242]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": "Basic Zm9vOmJhcg=="},
        "expired",
        "partner",
    ],
)
async def test_logout_ignores_unusable_bearer(client, monkeypatch, headers):
    from jose import jwt as jose_jwt

    if headers == "expired":
        expired = jose_jwt.encode(
            {"fid": 4242, "exp": 1},
            settings.JWT_SECRET,
            algorithm=settings.JWT_ALGORITHM,
        )
        headers = {"Authorization": f"Bearer {expired}"}
    elif headers == "partner":
        headers = _bearer(4242, source="partner")
    _install_fake_redis({})
    deleted = _stub_dc_token_delete(monkeypatch)
    response = await client.post("/v1/auth/logout", headers=headers)
    assert response.status_code == 204
    assert deleted == []


def _signed_bearer(claims: dict, secret: str | None = None) -> dict[str, str]:
    from jose import jwt as jose_jwt

    token = jose_jwt.encode(
        claims, secret or settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_logout_with_recently_expired_access_jwt_deletes_dc_token(
    client, monkeypatch
):
    """L3: clients usually log out after the access token lapsed; a validly
    signed first-party token still identifies whose DC token to delete."""
    import time

    _install_fake_redis({})
    deleted = _stub_dc_token_delete(monkeypatch)
    an_hour_ago = int(time.time()) - 3600
    response = await client.post(
        "/v1/auth/logout", headers=_signed_bearer({"fid": 4242, "exp": an_hour_ago})
    )
    assert response.status_code == 204
    assert deleted == [4242]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "claims,secret",
    [
        ({"fid": 4242}, None),  # no exp: not an access token we minted
        ({"fid": 4242, "exp": 9999999999}, "wrong-secret"),  # forged
        ({"fid": "4242", "exp": 9999999999}, None),  # non-int fid
        (
            {"fid": 4242, "exp": 9999999999, "source": "partner"},
            None,
        ),
    ],
)
async def test_logout_ignores_unverifiable_bearer_claims(
    client, monkeypatch, claims, secret
):
    _install_fake_redis({})
    deleted = _stub_dc_token_delete(monkeypatch)
    response = await client.post(
        "/v1/auth/logout", headers=_signed_bearer(claims, secret)
    )
    assert response.status_code == 204
    assert deleted == []


@pytest.mark.asyncio
async def test_logout_ignores_token_expired_beyond_refresh_lifetime(
    client, monkeypatch
):
    import time

    _install_fake_redis({})
    deleted = _stub_dc_token_delete(monkeypatch)
    too_old = int(time.time()) - (settings.JWT_REFRESH_EXPIRY_DAYS + 1) * 24 * 60 * 60
    response = await client.post(
        "/v1/auth/logout", headers=_signed_bearer({"fid": 4242, "exp": too_old})
    )
    assert response.status_code == 204
    assert deleted == []


@pytest.mark.asyncio
async def test_consume_refresh_token_is_single_use_under_race():
    """Two concurrent consumers: exactly one gets the fid. A GET-then-DELETE
    implementation fails this because ``get`` yields between the two."""
    import asyncio

    from app.services.auth_service import consume_refresh_token

    token = "rt_race"
    store = {f"refresh_token:{_hash_token(token)}": "77"}

    class _YieldingRedis:
        async def get(self, key):
            await asyncio.sleep(0)
            return store.get(key)

        async def delete(self, key):
            await asyncio.sleep(0)
            store.pop(key, None)

        async def getdel(self, key):
            return store.pop(key, None)

    redis = _YieldingRedis()
    results = await asyncio.gather(
        consume_refresh_token(token, redis), consume_refresh_token(token, redis)
    )
    assert sorted(results, key=lambda r: r is None) == [77, None]
    assert store == {}


@pytest.mark.asyncio
async def test_neynar_login_routes_are_gone(client):
    """The Neynar SIWN login and auth-url routes were removed."""
    login = await client.post(
        "/v1/auth/login", json={"signer_uuid": "invalid-signer", "fid": 12345}
    )
    auth_url = await client.get("/v1/auth/neynar-auth-url")
    assert login.status_code == 404
    assert auth_url.status_code == 404


@pytest.mark.asyncio
async def test_signer_register_missing_fields(client):
    """Register validates its body before any work."""
    response = await client.post("/v1/auth/signer/register", json={})
    assert response.status_code == 422


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
# SIWF (Sign In With Farcaster) — nonce + login endpoints.
# ---------------------------------------------------------------------------


def _http_status_error(status_code: int, body: str = "") -> httpx.HTTPStatusError:
    """Build an httpx.HTTPStatusError with a populated response body."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = body
    return httpx.HTTPStatusError("upstream error", request=None, response=resp)


# Minimal-but-parseable SIWE message — siwe-py's `from_message` accepts
# this and exposes `.nonce` + `.domain`. Tests mock everything beyond
# parsing, so the address / signature don't have to verify.
def _siwe_msg(nonce: str = "testnonce123", domain: str = "juke.audio") -> str:
    return (
        f"{domain} wants you to sign in with your Ethereum account:\n"
        "0x1234567890AbcdEF1234567890aBcdef12345678\n"
        "\n"
        "Farcaster Auth\n"
        "\n"
        f"URI: https://{domain}/developers\n"
        "Version: 1\n"
        "Chain ID: 10\n"
        f"Nonce: {nonce}\n"
        "Issued At: 2026-05-12T18:00:00.000Z\n"
        "Resources:\n"
        "- farcaster://fids/7777"
    )


@pytest.mark.asyncio
async def test_siwf_nonce_returns_unique_nonce(client):
    """Happy path: POST /v1/auth/siwf/nonce returns a non-empty nonce."""
    response = await client.post("/v1/auth/siwf/nonce")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["nonce"], str)
    assert len(body["nonce"]) >= 8  # SIWE recommends 8+ chars; we use ~22


@pytest.mark.asyncio
async def test_siwf_nonce_rate_limit_returns_429(client):
    """31st nonce request from one IP within 60s returns 429."""
    from app.main import app

    app.state.redis.incr = AsyncMock(return_value=31)
    app.state.redis.ttl = AsyncMock(return_value=42)

    response = await client.post("/v1/auth/siwf/nonce")
    assert response.status_code == 429
    assert response.headers.get("retry-after") == "42"


@pytest.mark.asyncio
async def test_siwf_login_happy_path_mints_jwt(auth_client):
    """Full SIWF happy path: nonce → verify → fid lookup → JWT."""
    client, _ = auth_client
    consume_patch = patch(
        "app.routers.auth.consume_siwf_nonce",
        new_callable=AsyncMock,
        return_value=True,
    )
    verify_patch = patch(
        "app.routers.auth.verify_siwf_message",
        new_callable=AsyncMock,
        return_value="0x1234567890abcdef1234567890abcdef12345678",
    )
    lookup_patch = patch(
        "app.routers.auth.lookup_fid_by_custody",
        new_callable=AsyncMock,
        return_value=7777,
    )
    profile_patch = patch(
        "app.routers.auth.fetch_user_profile",
        new_callable=AsyncMock,
        return_value={
            "username": "tester",
            "display_name": "Tester",
            "pfp_url": None,
            "custody_address": "0x1234567890abcdef1234567890abcdef12345678",
        },
    )

    with consume_patch, verify_patch, lookup_patch, profile_patch:
        response = await client.post(
            "/v1/auth/siwf/login",
            json={
                "message": _siwe_msg(),
                "signature": "0xabc",
                "use_cookie": False,
            },
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["jwt"]
    assert body["user"]["fid"] == 7777
    assert body["user"]["signer_status"] in {"none", "pending", "approved", "revoked"}
    assert body["expires_at"]


@pytest.mark.asyncio
async def test_siwf_login_with_use_cookie_sets_cookie_and_omits_body_token(auth_client):
    """use_cookie:true delivers the refresh token via HttpOnly cookie only."""
    client, _ = auth_client
    with (
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch(
            "app.routers.auth.verify_siwf_message",
            new_callable=AsyncMock,
            return_value="0x1234567890abcdef1234567890abcdef12345678",
        ),
        patch(
            "app.routers.auth.lookup_fid_by_custody",
            new_callable=AsyncMock,
            return_value=7777,
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
    ):
        response = await client.post(
            "/v1/auth/siwf/login",
            json={
                "message": _siwe_msg(),
                "signature": "0xabc",
                "use_cookie": True,
            },
        )

    assert response.status_code == 200, response.text
    set_cookie = response.headers.get("set-cookie", "")
    assert "juke_refresh=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert not response.json().get("refresh_token")


@pytest.mark.asyncio
async def test_siwf_login_rejects_unused_nonce(auth_client):
    """If the nonce was never minted (or already consumed), 401."""
    client, _ = auth_client
    with patch(
        "app.routers.auth.consume_siwf_nonce",
        new_callable=AsyncMock,
        return_value=False,
    ):
        response = await client.post(
            "/v1/auth/siwf/login",
            json={"message": _siwe_msg(), "signature": "0xabc"},
        )

    assert response.status_code == 401
    assert "nonce" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_siwf_login_rejects_bad_signature(auth_client):
    """Signature verification failure → 401 with a generic detail."""
    client, _ = auth_client
    with (
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch(
            "app.routers.auth.verify_siwf_message",
            new_callable=AsyncMock,
            side_effect=HTTPException(
                status_code=401, detail="Invalid SIWF signature."
            ),
        ),
    ):
        response = await client.post(
            "/v1/auth/siwf/login",
            json={"message": _siwe_msg(), "signature": "0xabc"},
        )

    assert response.status_code == 401
    # Detail string is the generic one — verify it doesn't leak which
    # specific siwe check failed.
    assert response.json()["detail"] == "Invalid SIWF signature."


@pytest.mark.asyncio
async def test_siwf_login_rejects_unknown_address(auth_client):
    """Recovered address with no Farcaster account → 401."""
    client, _ = auth_client
    with (
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch(
            "app.routers.auth.verify_siwf_message",
            new_callable=AsyncMock,
            return_value="0xdeadbeef1234567890abcdef1234567890abcdef",
        ),
        patch(
            "app.routers.auth.lookup_fid_by_custody",
            new_callable=AsyncMock,
            return_value=None,
        ),
    ):
        response = await client.post(
            "/v1/auth/siwf/login",
            json={"message": _siwe_msg(), "signature": "0xabc"},
        )

    assert response.status_code == 401
    assert "no farcaster account" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_siwf_login_rate_limit_returns_429(auth_client):
    """11th SIWF login attempt from one IP within 60s returns 429."""
    from app.main import app

    client, _ = auth_client
    app.state.redis.incr = AsyncMock(return_value=11)
    app.state.redis.ttl = AsyncMock(return_value=42)

    response = await client.post(
        "/v1/auth/siwf/login",
        json={"message": _siwe_msg(), "signature": "0xabc"},
    )
    assert response.status_code == 429
    assert response.headers.get("retry-after") == "42"


@pytest.mark.asyncio
async def test_verify_siwf_message_with_real_signature():
    """Exercise siwe-py's real verify path end-to-end.

    The login-route tests mock `verify_siwf_message`, so a regression
    in the underlying call shape (e.g. awaiting a sync function) would
    slip through. This test actually signs a SIWE message with
    eth_account and runs it through `verify_siwf_message`, asserting
    the returned address matches the signer.
    """
    from datetime import datetime, timezone
    from eth_account import Account
    from siwe import SiweMessage

    from app.services.siwf_service import verify_siwf_message

    acct = Account.create()
    nonce = "realnoncetest123"
    domain = "juke.audio"
    msg = SiweMessage(
        domain=domain,
        address=acct.address,
        statement="Farcaster Auth",
        uri=f"https://{domain}/developers",
        version="1",
        chain_id=10,
        nonce=nonce,
        issued_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    rendered = msg.prepare_message()
    signed = acct.sign_message(
        __import__("eth_account").messages.encode_defunct(text=rendered)
    )

    recovered = await verify_siwf_message(
        message=rendered,
        signature=signed.signature.hex(),
        expected_domain=domain,
        expected_nonce=nonce,
    )
    assert recovered.lower() == acct.address.lower()


@pytest.mark.asyncio
async def test_signer_endpoints_are_gone(client):
    """The legacy managed-signer endpoints from PR #160 Stream A no longer exist.

    Sanity-check that a future contributor doesn't accidentally
    re-introduce them — the audit's CRITICAL #1 was structurally fixed
    by switching to SIWF, and we want the dead routes to stay dead.
    """
    create = await client.post("/v1/auth/signer/create")
    status_post = await client.post("/v1/auth/signer/status", json={"signer_uuid": "x"})
    assert create.status_code == 404
    # GET /v1/auth/signer/status exists (addFor signer flow); POST does not.
    assert status_post.status_code == 405


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/v1/auth/protocol", _login_payload(False)),
        (
            "/v1/auth/signer/register",
            {
                "prepare_id": "6f1c1f36-5d43-4c47-9d0c-0d8f8f1b2a10",
                "signer_add_signature": "0x" + "11" * 65,
                "auth_address_add_signature": "0x" + "22" * 65,
                "protocol_auth_token": "hqa1.e30.e30",
            },
        ),
    ],
)
async def test_signer_register_rate_limit_returns_429(auth_client, path, payload):
    """Past the per-IP budget, login and register return 429 + Retry-After."""
    from app.main import app

    # Force the over-limit branch on the first request: per-IP incr returns 11.
    app.state.redis.incr = AsyncMock(return_value=11)
    app.state.redis.ttl = AsyncMock(return_value=42)

    client, _ = auth_client
    response = await client.post(path, json=payload)

    assert response.status_code == 429
    assert response.headers.get("retry-after") == "42"


def test_auth_uses_shared_proxy_aware_client_ip_helper():
    """Auth rate limits key on the single trusted-proxy-aware helper.

    Resolution semantics are covered in ``tests/test_client_ip.py``; here we
    only pin that auth no longer carries its own divergent copy.
    """
    from app.routers import auth
    from app.services.client_ip import client_ip

    assert auth._client_ip is client_ip
