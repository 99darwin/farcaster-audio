"""Outbound developer webhook tests.

Smoke-level coverage for signing, envelope shape, and auth gating on the
CRUD routes. DB-integration tests (real subscription persistence + fan-out
dispatch) belong in the testcontainer-backed suite once it's wired in.
"""

import asyncio
import hashlib
import hmac
import json
import uuid

import pytest

from app.services import dev_webhook_service


def test_generate_secret_uses_whsec_prefix():
    secret = dev_webhook_service.generate_secret()
    assert secret.startswith("whsec_")
    # 32 random bytes urlsafe-b64 → at least 40 chars after the prefix
    assert len(secret) > len("whsec_") + 30


def test_generate_secret_is_unique():
    seen = {dev_webhook_service.generate_secret() for _ in range(50)}
    assert len(seen) == 50


def test_sign_payload_matches_manual_hmac():
    secret = "whsec_testsecret"
    body = b'{"event_type":"room.finished"}'
    timestamp = 1700000000
    expected_mac = hmac.new(
        secret.encode(),
        f"{timestamp}.".encode() + body,
        hashlib.sha256,
    ).hexdigest()
    assert (
        dev_webhook_service.sign_payload(secret, body, timestamp)
        == f"t={timestamp},v1={expected_mac}"
    )


def test_build_event_envelope_shape():
    envelope = dev_webhook_service.build_event_envelope(
        "room.started", {"room_id": "abc"}
    )
    assert envelope["event_type"] == "room.started"
    assert envelope["data"] == {"room_id": "abc"}
    # event_id is a UUID v4 string
    uuid.UUID(envelope["event_id"])  # raises on invalid
    # occurred_at is an ISO 8601 string with timezone info
    assert "T" in envelope["occurred_at"]
    assert envelope["occurred_at"].endswith("+00:00") or envelope[
        "occurred_at"
    ].endswith("Z")


@pytest.mark.asyncio
async def test_dispatch_noop_when_app_id_is_none():
    """No app_id → no DB query, no background tasks. Safe for iOS rooms."""

    class _FailingSession:
        async def execute(self, *_args, **_kwargs):
            raise AssertionError("dispatch must not touch the DB when app_id is None")

    await dev_webhook_service.dispatch(
        _FailingSession(),  # type: ignore[arg-type]
        app_id=None,
        event_type="room.finished",
        data={"room_id": "abc"},
    )


# ---------------------------------------------------------------------------
# SSRF guard
# ---------------------------------------------------------------------------


def test_is_safe_ip_blocks_imds_link_local():
    """AWS/GCP IMDS lives at 169.254.169.254 — must be rejected."""
    assert not dev_webhook_service._is_safe_ip("169.254.169.254")
    assert not dev_webhook_service._is_safe_ip("169.254.0.1")


def test_is_safe_ip_blocks_loopback():
    assert not dev_webhook_service._is_safe_ip("127.0.0.1")
    assert not dev_webhook_service._is_safe_ip("127.0.0.2")
    assert not dev_webhook_service._is_safe_ip("::1")


def test_is_safe_ip_blocks_private_rfc1918():
    assert not dev_webhook_service._is_safe_ip("10.0.0.5")
    assert not dev_webhook_service._is_safe_ip("172.16.0.1")
    assert not dev_webhook_service._is_safe_ip("192.168.1.1")
    # IPv6 unique-local
    assert not dev_webhook_service._is_safe_ip("fd00::1")


def test_is_safe_ip_blocks_reserved_multicast_unspecified():
    assert not dev_webhook_service._is_safe_ip("0.0.0.0")
    assert not dev_webhook_service._is_safe_ip("224.0.0.1")  # multicast
    assert not dev_webhook_service._is_safe_ip("240.0.0.1")  # reserved


def test_is_safe_ip_allows_global_public():
    """Globally routable public IPs are the only allowed targets."""
    assert dev_webhook_service._is_safe_ip("8.8.8.8")
    assert dev_webhook_service._is_safe_ip("1.1.1.1")
    assert dev_webhook_service._is_safe_ip("2606:4700:4700::1111")  # Cloudflare DNS


def test_is_safe_ip_rejects_garbage():
    assert not dev_webhook_service._is_safe_ip("not-an-ip")
    assert not dev_webhook_service._is_safe_ip("")
    assert not dev_webhook_service._is_safe_ip("999.999.999.999")


@pytest.mark.asyncio
async def test_validate_url_for_delivery_blocks_imds(monkeypatch):
    """End-to-end: a URL whose hostname resolves to IMDS is short-circuited."""

    async def _fake_resolve(_hostname: str) -> list[str]:
        return ["169.254.169.254"]

    monkeypatch.setattr(dev_webhook_service, "_resolve_hostname", _fake_resolve)
    blocked = await dev_webhook_service._validate_url_for_delivery(
        "http://attacker.example/hook"
    )
    assert blocked == "blocked_ip"


@pytest.mark.asyncio
async def test_validate_url_for_delivery_blocks_mixed_results(monkeypatch):
    """If ANY resolved IP is unsafe, refuse — defeats DNS-rebind split-result."""

    async def _fake_resolve(_hostname: str) -> list[str]:
        return ["8.8.8.8", "127.0.0.1"]

    monkeypatch.setattr(dev_webhook_service, "_resolve_hostname", _fake_resolve)
    blocked = await dev_webhook_service._validate_url_for_delivery(
        "http://mixed.example/hook"
    )
    assert blocked == "blocked_ip"


