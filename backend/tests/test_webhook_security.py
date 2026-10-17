"""Inbound webhook hardening: Mini App JFS verification, body caps, rate limits,
and Hypersnap replay windows."""

import base64
import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.clients.hypersnap import HypersnapUpstreamError
from app.config import settings
from app.dependencies import get_db
from app.main import app
from app.routers import webhooks as webhooks_router
from app.services import miniapp_webhook_service as jfs
from app.services import webhook_guard

# Throwaway test-only values (never real secrets).
PROXY_SECRET = "test-proxy-secret"
HYPERSNAP_SECRET = "test-hypersnap-secret"
TEST_FID = 4242
NOTIFICATION_URL = "https://api.warpcast.com/v1/frame-notifications"
NOTIFICATION_TOKEN = "test-notification-token"
HASH_ROOM = "0x" + "ab" * 20
HASH_REPLY = "0x" + "cd" * 20
SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _public_key_hex(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return "0x" + raw.hex()


def _envelope(
    private_key: Ed25519PrivateKey | None = None,
    *,
    fid: object = TEST_FID,
    jfs_type: str = "app_key",
    key: str | None = None,
    payload: dict | None = None,
) -> dict[str, str]:
    private_key = private_key or Ed25519PrivateKey.generate()
    header = _b64url(
        json.dumps(
            {
                "fid": fid,
                "type": jfs_type,
                "key": key or _public_key_hex(private_key),
            }
        ).encode()
    )
    body = _b64url(
        json.dumps(
            payload
            or {
                "event": "miniapp_added",
                "notificationDetails": {
                    "url": NOTIFICATION_URL,
                    "token": NOTIFICATION_TOKEN,
                },
            }
        ).encode()
    )
    signature = _b64url(private_key.sign(f"{header}.{body}".encode()))
    return {"header": header, "payload": body, "signature": signature}


def _hypersnap_sign(body: bytes) -> str:
    return hmac.new(HYPERSNAP_SECRET.encode(), body, hashlib.sha512).hexdigest()


@pytest.fixture
def fake_db():
    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    result.scalars.return_value.first.return_value = None
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)
    db.commit = AsyncMock()
    db.add = MagicMock()

    async def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    yield db
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def active_key(monkeypatch):
    check = AsyncMock(return_value=True)
    monkeypatch.setattr(webhooks_router, "is_app_key_active_for_fid", check)
    return check


@pytest.fixture
def proxy_secret(monkeypatch):
    monkeypatch.setattr(settings, "MINIAPP_WEBHOOK_SECRET", PROXY_SECRET)


# ---------------------------------------------------------------------------
# JFS signature verification (pure)
# ---------------------------------------------------------------------------


def test_verify_jfs_signature_accepts_valid_app_key_envelope():
    private_key = Ed25519PrivateKey.generate()
    verified = jfs.verify_jfs_signature(jfs.JfsEnvelope(**_envelope(private_key)))
    assert verified.fid == TEST_FID
    assert verified.key == _public_key_hex(private_key)
    assert verified.payload["event"] == "miniapp_added"


def test_verify_jfs_signature_accepts_padded_base64url():
    envelope = _envelope()
    envelope["signature"] += "=" * (-len(envelope["signature"]) % 4)
    assert jfs.verify_jfs_signature(jfs.JfsEnvelope(**envelope)).fid == TEST_FID


def test_verify_jfs_signature_rejects_swapped_fid():
    """Re-encoding the header with another FID breaks the signature."""
    envelope = _envelope()
    header = json.loads(base64.urlsafe_b64decode(envelope["header"] + "=="))
    header["fid"] = 1
    envelope["header"] = _b64url(json.dumps(header).encode())
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**envelope))


def test_verify_jfs_signature_rejects_tampered_payload():
    envelope = _envelope()
    envelope["payload"] = _b64url(json.dumps({"event": "miniapp_removed"}).encode())
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**envelope))


def test_verify_jfs_signature_rejects_signature_from_other_key():
    signer = Ed25519PrivateKey.generate()
    claimed = Ed25519PrivateKey.generate()
    envelope = _envelope(signer, key=_public_key_hex(claimed))
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**envelope))


@pytest.mark.parametrize("jfs_type", ["custody", "auth", ""])
def test_verify_jfs_signature_requires_app_key_type(jfs_type):
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**_envelope(jfs_type=jfs_type)))


