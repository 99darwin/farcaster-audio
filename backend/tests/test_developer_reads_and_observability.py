"""Tier-1 ships from Marc's 2026-05-25 feedback list.

Covers:
- GET /v1/developer/spaces/{id}     (item #1, also subsumes #2)
- GET /v1/developer/webhooks/{id}   (item #5)
- X-Juke-Idempotency-Key header     (item #20)
- X-Juke-Rate-Limit-* headers       (item #27)

End-to-end HTTP tests use the asyncpg pool fixture cautiously — see
the comment in test_partner_tokens.py about the cross-event-loop pool
issue. Where applicable we use route-table + inspect.getsource
assertions to avoid the pool churn.
"""

import hashlib
import hmac
import json
import time
import uuid

import pytest

# ---------------------------------------------------------------------------
# Route registration sanity (item #1, #5)
# ---------------------------------------------------------------------------


def test_developer_get_space_route_is_registered():
    from app.main import app
    from tests.conftest import registered_route_pairs

    routes = registered_route_pairs(app)
    assert ("/v1/developer/spaces/{room_id}", "GET") in routes


def test_developer_get_webhook_route_is_registered():
    from app.main import app
    from tests.conftest import registered_route_pairs

    routes = registered_route_pairs(app)
    assert ("/v1/developer/webhooks/{webhook_id}", "GET") in routes


# ---------------------------------------------------------------------------
# Auth gating (no DB hit, no pool poisoning)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_developer_space_requires_api_key(client):
    response = await client.get(f"/v1/developer/spaces/{uuid.uuid4()}")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_get_developer_webhook_requires_api_key(client):
    response = await client.get(f"/v1/developer/webhooks/{uuid.uuid4()}")
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Cross-app enumeration oracle defense (handler source check)
# ---------------------------------------------------------------------------


def test_get_developer_space_returns_404_not_403_for_cross_app():
    """A partner probing for someone else's room UUID must see the
    same 404 as a fully unknown UUID — no 403 leak. Mirrors the
    end-developer-space and partner-agent-join handler patterns.
    """
    import inspect

    from app.routers.developer import get_developer_space

    src = inspect.getsource(get_developer_space)
    assert "row.created_by_app_id != verified_key.app_id" in src
    assert "HTTP_404_NOT_FOUND" in src
    assert "HTTP_403_FORBIDDEN" not in src


# ---------------------------------------------------------------------------
# X-Juke-Idempotency-Key (item #20)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deliver_once_sends_idempotency_key_header(monkeypatch):
    """Every outbound delivery (and every retry) carries the envelope's
    event_id as X-Juke-Idempotency-Key so consumers can dedupe without
    parsing the body."""
    from app.services import dev_webhook_service

    # Bypass SSRF check for the test target — it doesn't matter that the
    # URL never gets dialed; we're inspecting what httpx would have sent.
    async def _public_resolve(_hostname):
        return ["93.184.216.34"]

    monkeypatch.setattr(dev_webhook_service, "_resolve_hostname", _public_resolve)

    captured: dict = {}

    class _FakeResp:
        status_code = 200

    class _FakeClient:
        async def post(self, url, content, headers, timeout, extensions=None):
            captured["headers"] = headers
            captured["body"] = content
            return _FakeResp()

    body = json.dumps(
        {"event_id": "abc-123", "event_type": "room.started", "data": {}}
    ).encode()
    status_code, error = await dev_webhook_service._deliver_once(
        _FakeClient(),  # type: ignore[arg-type]
        "https://example.com/hook",
        "whsec_test",
        body,
        event_id="abc-123",
    )
    assert status_code == 200
    assert error == ""
    assert captured["headers"]["X-Juke-Idempotency-Key"] == "abc-123"
    # Signature still present — idempotency-key is additive, not a
    # replacement for HMAC.
    assert captured["headers"]["X-Juke-Signature"].startswith("t=")


def test_dispatch_extracts_event_id_and_threads_it_through():
    """Sanity-check the wiring: dispatch() must pull event_id off the
    envelope and pass it to _deliver_with_retry. Static read so we
    catch refactors that drop the kwarg."""
    import inspect

    from app.services.dev_webhook_service import dispatch

    src = inspect.getsource(dispatch)
    assert 'event_id = envelope["event_id"]' in src
    assert "event_id=event_id" in src


# ---------------------------------------------------------------------------
# Rate-limit response headers (item #27)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_check_rate_limit_status_returns_remaining_and_reset():
    """check_rate_limit_status is the canonical source for the headers.

    Returns a 4-tuple (allowed, retry_after, remaining, reset_in_seconds)
    so _enforce_rate_limit can populate response headers without a
    second Redis round-trip.
    """
    from unittest.mock import AsyncMock, MagicMock

    from app.services.redis_service import RedisService

    redis = AsyncMock()
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.expire = MagicMock()
    pipe.execute = AsyncMock(return_value=[3, True])  # attempts=3
    redis.pipeline = MagicMock(return_value=pipe)
    redis.ttl = AsyncMock(return_value=42)

    svc = RedisService(redis)
    allowed, retry_after, remaining, reset_in = await svc.check_rate_limit_status(
        "test_key", limit=10, window_seconds=60
    )
    assert allowed is True
    assert retry_after == 0
    assert remaining == 7  # 10 - 3
    assert reset_in == 42  # TTL value


@pytest.mark.asyncio
async def test_check_rate_limit_status_when_blocked():
    from unittest.mock import AsyncMock, MagicMock

    from app.services.redis_service import RedisService

    redis = AsyncMock()
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.expire = MagicMock()
    pipe.execute = AsyncMock(return_value=[15, True])  # attempts=15, over limit
    redis.pipeline = MagicMock(return_value=pipe)
    redis.ttl = AsyncMock(return_value=30)

    svc = RedisService(redis)
    allowed, retry_after, remaining, reset_in = await svc.check_rate_limit_status(
        "test_key", limit=10, window_seconds=60
    )
    assert allowed is False
    assert retry_after == 30
    assert remaining == 0
    assert reset_in == 30


@pytest.mark.asyncio
async def test_check_rate_limit_backward_compatible_2_tuple():
    """The legacy check_rate_limit wrapper still returns (allowed,
    retry_after) for any code that hasn't migrated."""
    from unittest.mock import AsyncMock, MagicMock

    from app.services.redis_service import RedisService

    redis = AsyncMock()
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.expire = MagicMock()
    pipe.execute = AsyncMock(return_value=[1, True])
    redis.pipeline = MagicMock(return_value=pipe)
    redis.ttl = AsyncMock(return_value=60)

    svc = RedisService(redis)
    result = await svc.check_rate_limit("test", 10, 60)
    assert len(result) == 2
    assert result == (True, 0)


def test_enforce_rate_limit_signature_accepts_response():
    """Static sanity that the helper accepts a Response param so the
    rate-limited routes can wire headers in without a wrapper."""
    import inspect

    from app.routers.developer import _enforce_rate_limit

    sig = inspect.signature(_enforce_rate_limit)
    assert "response" in sig.parameters
    # Default None so non-header-emitting callers don't have to pass it.
    assert sig.parameters["response"].default is None