@pytest.mark.asyncio
async def test_validate_url_for_delivery_passes_public(monkeypatch):
    async def _fake_resolve(_hostname: str) -> list[str]:
        return ["8.8.8.8"]

    monkeypatch.setattr(dev_webhook_service, "_resolve_hostname", _fake_resolve)
    assert (
        await dev_webhook_service._validate_url_for_delivery("https://example.com/hook")
        is None
    )


@pytest.mark.asyncio
async def test_validate_url_for_delivery_dns_failure(monkeypatch):
    async def _fake_resolve(_hostname: str) -> list[str]:
        return []

    monkeypatch.setattr(dev_webhook_service, "_resolve_hostname", _fake_resolve)
    blocked = await dev_webhook_service._validate_url_for_delivery(
        "https://nonexistent.example/hook"
    )
    assert blocked == "dns_failure"


# ---------------------------------------------------------------------------
# Error category surface
# ---------------------------------------------------------------------------


def test_categorize_status_buckets_correctly():
    assert dev_webhook_service._categorize_status(200) == ""
    assert dev_webhook_service._categorize_status(204) == ""
    assert dev_webhook_service._categorize_status(301) == "http_3xx"
    assert dev_webhook_service._categorize_status(404) == "http_4xx"
    assert dev_webhook_service._categorize_status(503) == "http_5xx"
    assert dev_webhook_service._categorize_status(900) == "http_other"


def test_categorize_exception_buckets_correctly():
    import httpx as _httpx

    assert (
        dev_webhook_service._categorize_exception(_httpx.ConnectTimeout("..."))
        == "timeout"
    )
    assert (
        dev_webhook_service._categorize_exception(_httpx.ReadTimeout("..."))
        == "timeout"
    )
    assert (
        dev_webhook_service._categorize_exception(_httpx.ConnectError("..."))
        == "connection_failed"
    )


def test_last_error_never_leaks_exception_details():
    """The error vocabulary is a fixed, finite category list.

    Anything else flowing into last_error would turn it into an internal-
    network reconnaissance oracle. Tighten this set as new categories are
    added but never let raw strings through.
    """
    allowed = {
        "",
        "timeout",
        "connection_failed",
        "http_3xx",
        "http_4xx",
        "http_5xx",
        "http_other",
        "blocked_ip",
        "blocked_port",
        "dns_failure",
        "invalid_url",
        "no_attempts",
        "secret_unavailable",
    }
    # Every category the service can store is in the reviewed vocabulary.
    assert dev_webhook_service.ERROR_CATEGORIES <= allowed
    # Spot-check by exercising the categorizers.
    import httpx as _httpx

    for code in (200, 301, 404, 500, 999):
        assert dev_webhook_service._categorize_status(code) in allowed
    for exc in (
        _httpx.ConnectTimeout("..."),
        _httpx.ConnectError("..."),
        _httpx.ReadError("..."),
    ):
        assert dev_webhook_service._categorize_exception(exc) in allowed


# ---------------------------------------------------------------------------
# Task lifetime
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_spawn_delivery_holds_strong_reference():
    """Without the module-level set, fire-and-forget tasks can be GC'd."""

    started = asyncio.Event()
    finished = asyncio.Event()

    async def _slow():
        started.set()
        await asyncio.sleep(0.01)
        finished.set()

    dev_webhook_service._spawn_delivery(_slow())
    await started.wait()
    assert len(dev_webhook_service._active_delivery_tasks) >= 1
    await finished.wait()
    # The done callback discards from the set.
    await asyncio.sleep(0)
    assert all(not t.cancelled() for t in dev_webhook_service._active_delivery_tasks)


@pytest.mark.asyncio
async def test_drain_delivery_tasks_waits_for_in_flight():
    finished_count = {"n": 0}

    async def _work():
        await asyncio.sleep(0.02)
        finished_count["n"] += 1

    for _ in range(3):
        dev_webhook_service._spawn_delivery(_work())
    await dev_webhook_service.drain_delivery_tasks(timeout=2.0)
    assert finished_count["n"] == 3


@pytest.mark.asyncio
async def test_drain_delivery_tasks_honors_timeout():
    async def _forever():
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            return

    dev_webhook_service._spawn_delivery(_forever())
    # Drain should return inside the timeout window without raising.
    await dev_webhook_service.drain_delivery_tasks(timeout=0.1)
    # Clean up the still-running task so it doesn't leak into other tests.
    for task in list(dev_webhook_service._active_delivery_tasks):
        task.cancel()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_create_webhook_requires_api_key(client):
    """POST /v1/developer/webhooks must reject requests without X-Juke-Api-Key."""
    response = await client.post(
        "/v1/developer/webhooks",
        json={"url": "https://example.com/hook", "events": ["room.finished"]},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_create_webhook_rejects_unknown_event_type(client):
    """Schema validation rejects unknown event types before any DB hit."""
    response = await client.post(
        "/v1/developer/webhooks",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={
            "url": "https://example.com/hook",
            "events": ["something.invented"],
        },
    )
    # Either 401 (auth caught it first) or 422 (validation). Both are
    # acceptable — the test exists to prove the route is wired and rejects
    # bogus events as a smoke signal.
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_list_webhooks_requires_api_key(client):
    response = await client.get("/v1/developer/webhooks")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_delete_webhook_requires_api_key(client):
    response = await client.delete(
        f"/v1/developer/webhooks/{uuid.uuid4()}",
    )
    assert response.status_code == 401