@pytest.mark.parametrize("fid", [True, 0, -1, "4242", None, 1.5])
def test_verify_jfs_signature_rejects_invalid_fid(fid):
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**_envelope(fid=fid)))


@pytest.mark.parametrize("key", ["0x1234", "ab" * 32, "0x" + "zz" * 32])
def test_verify_jfs_signature_rejects_malformed_key(key):
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**_envelope(key=key)))


@pytest.mark.parametrize("field", ["header", "payload", "signature"])
def test_verify_jfs_signature_rejects_non_base64url(field):
    envelope = _envelope()
    envelope[field] = envelope[field][:-2] + "é+"
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**envelope))


def test_verify_jfs_signature_rejects_truncated_signature():
    envelope = _envelope()
    envelope["signature"] = _b64url(b"\x00" * 32)
    with pytest.raises(jfs.JfsVerificationError):
        jfs.verify_jfs_signature(jfs.JfsEnvelope(**envelope))


async def test_is_app_key_active_delegates_to_signer_registry(monkeypatch):
    lookup = AsyncMock(return_value=False)
    monkeypatch.setattr(jfs.signer_registry, "is_ed25519_signer_active", lookup)
    assert await jfs.is_app_key_active_for_fid(TEST_FID, "0x" + "ab" * 32) is False
    lookup.assert_awaited_once_with(TEST_FID, "0x" + "ab" * 32)


# ---------------------------------------------------------------------------
# /v1/webhooks/miniapp
# ---------------------------------------------------------------------------


async def test_miniapp_rejects_missing_or_wrong_secret_before_parsing(
    client, fake_db, active_key, proxy_secret
):
    for headers in ({}, {"X-Webhook-Secret": "wrong"}):
        resp = await client.post(
            "/v1/webhooks/miniapp", content=b"not json", headers=headers
        )
        assert resp.status_code == 401
    fake_db.execute.assert_not_called()
    active_key.assert_not_called()


async def test_miniapp_fails_closed_when_secret_unset(
    client, fake_db, active_key, monkeypatch
):
    monkeypatch.setattr(settings, "MINIAPP_WEBHOOK_SECRET", "")
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(),
        headers={"X-Webhook-Secret": ""},
    )
    assert resp.status_code == 401


async def test_miniapp_rejects_legacy_trusted_fid_shape(
    client, fake_db, active_key, proxy_secret
):
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json={
            "fid": TEST_FID,
            "event": "miniapp_added",
            "notification_url": NOTIFICATION_URL,
            "notification_token": NOTIFICATION_TOKEN,
        },
        headers={"X-Webhook-Secret": PROXY_SECRET},
    )
    assert resp.status_code == 400
    fake_db.execute.assert_not_called()


async def test_miniapp_rejects_forged_signature(
    client, fake_db, active_key, proxy_secret
):
    envelope = _envelope()
    envelope["signature"] = _b64url(b"\x01" * 64)
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=envelope,
        headers={"X-Webhook-Secret": PROXY_SECRET},
    )
    assert resp.status_code == 401
    active_key.assert_not_called()
    fake_db.execute.assert_not_called()


async def test_miniapp_rejects_key_not_registered_to_fid(
    client, fake_db, active_key, proxy_secret
):
    """A self-generated key pair signs fine but isn't the FID's app key."""
    active_key.return_value = False
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(),
        headers={"X-Webhook-Secret": PROXY_SECRET},
    )
    assert resp.status_code == 401
    fake_db.execute.assert_not_called()


async def test_miniapp_returns_503_when_key_lookup_fails(
    client, fake_db, active_key, proxy_secret
):
    active_key.side_effect = HypersnapUpstreamError(
        "boom", path="/v1/signersByFid", status_code=502
    )
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(),
        headers={"X-Webhook-Secret": PROXY_SECRET},
    )
    assert resp.status_code == 503
    fake_db.execute.assert_not_called()


async def test_miniapp_added_stores_token_for_verified_fid(
    client, fake_db, active_key, proxy_secret
):
    private_key = Ed25519PrivateKey.generate()
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(private_key),
        headers={"X-Webhook-Secret": PROXY_SECRET},
    )
    assert resp.status_code == 200
    active_key.assert_awaited_once_with(TEST_FID, _public_key_hex(private_key))
    row = fake_db.add.call_args.args[0]
    assert row.fid == TEST_FID
    assert row.notification_url == NOTIFICATION_URL
    assert row.notification_token == NOTIFICATION_TOKEN
    assert row.is_active is True
    fake_db.commit.assert_awaited_once()


