"""Per-route abuse limits added for PR-C (IP/fid limits, DoS caps)."""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from jose import jwt
from redis.exceptions import ConnectionError as RedisConnectionError
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.dependencies import (
    get_db,
    get_spam_service,
    pubsub_redis,
    require_non_demo_user,
)
from app.main import app
from app.middleware.auth import get_optional_current_user
from app.routers import auth as auth_router
from app.routers import feed as feed_router
from app.routers import rooms as rooms_router
from app.routers import spaces_discovery
from app.routers import voice_notes as voice_notes_router
from app.services import link_preview, voice_note_service
from app.services.link_preview import UnsafeUrlError, assert_public_url
from tests.direct_cast_fake import FakeRedis

FID = 777
PUBLIC_CLIENT = ("198.51.100.30", 4000)


def _bearer(fid: int = FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _exhaust(redis: FakeRedis, key: str, limit: int) -> None:
    redis.store[key] = (limit, time.monotonic() + 60)


async def _no_db():
    yield SimpleNamespace()


@pytest.fixture
def fake_redis(monkeypatch):
    redis = FakeRedis()
    previous = getattr(app.state, "redis", None)
    app.state.redis = redis
    monkeypatch.setattr(settings, "TRUSTED_PROXY_IPS", "")
    try:
        yield redis
    finally:
        app.state.redis = previous
        app.dependency_overrides.clear()


@pytest.fixture
async def http(fake_redis):
    """Client whose socket peer is a public address (not a trusted proxy)."""
    transport = ASGITransport(app=app, client=PUBLIC_CLIENT)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


# --- /health ---------------------------------------------------------------


async def test_health_reports_only_status(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert set(response.json()) == {"status"}


# --- POST /v1/feed/cast ----------------------------------------------------


@pytest.fixture
def cast_env(fake_redis, monkeypatch):
    app.dependency_overrides[require_non_demo_user] = lambda: FID
    app.dependency_overrides[get_db] = _no_db

    async def reached(*_args, **_kwargs):
        raise feed_router.HTTPException(status_code=418, detail="reached publish")

    monkeypatch.setattr(feed_router, "load_user_signer", reached)
    return fake_redis


@pytest.mark.parametrize("index", [0, 1])
async def test_create_cast_is_rate_limited_per_fid(cast_env, http, index):
    template, rule = feed_router.CAST_RATE_LIMITS[index]
    _exhaust(cast_env, template.format(fid=FID), rule.limit)
    response = await http.post("/v1/feed/cast", json={"text": "gm"})
    assert response.status_code == 429
    assert response.json()["detail"] == feed_router.CAST_RATE_LIMITED_DETAIL
    assert response.headers["retry-after"] == str(rule.window_seconds)


async def test_create_cast_under_limit_reaches_publish(cast_env, http):
    template, rule = feed_router.CAST_RATE_LIMITS[0]
    cast_env.store[template.format(fid=FID)] = (rule.limit - 1, None)
    response = await http.post("/v1/feed/cast", json={"text": "gm"})
    assert response.status_code == 418


# --- Thread publish / read buckets -----------------------------------------


def test_thread_publish_and_read_use_separate_keys():
    publish = feed_router.THREAD_PUBLISH_RATE_KEY.format(fid=FID)
    read = feed_router.THREAD_READ_RATE_KEY.format(fid=FID)
    assert publish != read


async def test_exhausted_thread_reads_do_not_block_publish(cast_env, http):
    _exhaust(
        cast_env,
        feed_router.THREAD_READ_RATE_KEY.format(fid=FID),
        feed_router.THREAD_READ_RATE_LIMIT_PER_MIN,
    )
    body = {"casts": [{"text": "one"}, {"text": "two"}]}
    response = await http.post("/v1/feed/cast/thread", json=body, headers=_bearer())
    assert response.status_code == 418  # got past the limiter to signer load


async def test_exhausted_thread_publish_does_not_block_reads(
    cast_env, http, monkeypatch
):
    _exhaust(
        cast_env,
        feed_router.THREAD_PUBLISH_RATE_KEY.format(fid=FID),
        feed_router.THREAD_RATE_LIMIT_PER_MIN,
    )
    app.dependency_overrides[get_spam_service] = lambda: SimpleNamespace()

    async def upstream(*_args, **_kwargs):
        raise feed_router.HTTPException(status_code=418, detail="reached upstream")

    monkeypatch.setattr(feed_router.hypersnap, "get", upstream)
    response = await http.get(
        "/v1/feed/cast/thread", params={"hash": "0xabc"}, headers=_bearer()
    )
    assert response.status_code == 418  # got past the read limiter
    assert cast_env.store[feed_router.THREAD_READ_RATE_KEY.format(fid=FID)][0] == 1


# --- GET /v1/feed/og -------------------------------------------------------


async def test_og_limit_is_shared_via_redis(fake_redis, http):
    _exhaust(
        fake_redis,
        feed_router.OG_RATE_KEY.format(fid=FID),
        feed_router.OG_RATE_LIMIT.limit,
    )
    response = await http.get(
        "/v1/feed/og", params={"url": "https://example.com"}, headers=_bearer()
    )
    assert response.status_code == 429
    assert not hasattr(feed_router, "_og_rate_limits")


async def test_og_unsafe_url_error_is_generic(fake_redis, http, monkeypatch):
    async def refuse(_client, _url):
        raise UnsafeUrlError("URL resolves to a blocked address")

    monkeypatch.setattr(feed_router, "fetch_link_preview", refuse)
    response = await http.get(
        "/v1/feed/og", params={"url": "https://internal.example"}, headers=_bearer()
    )
    assert response.status_code == 400
    assert response.json() == {"detail": feed_router.OG_URL_REJECTED_DETAIL}


# --- link_preview ports ----------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com:22/",
        "https://example.com:8443/",
        "http://example.com:6379",
        "http://example.com:99999/",
    ],
)
async def test_link_preview_refuses_non_web_ports(url, monkeypatch):
    def must_not_resolve():
        raise AssertionError("port check must run before DNS")

    monkeypatch.setattr(link_preview.asyncio, "get_running_loop", must_not_resolve)
    with pytest.raises(UnsafeUrlError):
        await assert_public_url(url)


