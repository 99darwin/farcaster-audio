from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.main import app

# ---------------------------------------------------------------------------
# Test-only config overrides
# ---------------------------------------------------------------------------
#
# Production-sensitive defaults (SIWF domain allowlist, LiveKit credentials,
# Quick Auth audiences) are intentionally empty in `app.config.Settings` so
# open-source forks don't inherit upstream values. Tests assume a small set
# of sane fakes — set them here autouse so individual test files don't have
# to repeat the boilerplate. Using `monkeypatch.setattr` keeps the override
# scoped to one test: nothing leaks across tests or back into the real
# settings module.

# Domain used by `_siwe_msg(...)` helpers and the SIWF login test fixtures.
TEST_SIWF_DOMAIN = "juke.audio"
TEST_QUICKAUTH_AUDIENCE = "juke.audio"
TEST_LIVEKIT_API_KEY = "test-livekit-key"
TEST_LIVEKIT_API_SECRET = "test-livekit-secret-32-chars-long-xx"
TEST_LIVEKIT_WS_URL = "wss://test.livekit.local"


@pytest.fixture(autouse=True)
def _test_settings(monkeypatch):
    """Populate test-only defaults so tests don't depend on a `.env` file.

    None of these values should ever flow into production code paths — they
    only exist so the per-request domain/audience checks have something
    non-empty to match against, and so token-minting helpers can construct
    JWTs without raising on missing credentials.
    """
    monkeypatch.setattr(settings, "SIWF_DOMAIN", TEST_SIWF_DOMAIN)
    monkeypatch.setattr(
        settings, "QUICKAUTH_ALLOWED_AUDIENCES", TEST_QUICKAUTH_AUDIENCE
    )
    monkeypatch.setattr(settings, "LIVEKIT_API_KEY", TEST_LIVEKIT_API_KEY)
    monkeypatch.setattr(settings, "LIVEKIT_API_SECRET", TEST_LIVEKIT_API_SECRET)
    monkeypatch.setattr(settings, "LIVEKIT_WS_URL", TEST_LIVEKIT_WS_URL)


# ---------------------------------------------------------------------------
# LiveKit stub
# ---------------------------------------------------------------------------
#
# `LiveKitService` lazily constructs `livekit.api.LiveKitAPI` on first use,
# so simply instantiating the service is safe — the failure mode is calling
# any method that touches `self.api`. The service is held by a per-request
# dependency that always calls `await livekit.close()` in `finally`, and
# `close()` already short-circuits when `_api is None` (see
# `app/services/livekit_service.py`). That means tests which don't actually
# join/leave a room never need a network call.
#
# This fixture is available for tests that DO need to assert LiveKit
# interactions — they can patch the constructor to return this stub via
# `monkeypatch.setattr("app.routers.rooms.LiveKitService", lambda: stub)`
# (or similar). Most current room tests rely on auth/validation rejection
# before any LiveKit method runs, so they don't need this fixture.


class _StubLiveKitService:
    """No-op stand-in for `LiveKitService` in tests.

    Records calls on the AsyncMock methods so tests can assert against them
    without spinning up a real LiveKit instance.
    """

    def __init__(self):
        self.create_room = AsyncMock()
        self.delete_room = AsyncMock()
        self.mute_participant = AsyncMock()
        self.kick_participant = AsyncMock()
        self.update_permissions = AsyncMock()
        self.send_data = AsyncMock()
        self.start_room_composite_egress = AsyncMock(return_value="test-egress-id")
        self.stop_egress = AsyncMock()
        self.close = AsyncMock()
        self.generate_token = MagicMock(return_value="test-token")
        self.generate_anonymous_listener_token = MagicMock(
            return_value="test-anon-token"
        )


@pytest.fixture
def livekit_stub():
    """Fresh `_StubLiveKitService` instance — opt-in per-test."""
    return _StubLiveKitService()


@pytest.fixture
async def client():
    # Mock Redis since lifespan doesn't run in test transport
    mock_redis = AsyncMock()
    mock_redis.ping = AsyncMock(return_value=True)
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.set = AsyncMock()
    mock_redis.hset = AsyncMock()
    mock_redis.hget = AsyncMock(return_value=None)
    mock_redis.hgetall = AsyncMock(return_value={})
    mock_redis.hlen = AsyncMock(return_value=0)
    mock_redis.lrange = AsyncMock(return_value=[])
    mock_redis.rpush = AsyncMock()
    mock_redis.lrem = AsyncMock()
    mock_redis.llen = AsyncMock(return_value=0)
    mock_redis.zadd = AsyncMock()
    mock_redis.zrem = AsyncMock()
    mock_redis.zrevrange = AsyncMock(return_value=[])
    mock_redis.hdel = AsyncMock()
    mock_redis.delete = AsyncMock()
    mock_redis.publish = AsyncMock()
    mock_redis.close = AsyncMock()
    # Rate limiters that call redis.incr(...) directly (signer create/status,
    # auth login, etc.) expect an int back. Default to 1 so the first request
    # in any given test always falls under the threshold.
    mock_redis.incr = AsyncMock(return_value=1)
    mock_redis.expire = AsyncMock(return_value=True)
    mock_redis.ttl = AsyncMock(return_value=60)
    # Redis pipeline used for rate limiting (incr + expire then execute).
    # incr/expire are sync on a real pipeline; execute() returns the list of
    # results — give back (1, True) so rate limit checks see count=1.
    mock_pipeline = MagicMock()
    mock_pipeline.incr = MagicMock()
    mock_pipeline.expire = MagicMock()
    mock_pipeline.execute = AsyncMock(return_value=[1, True])
    mock_redis.pipeline = MagicMock(return_value=mock_pipeline)
    app.state.redis = mock_redis

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