async def test_miniapp_added_ignores_untrusted_notification_host(
    client, fake_db, active_key, proxy_secret
):
    envelope = _envelope(
        payload={
            "event": "notifications_enabled",
            "notificationDetails": {
                "url": "https://evil.example/notify",
                "token": NOTIFICATION_TOKEN,
            },
        }
    )
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=envelope,
        headers={"X-Webhook-Secret": PROXY_SECRET},
    )
    assert resp.status_code == 200
    fake_db.add.assert_not_called()
    fake_db.commit.assert_not_called()


async def test_miniapp_removed_deactivates_verified_fid(
    client, fake_db, active_key, proxy_secret
):
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(payload={"event": "miniapp_removed"}),
        headers={"X-Webhook-Secret": PROXY_SECRET},
    )
    assert resp.status_code == 200
    statement = fake_db.execute.call_args.args[0]
    assert statement.compile().params["fid_1"] == TEST_FID
    fake_db.commit.assert_awaited_once()


# ---------------------------------------------------------------------------
# Body cap, rate limits, failed-auth budget
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/v1/webhooks/livekit",
        "/v1/webhooks/hypersnap",
        "/v1/webhooks/hypersnap/notifications",
        "/v1/webhooks/miniapp",
    ],
)
async def test_webhooks_reject_oversized_declared_body(
    client, fake_db, monkeypatch, proxy_secret, path
):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", "x")
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_FOLLOW", "x")
    resp = await client.post(
        path,
        content=b"{}",
        headers={
            "Content-Length": str(webhook_guard.MAX_WEBHOOK_BODY_BYTES + 1),
            "X-Webhook-Secret": PROXY_SECRET,
        },
    )
    assert resp.status_code == 413
    fake_db.execute.assert_not_called()


async def test_webhook_rejects_oversized_streamed_body(client, fake_db, monkeypatch):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", "x")
    chunk = b"a" * (64 * 1024)

    async def _chunks():
        for _ in range(5):  # 320 KB, no Content-Length (chunked)
            yield chunk

    resp = await client.post("/v1/webhooks/hypersnap", content=_chunks())
    assert resp.status_code == 413


async def test_webhook_rejects_malformed_content_length(client, monkeypatch):
    from starlette.requests import Request

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "headers": [(b"content-length", b"nope")],
        }
    )
    with pytest.raises(webhook_guard.HTTPException) as exc_info:
        await webhook_guard.read_capped_body(request)
    assert exc_info.value.status_code == 400


async def test_webhook_rate_limited_per_ip(client, fake_db, monkeypatch):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", "x")
    pipeline = app.state.redis.pipeline.return_value
    pipeline.execute = AsyncMock(
        return_value=[webhooks_router.HYPERSNAP_RATE_LIMIT + 1, True]
    )
    resp = await client.post("/v1/webhooks/hypersnap", content=b"{}")
    assert resp.status_code == 429
    assert "Retry-After" in resp.headers


async def test_webhook_failed_auth_budget_blocks_before_verification(
    client, fake_db, monkeypatch
):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", "x")
    verify = MagicMock(return_value=True)
    monkeypatch.setattr(webhooks_router, "verify_delivery_signature", verify)
    app.state.redis.get = AsyncMock(return_value=str(webhook_guard.AUTH_FAILURE_LIMIT))
    resp = await client.post("/v1/webhooks/hypersnap", content=b"{}")
    assert resp.status_code == 429
    verify.assert_not_called()


async def test_webhook_auth_failure_is_counted(client, fake_db, monkeypatch):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", "x")
    pipeline = app.state.redis.pipeline.return_value
    resp = await client.post("/v1/webhooks/hypersnap", content=b"{}")
    assert resp.status_code == 401
    incremented = [call.args[0] for call in pipeline.incr.call_args_list]
    assert any(
        key.startswith(webhook_guard.AUTH_FAILURE_KEY_PREFIX) for key in incremented
    )


async def test_record_auth_failure_tolerates_redis_errors():
    redis = MagicMock()
    redis.pipeline.side_effect = ConnectionError("down")
    await webhook_guard.record_auth_failure(redis, route="r", client_ip="1.2.3.4")


# ---------------------------------------------------------------------------
# Hypersnap replay windows
# ---------------------------------------------------------------------------


def test_hypersnap_dedupe_window_is_at_least_seven_days():
    assert webhooks_router.WEBHOOK_SEEN_TTL_SECONDS >= SEVEN_DAYS_SECONDS


