
import pytest
from unittest.mock import patch, AsyncMock, MagicMock

import httpx
from fastapi import HTTPException

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
    assert body["expires_at"]


@pytest.mark.asyncio
async def test_siwf_login_with_use_cookie_sets_cookie_and_omits_body_token(auth_client):
    """use_cookie:true delivers the refresh token via HttpOnly cookie only."""
    client, _ = auth_client
    with (
        patch("app.routers.auth.consume_siwf_nonce", new_callable=AsyncMock, return_value=True),
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
        patch("app.routers.auth.consume_siwf_nonce", new_callable=AsyncMock, return_value=True),
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
        patch("app.routers.auth.consume_siwf_nonce", new_callable=AsyncMock, return_value=True),
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
    assert status_post.status_code == 404


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