@pytest.mark.parametrize(
    "url", ["http://example.com/", "http://example.com:80/", "https://example.com:443/"]
)
async def test_link_preview_allows_web_ports(url, monkeypatch):
    class _Loop:
        async def getaddrinfo(self, host, port):
            return [(None, None, None, None, ("93.184.216.34", 0))]

    monkeypatch.setattr(link_preview.asyncio, "get_running_loop", lambda: _Loop())
    await assert_public_url(url)


# --- GET /v1/auth/miniapp-nonce --------------------------------------------


async def test_miniapp_nonce_is_rate_limited_per_ip(fake_redis, http):
    rule = auth_router.MINIAPP_NONCE_RATE_LIMIT
    ok = await http.get("/v1/auth/miniapp-nonce")
    assert ok.status_code == 200
    key = f"{auth_router.MINIAPP_NONCE_RATE_PREFIX}{PUBLIC_CLIENT[0]}"
    assert fake_redis.store[key][0] == 1
    _exhaust(fake_redis, key, rule.limit)
    limited = await http.get(
        "/v1/auth/miniapp-nonce", headers={"X-Forwarded-For": "1.2.3.4"}
    )
    assert limited.status_code == 429  # spoofed XFF from a public peer ignored


# --- /v1/farcaster-spaces --------------------------------------------------


async def test_spaces_discovery_is_rate_limited_per_fid(fake_redis, http):
    _exhaust(
        fake_redis,
        spaces_discovery.DISCOVERY_RATE_KEY.format(fid=FID),
        spaces_discovery.DISCOVERY_RATE_LIMIT.limit,
    )
    response = await http.get("/v1/farcaster-spaces/live", headers=_bearer())
    assert response.status_code == 429


async def test_spaces_discovery_still_requires_auth(fake_redis, http):
    response = await http.get("/v1/farcaster-spaces/live")
    assert response.status_code in (401, 403)


# --- POST /v1/voice-notes/{id}/plays ---------------------------------------


@pytest.fixture
def plays_env(fake_redis, monkeypatch):
    app.dependency_overrides[get_db] = _no_db
    app.dependency_overrides[get_optional_current_user] = lambda: None
    recorded: list[dict] = []

    async def fake_record_play(**kwargs):
        recorded.append(kwargs)

    monkeypatch.setattr(voice_note_service, "record_play", fake_record_play)
    return SimpleNamespace(redis=fake_redis, recorded=recorded)


def _plays_path(note_id: uuid.UUID) -> str:
    return f"/v1/voice-notes/{note_id}/plays"


async def test_anonymous_play_dedupes_per_ip_for_a_day(plays_env, http):
    note = uuid.uuid4()
    body = {"listened_ms": 1000, "completed": False}
    first = await http.post(_plays_path(note), json=body)
    # Rotating a spoofed XFF from a public peer must not mint a fresh play.
    second = await http.post(
        _plays_path(note), json=body, headers={"X-Forwarded-For": "9.9.9.9"}
    )
    assert first.status_code == 201 and first.json() == {"status": "ok"}
    assert second.json() == {"status": "duplicate"}
    assert len(plays_env.recorded) == 1
    key = f"voice_notes:play_rate:ip:{PUBLIC_CLIENT[0]}:{note}"
    ttl = await plays_env.redis.ttl(key)
    assert ttl > voice_notes_router.PLAY_DEDUP_SECONDS
    assert ttl <= voice_notes_router.ANONYMOUS_PLAY_DEDUP_SECONDS