def _reply_body() -> bytes:
    return json.dumps(
        {
            "type": "cast.created",
            "data": {"hash": HASH_REPLY, "parent_hash": HASH_ROOM},
        }
    ).encode()


async def test_room_reply_route_dedupes_replays(client, fake_db, monkeypatch):
    monkeypatch.setattr(
        settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", HYPERSNAP_SECRET
    )
    room = MagicMock(id="room-1", cast_hash=HASH_ROOM)
    fake_db.execute.return_value.scalars.return_value.first.return_value = room
    livekit = MagicMock(send_data=AsyncMock(), close=AsyncMock())
    monkeypatch.setattr(webhooks_router, "LiveKitService", lambda: livekit)
    body = _reply_body()
    headers = {"X-Hypersnap-Signature": _hypersnap_sign(body)}

    resp = await client.post("/v1/webhooks/hypersnap", content=body, headers=headers)
    assert resp.json() == {"status": "ok"}
    seen_key = app.state.redis.set.call_args.args[0]
    assert seen_key.startswith(webhooks_router.ROOM_REPLY_SEEN_KEY_PREFIX)
    assert HASH_REPLY in seen_key
    assert app.state.redis.set.call_args.kwargs == {
        "nx": True,
        "ex": webhooks_router.WEBHOOK_SEEN_TTL_SECONDS,
    }

    app.state.redis.set = AsyncMock(return_value=None)  # already seen
    resp = await client.post("/v1/webhooks/hypersnap", content=body, headers=headers)
    assert resp.json() == {"status": "duplicate"}
    assert livekit.send_data.await_count == 1


async def test_room_reply_dedupe_namespace_differs_from_notifications():
    """A reply delivered to both routes must not suppress the push."""
    assert webhooks_router.ROOM_REPLY_SEEN_KEY_PREFIX != (
        webhooks_router.WEBHOOK_SEEN_KEY_PREFIX + "cast:"
    )
    assert not (webhooks_router.WEBHOOK_SEEN_KEY_PREFIX + "cast:").startswith(
        webhooks_router.ROOM_REPLY_SEEN_KEY_PREFIX
    )


# ---------------------------------------------------------------------------
# Mini App failed-auth budgets are keyed on the real sender, not the proxy
# ---------------------------------------------------------------------------


def _failure_keys() -> list[str]:
    pipeline = app.state.redis.pipeline.return_value
    return [
        call.args[0]
        for call in pipeline.incr.call_args_list
        if call.args[0].startswith(webhook_guard.AUTH_FAILURE_KEY_PREFIX)
    ]


async def test_miniapp_envelope_failures_budgeted_per_sender_not_proxy(
    client, fake_db, active_key, proxy_secret
):
    """Forged envelopes must not burn a budget shared by every real client."""
    active_key.return_value = False
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(),
        headers={
            "X-Webhook-Secret": PROXY_SECRET,
            webhooks_router.MINIAPP_SENDER_IP_HEADER: "203.0.113.7",
        },
    )
    assert resp.status_code == 401
    assert _failure_keys() == [
        f"{webhook_guard.AUTH_FAILURE_KEY_PREFIX}"
        f"{webhooks_router.ROUTE_MINIAPP}:203.0.113.7"
    ]


async def test_miniapp_secret_failures_budgeted_on_proxy_key(
    client, fake_db, active_key, proxy_secret
):
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(),
        headers={
            "X-Webhook-Secret": "wrong",
            webhooks_router.MINIAPP_SENDER_IP_HEADER: "203.0.113.7",
        },
    )
    assert resp.status_code == 401
    keys = _failure_keys()
    assert len(keys) == 1
    assert keys[0].startswith(
        f"{webhook_guard.AUTH_FAILURE_KEY_PREFIX}"
        f"{webhooks_router.ROUTE_MINIAPP_PROXY}:"
    )
    assert "203.0.113.7" not in keys[0]


async def test_miniapp_ignores_malformed_sender_ip_header(
    client, fake_db, active_key, proxy_secret
):
    active_key.return_value = False
    resp = await client.post(
        "/v1/webhooks/miniapp",
        json=_envelope(),
        headers={
            "X-Webhook-Secret": PROXY_SECRET,
            webhooks_router.MINIAPP_SENDER_IP_HEADER: "not-an-ip",
        },
    )
    assert resp.status_code == 401
    keys = _failure_keys()
    assert len(keys) == 1
    assert "not-an-ip" not in keys[0]
