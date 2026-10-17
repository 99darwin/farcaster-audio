"""Tests for ``FarcasterSpacesService`` — the service-FID bearer mint
+ read-only proxy to ``client.farcaster.xyz``.

We pin down:

1. The mint flow signs the canonical-sorted JSON payload and produces
   an ``eip191:<base64>`` Authorization header.
2. The bearer is cached in-process and only re-minted within the
   refresh threshold.
3. Each discovery method parses upstream envelopes correctly,
   including denormalized ``pfp.url`` → ``pfpUrl`` collapsing.
4. 5xx and network errors are retried with exponential backoff.
5. Missing config raises ``FarcasterSpacesConfigError``.
6. The bearer secret + signed signature are never written to a log
   record (defends against future refactor regressions).

These tests use ``httpx.MockTransport`` to intercept requests at the
transport layer — no real network. The service's ``_get_http_client``
is monkeypatched to return a transport-backed client. ``eth-account``
runs for real so we exercise the signing path end-to-end.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct

from app.config import Settings
from app.schemas.farcaster_spaces import FarcasterSpacesConfigError
from app.services import farcaster_spaces_service as fcsp_mod
from app.services.farcaster_spaces_service import (
    FarcasterSpacesService,
    _canonicalize,
)

# A test-only secp256k1 key. Not associated with any real FID; signing
# works mechanically regardless of FID.
TEST_PRIVATE_KEY = "0x" + "11" * 32
TEST_ADDRESS = Account.from_key(TEST_PRIVATE_KEY).address


def _make_settings(**overrides: Any) -> Settings:
    """Build a Settings instance bypassing .env discovery.

    Pydantic-settings normally reads env files at construction; we
    override individual fields directly. The tests run in isolation so
    process env vars do not bleed in.
    """
    defaults: dict[str, Any] = {
        "JUKE_FARCASTER_CUSTODY_PRIVATE_KEY": TEST_PRIVATE_KEY,
        "JUKE_FARCASTER_FID": 999_999,
        "JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS": 24,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _install_transport(
    service: FarcasterSpacesService,
    handler: Callable[[httpx.Request], httpx.Response],
) -> list[httpx.Request]:
    """Replace the service's httpx client with a MockTransport-backed
    one and return a list that will accumulate every captured request.
    """
    captured: list[httpx.Request] = []

    def _capture(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_capture)
    # Force-close any pre-existing client (none expected; defensive).
    service._client = httpx.AsyncClient(
        transport=transport, timeout=10.0, follow_redirects=False
    )
    return captured


def _mint_response(
    *,
    secret: str = "tok_" + "a" * 32,
    expires_at_ms: int | None = None,
) -> httpx.Response:
    if expires_at_ms is None:
        expires_at_ms = int(time.time() * 1000) + 1000 * 86400 * 1000
    return httpx.Response(
        200,
        json={"result": {"token": {"secret": secret, "expiresAt": expires_at_ms}}},
    )


# ---------------------------------------------------------------------
# 1. mint signs the canonical payload
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mint_bearer_signs_canonical_payload():
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)

    def handler(req: httpx.Request) -> httpx.Response:
        # Verify endpoint, method, headers.
        assert req.method == "PUT"
        assert str(req.url) == ("https://client.farcaster.xyz/v2/onboarding-state")
        auth = req.headers.get("authorization", "")
        assert auth.startswith("Bearer eip191:")
        b64 = auth.removeprefix("Bearer eip191:")
        sig_bytes = base64.b64decode(b64)
        assert len(sig_bytes) == 65

        # Body must contain authRequest as posted.
        body = json.loads(req.content)
        assert "authRequest" in body
        assert body["authRequest"]["method"] == "generateToken"
        assert "timestamp" in body["authRequest"]["params"]
        assert "expiresAt" in body["authRequest"]["params"]

        # The signed payload is the CANONICAL form of authRequest.
        canonical = _canonicalize(body["authRequest"])
        recovered = Account.recover_message(
            encode_defunct(text=canonical),
            signature=sig_bytes,
        )
        assert recovered.lower() == TEST_ADDRESS.lower()
        return _mint_response()

    _install_transport(svc, handler)
    bearer = await svc._mint_service_bearer()
    assert bearer.startswith("tok_")
    assert svc._bearer_expires_at_ms is not None
    await svc.aclose()


# ---------------------------------------------------------------------
# 2. cache + refresh window
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_bearer_caches_until_refresh_window():
    # 1h refresh threshold so we can construct expiry inside/outside.
    settings = _make_settings(JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS=1)
    svc = FarcasterSpacesService(settings)
    mint_calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal mint_calls
        mint_calls += 1
        # Far future expiry — well outside the 1h refresh window.
        return _mint_response(
            secret=f"tok_call_{mint_calls}",
            expires_at_ms=int(time.time() * 1000) + 10 * 60 * 60 * 1000,
        )

    _install_transport(svc, handler)

    first = await svc._get_bearer()
    second = await svc._get_bearer()
    assert first == second == "tok_call_1"
    assert mint_calls == 1, "second call should hit cache"

    # Force the cached bearer into the refresh window.
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 30 * 60 * 1000
    third = await svc._get_bearer()
    assert third == "tok_call_2"
    assert mint_calls == 2

    await svc.aclose()


# ---------------------------------------------------------------------
# 3. envelope parsing — live rooms with denormalized pfp
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_live_rooms_parses_envelope():
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    # Seed a pre-minted bearer so the first call goes straight to the
    # discovery endpoint.
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "GET"
        assert "/v1/audio-rooms?limit=" in str(req.url)
        return httpx.Response(
            200,
            json={
                "result": {
                    "rooms": [
                        {
                            "id": "rm_abc",
                            "title": "Hello world",
                            "host": {
                                "fid": 17,
                                "username": "alice",
                                "displayName": "Alice",
                                "pfp": {"url": "https://img/alice.jpg"},
                            },
                            "state": "live",
                            "startedAt": "2026-05-30T12:00:00Z",
                            "listenerCount": 42,
                            "channelKey": "audio",
                            "rootCastHash": "0xdeadbeef",
                            "rootCastFid": 17,
                        }
                    ]
                }
            },
        )

    _install_transport(svc, handler)
    rooms = await svc.list_live_rooms(limit=15)
    assert len(rooms) == 1
    r = rooms[0]
    assert r.id == "rm_abc"
    assert r.title == "Hello world"
    assert r.state == "live"
    assert r.listener_count == 42
    assert r.channel_key == "audio"
    assert r.root_cast_hash == "0xdeadbeef"
    assert r.root_cast_fid == 17
    assert r.host.fid == 17
    assert r.host.username == "alice"
    assert r.host.display_name == "Alice"
    assert r.host.pfp_url == "https://img/alice.jpg"
    await svc.aclose()


# ---------------------------------------------------------------------
# 4. scheduled rooms
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_scheduled_rooms():
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v1/audio-rooms/scheduled?limit=" in str(req.url)
        return httpx.Response(
            200,
            json={
                "result": {
                    "rooms": [
                        {
                            "id": "rm_sched",
                            "host": {
                                "fid": 8,
                                "username": "bob",
                                "pfpUrl": "https://img/bob.jpg",
                            },
                            "state": "scheduled",
                            "scheduledAt": "2026-06-01T18:00:00Z",
                        }
                    ]
                }
            },
        )

    _install_transport(svc, handler)
    rooms = await svc.list_scheduled_rooms()
    assert len(rooms) == 1
    assert rooms[0].state == "scheduled"
    assert rooms[0].host.pfp_url == "https://img/bob.jpg"
    await svc.aclose()


# ---------------------------------------------------------------------
# 5. get_room returns None on 404
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_room_returns_none_on_404():
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v1/audio-room?roomId=" in str(req.url)
        return httpx.Response(404, json={"error": "not found"})

    _install_transport(svc, handler)
    assert await svc.get_room("rm_missing") is None
    await svc.aclose()


# ---------------------------------------------------------------------
# 6. get_participants
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_participants():
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v1/audio-room/participants?roomId=" in str(req.url)
        return httpx.Response(
            200,
            json={
                "result": {
                    "participants": [
                        {
                            "user": {
                                "fid": 1,
                                "username": "host",
                                "pfp": {"url": "https://img/h.jpg"},
                            },
                            "role": "host",
                            "joinedAt": "2026-05-30T12:00:00Z",
                        },
                        {
                            "user": {"fid": 2, "username": "guest"},
                            "role": "listener",
                            "handRaised": True,
                        },
                    ]
                }
            },
        )

    _install_transport(svc, handler)
    ps = await svc.get_participants("rm_abc")
    assert len(ps) == 2
    assert ps[0].role == "host"
    assert ps[0].user.pfp_url == "https://img/h.jpg"
    assert ps[1].hand_raised is True
    await svc.aclose()


# ---------------------------------------------------------------------
# 7. get_chat
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_chat():
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v1/audio-room/chat?roomId=" in str(req.url)
        return httpx.Response(
            200,
            json={
                "result": {
                    "messages": [
                        {
                            "id": "m1",
                            "fid": 17,
                            "text": "gm",
                            "createdAt": "2026-05-30T12:01:00Z",
                            "user": {"fid": 17, "username": "alice"},
                        }
                    ]
                }
            },
        )

    _install_transport(svc, handler)
    msgs = await svc.get_chat("rm_abc")
    assert len(msgs) == 1
    assert msgs[0].text == "gm"
    assert msgs[0].user is not None and msgs[0].user.fid == 17
    await svc.aclose()


# ---------------------------------------------------------------------
# 8. 5xx retries then fails
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_5xx_retries_then_fails(monkeypatch):
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    # Don't actually sleep between retries.
    async def _no_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(fcsp_mod.asyncio, "sleep", _no_sleep)

    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(502, json={"error": "bad gateway"})

    _install_transport(svc, handler)
    with pytest.raises(httpx.HTTPStatusError):
        await svc.list_live_rooms()
    assert calls == 3
    await svc.aclose()


# ---------------------------------------------------------------------
# 9. network error retries
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_network_error_retries(monkeypatch):
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    async def _no_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(fcsp_mod.asyncio, "sleep", _no_sleep)

    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("boom")

    _install_transport(svc, handler)
    with pytest.raises(httpx.TransportError):
        await svc.list_live_rooms()
    assert calls == 3
    await svc.aclose()


# ---------------------------------------------------------------------
# 10. missing config
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_config_raises_config_error():
    settings = _make_settings(JUKE_FARCASTER_CUSTODY_PRIVATE_KEY="")
    svc = FarcasterSpacesService(settings)
    with pytest.raises(FarcasterSpacesConfigError):
        await svc._get_bearer()
    # _mint_service_bearer also rejects.
    with pytest.raises(FarcasterSpacesConfigError):
        await svc._mint_service_bearer()
    await svc.aclose()


# ---------------------------------------------------------------------
# 11. bearer / signature never logged
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bearer_never_in_logs(caplog):
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    bearer_secret = "tok_super_secret_" + "x" * 32

    captured_sigs: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        auth = req.headers.get("authorization", "")
        # Capture the eip191:<base64> string so we can assert it never
        # ends up in any log record.
        if auth.startswith("Bearer eip191:"):
            captured_sigs.append(auth.removeprefix("Bearer "))
        return _mint_response(secret=bearer_secret)

    _install_transport(svc, handler)
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger="app.services.farcaster_spaces_service"):
        minted = await svc._mint_service_bearer()
    assert minted == bearer_secret

    log_blob = "\n".join(rec.getMessage() for rec in caplog.records)
    assert bearer_secret not in log_blob, "bearer secret leaked into a log record"
    for sig in captured_sigs:
        assert sig not in log_blob, "signed eip191 signature leaked into a log record"
    await svc.aclose()


# ---------------------------------------------------------------------
# 12. exception sanitization — Authorization stripped from request
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mint_failure_redacts_authorization_from_exception(monkeypatch):
    """An upstream 4xx during mint must surface an HTTPStatusError whose
    ``request.headers`` no longer contains the eip191 signature.

    Defense against future logger.exception / Sentry capture paths that
    would otherwise surface the outbound signature through the
    exception's attached request object.
    """
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    _install_transport(svc, handler)
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await svc._mint_service_bearer()
    req = exc_info.value.request
    assert req is not None
    assert "authorization" not in {k.lower() for k in req.headers.keys()}
    await svc.aclose()


@pytest.mark.asyncio
async def test_get_envelope_failure_redacts_authorization_from_exception(monkeypatch):
    """Same guard, but on the discovery GET path."""
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "tok_secret_abcdefghijk"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    async def _no_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(fcsp_mod.asyncio, "sleep", _no_sleep)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "down"})

    _install_transport(svc, handler)
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await svc.list_live_rooms()
    req = exc_info.value.request
    assert req is not None
    assert "authorization" not in {k.lower() for k in req.headers.keys()}
    await svc.aclose()


# ---------------------------------------------------------------------
# 13. scheduled-room create wire format + start-scheduled go-live
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_audio_room_sends_scheduled_at_as_iso_string():
    """Regression: the upstream ``POST /v1/audio-rooms`` create rejects an
    epoch-millis integer with ``"scheduledAt must be a valid future
    timestamp"`` and returns the field in ISO-8601 form itself. We must
    send ``scheduledAt`` as an ISO string, NOT an int — this is the bug
    that broke scheduling a Farcaster space from Juke."""
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)
    svc._bearer_secret = "test_bearer"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        assert str(req.url) == "https://client.farcaster.xyz/v1/audio-rooms"
        body = json.loads(req.content)
        # The crux: scheduledAt is a STRING, not an integer.
        assert isinstance(body["scheduledAt"], str)
        assert body["scheduledAt"] == "2026-06-01T18:00:00Z"
        return httpx.Response(
            200,
            json={
                "result": {
                    "room": {
                        "id": "rm_sched",
                        "title": "Future show",
                        "host": {"fid": 17, "username": "alice"},
                        "state": "scheduled",
                        "scheduledAt": "2026-06-01T18:00:00Z",
                    }
                }
            },
        )

    _install_transport(svc, handler)
    room = await svc.create_audio_room(
        title="Future show",
        scheduled_at=datetime(2026, 6, 1, 18, 0, 0, tzinfo=timezone.utc),
    )
    assert room.id == "rm_sched"
    assert room.state == "scheduled"
    await svc.aclose()


@pytest.mark.asyncio
async def test_start_scheduled_audio_room_posts_and_returns_live_room():
    """``start_scheduled_audio_room`` POSTs ``{roomId}`` to
    ``/v1/audio-room/start-scheduled`` with the caller-supplied bearer and
    returns the parsed (now-live) room."""
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        assert str(req.url) == (
            "https://client.farcaster.xyz/v1/audio-room/start-scheduled"
        )
        # User-FID host mode: the caller's bearer is forwarded verbatim,
        # NOT the service bearer (which is never minted here).
        assert req.headers["authorization"] == "Bearer user-jfs-bearer"
        body = json.loads(req.content)
        assert body == {"roomId": "rm_sched"}
        return httpx.Response(
            200,
            json={
                "result": {
                    "room": {
                        "id": "rm_sched",
                        "title": "Future show",
                        "host": {"fid": 17, "username": "alice"},
                        "state": "live",
                        "startedAt": "2026-06-01T18:00:05Z",
                    }
                }
            },
        )

    _install_transport(svc, handler)
    room = await svc.start_scheduled_audio_room("rm_sched", bearer="user-jfs-bearer")
    assert room is not None
    assert room.id == "rm_sched"
    assert room.state == "live"
    await svc.aclose()


@pytest.mark.asyncio
async def test_start_scheduled_audio_room_raises_on_4xx(monkeypatch):
    """A 4xx (e.g. not the host / not scheduled) surfaces as
    ``HTTPStatusError`` so the router can translate it — and the
    Authorization header is stripped from the captured request."""
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)

    async def _no_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(fcsp_mod.asyncio, "sleep", _no_sleep)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"errors": [{"message": "not host"}]})

    _install_transport(svc, handler)
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await svc.start_scheduled_audio_room("rm_sched", bearer="b")
    req = exc_info.value.request
    assert req is not None
    assert "authorization" not in {k.lower() for k in req.headers.keys()}
    await svc.aclose()


# ---------------------------------------------------------------------
# accept/remove-speaker payloads must carry ``fid`` (upstream requirement)
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_accept_speaker_as_user_sends_fid():
    """Regression: Farcaster's /v1/audio-room/accept-speaker requires the
    target as ``fid``. Sending only ``targetFid`` yields a 400
    ("must have required property 'fid'") — which surfaced as a 502 on
    native promote. The payload must include ``fid``."""
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/v1/audio-room/accept-speaker"
        body = json.loads(req.content)
        assert body.get("fid") == 42
        assert body.get("roomId") == "rm_abc"
        return httpx.Response(200, json={"result": {}})

    _install_transport(svc, handler)
    await svc.accept_speaker_as_user(room_id="rm_abc", target_fid=42, bearer="b")
    await svc.aclose()


@pytest.mark.asyncio
async def test_remove_speaker_as_user_sends_fid():
    """Symmetric to accept-speaker — remove-speaker also targets by ``fid``."""
    settings = _make_settings()
    svc = FarcasterSpacesService(settings)

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/v1/audio-room/remove-speaker"
        body = json.loads(req.content)
        assert body.get("fid") == 42
        return httpx.Response(200, json={"result": {}})

    _install_transport(svc, handler)
    await svc.remove_speaker_as_user(room_id="rm_abc", target_fid=42, bearer="b")
    await svc.aclose()