async def test_anonymous_plays_have_hourly_ip_budget(plays_env, http):
    _exhaust(
        plays_env.redis,
        f"voice_notes:anon_play_rl:{PUBLIC_CLIENT[0]}",
        voice_notes_router.ANONYMOUS_PLAY_RATE_LIMIT.limit,
    )
    response = await http.post(
        _plays_path(uuid.uuid4()), json={"listened_ms": 1, "completed": True}
    )
    assert response.status_code == 429
    assert plays_env.recorded == []


async def test_signed_in_play_dedupes_per_fid(plays_env, http):
    app.dependency_overrides[get_optional_current_user] = lambda: FID
    note = uuid.uuid4()
    body = {"listened_ms": 1000, "completed": False}
    assert (await http.post(_plays_path(note), json=body)).json() == {"status": "ok"}
    key = f"voice_notes:play_rate:fid:{FID}:{note}"
    assert 0 < await plays_env.redis.ttl(key) <= voice_notes_router.PLAY_DEDUP_SECONDS


async def test_play_listened_ms_is_bounded(plays_env, http):
    from app.schemas.voice_note import MAX_LISTENED_MS

    response = await http.post(
        _plays_path(uuid.uuid4()),
        json={"listened_ms": MAX_LISTENED_MS + 1, "completed": True},
    )
    assert response.status_code == 422
    assert plays_env.recorded == []


async def test_record_play_clamps_to_note_duration():
    class _Result:
        def one_or_none(self):
            return SimpleNamespace(duration_ms=30_000)

    class _Session:
        added: list = []

        async def execute(self, _stmt):
            return _Result()

        def add(self, row):
            self.added.append(row)

        async def commit(self):
            return None

    session = _Session()
    await voice_note_service.record_play(
        session,
        uuid.uuid4(),
        listener_fid=None,
        listened_ms=90_000,
        completed=True,
        source="app",
        user_agent=None,
    )
    assert session.added[0].listened_ms == 30_000


# --- WS /v1/rooms/events ---------------------------------------------------


def _room_events_key(ip: str = "testclient") -> str:
    return f"{rooms_router.ROOM_EVENTS_CONNECTION_KEY_PREFIX}{ip}"


def test_room_events_refuses_handshake_over_per_ip_cap(fake_redis, monkeypatch):
    monkeypatch.setattr(settings, "ROOM_EVENTS_WS_MAX_PER_IP", 1)
    fake_redis.store[_room_events_key()] = ({"other": time.time() + 60}, None)
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        TestClient(app).websocket_connect("/v1/rooms/events"),
    ):
        pass
    assert exc.value.code == rooms_router.WS_CLOSE_TOO_MANY_CONNECTIONS
    assert set(fake_redis.store[_room_events_key()][0]) == {"other"}


def test_room_events_streams_and_releases_lease(fake_redis, monkeypatch):
    monkeypatch.setattr(rooms_router, "ROOM_EVENTS_PING_SECONDS", 0.02)
    with TestClient(app).websocket_connect("/v1/rooms/events") as ws:
        assert ws.receive_json() == {"type": "ping"}
        assert len(fake_redis.store[_room_events_key()][0]) == 1
    assert fake_redis.store[_room_events_key()][0] == {}


def test_pubsub_uses_dedicated_pool_when_configured():
    command, pubsub = object(), object()
    state = SimpleNamespace(redis=command, redis_pubsub=pubsub)
    assert pubsub_redis(SimpleNamespace(state=state)) is pubsub
    fallback = SimpleNamespace(state=SimpleNamespace(redis=command))
    assert pubsub_redis(fallback) is command


class _ExhaustedPubSubPool:
    """A pubsub pool whose subscribe times out waiting for a connection."""

    def __init__(self) -> None:
        self.closed = 0

    def pubsub(self):
        pool = self

        class _PubSub:
            async def subscribe(self, *channels):
                raise RedisConnectionError("No connection available.")

            async def aclose(self):
                pool.closed += 1

        return _PubSub()


def test_room_events_pubsub_exhaustion_closes_quietly(fake_redis, monkeypatch):
    """A full pubsub pool fails only the new socket and frees its lease."""
    exhausted = _ExhaustedPubSubPool()
    monkeypatch.setattr(app.state, "redis_pubsub", exhausted, raising=False)
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        TestClient(app).websocket_connect("/v1/rooms/events") as ws,
    ):
        ws.receive_json()
    assert exc.value.code == 1011
    assert exhausted.closed == 1
    assert fake_redis.store[_room_events_key()][0] == {}
