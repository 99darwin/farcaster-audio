import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from jose import jwt

from app.clients import hypersnap
from app.config import settings
from app.dependencies import get_db, get_redis, get_spam_service
from app.main import app
from app.routers import feed as feed_router
from app.routers.feed import (
    BOOKMARK_PRUNE_STRIKES,
    BOOKMARK_RATE_LIMIT_PER_MIN,
    MAX_BOOKMARKS_PER_USER,
)
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from tests.hypersnap_fake import V2, fake_hypersnap, reactions_by_fid  # noqa: F401


def make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


MISSING_HASH = "0x" + "d" * 40


def _cast_lookup(params: dict[str, str]):
    identifier = params["identifier"]
    if identifier == MISSING_HASH:
        return 404, {"message": "not found"}
    # Hypersnap returns bare-hex hashes; the router normalizes them.
    return {
        "cast": {
            "hash": identifier.removeprefix("0x"),
            "author": {"fid": 1},
            "text": "hydrated bookmark",
        }
    }


@pytest.fixture
def hypersnap_routes(fake_hypersnap):
    fake_hypersnap.route(f"{V2}/cast", _cast_lookup)
    fake_hypersnap.route(
        f"{V2}/feed/following",
        {
            "casts": [
                {"hash": "a" * 40, "author": {"fid": 1}, "text": "bookmarked"},
                {"hash": "b" * 40, "author": {"fid": 2}, "text": "not bookmarked"},
            ],
            "next": {"cursor": None},
        },
    )
    fake_hypersnap.route(
        "/v1/reactionsByFid",
        lambda params: reactions_by_fid(
            ["0x" + "a" * 40] if params["reaction_type"] == "Like" else []
        ),
    )
    return fake_hypersnap


class _SpamService:
    async def annotate_casts(self, _casts):
        return None


def _mock_db(bookmarked: list[str] | None = None):
    scalar_result = MagicMock()
    scalar_result.scalars.return_value.all.return_value = bookmarked or []
    scalar_result.scalar_one.return_value = 0
    scalar_result.scalar_one_or_none.return_value = None
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()
    return db


def _mock_bookmark_list_db(bookmarks):
    scalar_result = MagicMock()
    scalar_result.scalars.return_value.all.return_value = bookmarks
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()
    return db


@pytest.fixture
def bookmark_overrides():
    db = _mock_db(["0x" + "a" * 40])

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


@pytest.mark.asyncio
async def test_bookmark_create_and_delete_are_idempotent(client, bookmark_overrides):
    cast_hash = "0x" + "c" * 40

    first_create = await client.post(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )
    second_create = await client.post(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )
    first_delete = await client.delete(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )
    second_delete = await client.delete(
        f"/v1/feed/bookmarks/{cast_hash}", headers=make_auth_header()
    )

    assert first_create.status_code == 201
    assert second_create.status_code == 201
    assert first_delete.status_code == 200
    assert second_delete.status_code == 200
    assert bookmark_overrides.commit.await_count == 4


@pytest.mark.asyncio
async def test_bookmark_write_rate_limit_returns_429(client, bookmark_overrides):
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.expire = MagicMock()
    pipe.execute = AsyncMock(return_value=[BOOKMARK_RATE_LIMIT_PER_MIN + 1, True])
    app.state.redis.pipeline = MagicMock(return_value=pipe)

    response = await client.post(
        f"/v1/feed/bookmarks/{'0x' + 'f' * 40}",
        headers=make_auth_header(),
    )

    assert response.status_code == 429


@pytest.mark.asyncio
async def test_bookmark_capacity_limit_returns_429(client):
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = None
    scalar_result.scalar_one.return_value = MAX_BOOKMARKS_PER_USER
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        response = await client.post(
            f"/v1/feed/bookmarks/{'0x' + '1' * 40}",
            headers=make_auth_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)

    assert response.status_code == 429
    assert db.commit.await_count == 0


@pytest.mark.asyncio
async def test_following_feed_adds_bookmarked_viewer_context(
    client, bookmark_overrides, hypersnap_routes
):
    response = await client.get("/v1/feed/following", headers=make_auth_header())

    assert response.status_code == 200
    casts = response.json()["casts"]
    assert casts[0]["hash"] == "0x" + "a" * 40
    assert casts[0]["viewer_context"] == {
        "liked": True,
        "recasted": False,
        "bookmarked": True,
    }
    assert casts[1]["viewer_context"] == {
        "liked": False,
        "recasted": False,
        "bookmarked": False,
    }


@pytest.mark.asyncio
async def test_bookmarks_list_returns_hydrated_bookmarked_casts(
    client, hypersnap_routes
):
    db = _mock_bookmark_list_db(
        [
            SimpleNamespace(cast_hash="0x" + "a" * 40),
            SimpleNamespace(cast_hash="0x" + "b" * 40),
            SimpleNamespace(cast_hash="0x" + "c" * 40),
        ]
    )

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        response = await client.get(
            "/v1/feed/bookmarks?limit=2",
            headers=make_auth_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)

    assert response.status_code == 200
    data = response.json()
    assert [cast["hash"] for cast in data["casts"]] == [
        "0x" + "a" * 40,
        "0x" + "b" * 40,
    ]
    assert data["next"]["cursor"] == "2"
    assert data["casts"][0]["viewer_context"] == {
        "liked": True,
        "recasted": False,
        "bookmarked": True,
    }


@pytest.mark.asyncio
async def test_bookmarks_list_skips_missing_casts(client, hypersnap_routes):
    db = _mock_bookmark_list_db(
        [
            SimpleNamespace(cast_hash="0x" + "d" * 40),
            SimpleNamespace(cast_hash="0x" + "e" * 40),
        ]
    )

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        response = await client.get(
            "/v1/feed/bookmarks",
            headers=make_auth_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)

    assert response.status_code == 200
    casts = response.json()["casts"]
    assert [cast["hash"] for cast in casts] == ["0x" + "e" * 40]
    assert casts[0]["viewer_context"]["bookmarked"] is True


@pytest.mark.asyncio
async def test_bookmarks_list_skips_casts_whose_lookup_fails(client, hypersnap_routes):
    """Hypersnap can time out on a deleted cast; one failure must not
    fail the whole page."""
    failing_hash = "0x" + "f" * 40

    def lookup(params):
        if params["identifier"] == failing_hash:
            return 503, {"message": "upstream timeout"}
        return _cast_lookup(params)

    hypersnap_routes.route(f"{V2}/cast", lookup)
    db = _mock_bookmark_list_db(
        [
            SimpleNamespace(cast_hash=failing_hash),
            SimpleNamespace(cast_hash="0x" + "e" * 40),
        ]
    )

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        response = await client.get("/v1/feed/bookmarks", headers=make_auth_header())
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)

    assert response.status_code == 200
    assert [c["hash"] for c in response.json()["casts"]] == ["0x" + "e" * 40]


@pytest.mark.asyncio
async def test_bookmarks_list_502_when_every_lookup_fails(client, hypersnap_routes):
    hypersnap_routes.route(f"{V2}/cast", (503, {"message": "down"}))
    db = _mock_bookmark_list_db([SimpleNamespace(cast_hash="0x" + "e" * 40)])

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        response = await client.get("/v1/feed/bookmarks", headers=make_auth_header())
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)

    assert response.status_code == 502


@pytest.mark.asyncio
async def test_bookmark_annotation_handles_thread_replies():
    root_hash = "0x" + "d" * 40
    reply_hash = "0x" + "e" * 40
    db = _mock_db([reply_hash])
    payload = {
        "conversation": {
            "cast": {
                "hash": root_hash,
                "author": {"fid": 1},
                "text": "root",
                "direct_replies": [
                    {
                        "hash": reply_hash,
                        "author": {"fid": 2},
                        "text": "reply",
                    }
                ],
            }
        }
    }

    await annotate_bookmarked_casts(db, 12345, payload)

    root = payload["conversation"]["cast"]
    reply = root["direct_replies"][0]
    assert root["viewer_context"] == {"bookmarked": False}
    assert reply["viewer_context"] == {"bookmarked": True}


# ---------------------------------------------------------------------------
# Unresponsive (deleted) bookmarked casts
# ---------------------------------------------------------------------------

HANGING_HASH = "0x" + "9" * 40
LIVE_HASH = "0x" + "e" * 40
HANGING_STRIKE_KEY = f"cast_bookmark:unresponsive:12345:{HANGING_HASH}"


class _StrikeRedis:
    """Async Redis stand-in for the bookmark strike counters."""

    def __init__(self) -> None:
        self.store: dict[str, object] = {}

    async def get(self, key):
        return self.store.get(key)

    async def mget(self, keys):
        return [self.store.get(key) for key in keys]

    def pipeline(self):
        return _StrikePipeline(self)

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def incr(self, key):
        self.store[key] = int(self.store.get(key, 0)) + 1
        return self.store[key]

    async def expire(self, key, _seconds):
        return key in self.store

    async def delete(self, *keys):
        for key in keys:
            self.store.pop(key, None)

    def expire_cooldowns(self) -> None:
        for key in [k for k in self.store if k.endswith(":cooldown")]:
            del self.store[key]


class _StrikePipeline:
    """Queues ``set`` calls and applies them on ``execute``."""

    def __init__(self, redis: _StrikeRedis) -> None:
        self._redis = redis
        self._ops: list[tuple] = []

    def set(self, key, value, ex=None):
        self._ops.append((key, value, ex))

    async def execute(self):
        return [
            await self._redis.set(key, value, ex=ex) for key, value, ex in self._ops
        ]


@pytest.fixture
def hanging_cast(hypersnap_routes, monkeypatch):
    """Make the HANGING_HASH lookup hang past the per-bookmark timeout."""
    monkeypatch.setattr(feed_router, "BOOKMARK_LOOKUP_TIMEOUT_SECONDS", 0.05)
    real_get = hypersnap.get

    async def get(path, params=None):
        if params and params.get("identifier") == HANGING_HASH:
            await asyncio.sleep(5)
        return await real_get(path, params)

    monkeypatch.setattr(hypersnap, "get", get)
    return hypersnap_routes


async def _list_bookmarks(client, db, redis, query: str = ""):
    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    app.dependency_overrides[get_redis] = lambda: redis
    try:
        return await client.get(
            f"/v1/feed/bookmarks{query}", headers=make_auth_header()
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)
        app.dependency_overrides.pop(get_redis, None)


def _deleted_hashes(db) -> list[list[str]]:
    """The hash lists of every ``DELETE`` the endpoint issued."""
    return [
        [v for v in call.args[0].compile().params.values() if isinstance(v, list)][0]
        for call in db.execute.await_args_list
        if call.args and call.args[0].__class__.__name__ == "Delete"
    ]


@pytest.mark.asyncio
async def test_hanging_bookmark_lookup_is_bounded(client, hanging_cast):
    db = _mock_bookmark_list_db(
        [SimpleNamespace(cast_hash=HANGING_HASH), SimpleNamespace(cast_hash=LIVE_HASH)]
    )
    redis = _StrikeRedis()

    started = time.monotonic()
    response = await _list_bookmarks(client, db, redis)

    assert time.monotonic() - started < 2
    assert response.status_code == 200
    assert [c["hash"] for c in response.json()["casts"]] == [LIVE_HASH]
    # One strike, not pruned yet.
    assert redis.store[HANGING_STRIKE_KEY] == 1
    assert _deleted_hashes(db) == []


@pytest.mark.asyncio
async def test_repeatedly_hanging_bookmark_is_pruned(client, hanging_cast):
    redis = _StrikeRedis()
    rows = [
        SimpleNamespace(cast_hash=HANGING_HASH),
        SimpleNamespace(cast_hash=LIVE_HASH),
        SimpleNamespace(cast_hash="0x" + "a" * 40),
    ]

    for _ in range(BOOKMARK_PRUNE_STRIKES - 1):
        db = _mock_bookmark_list_db(rows)
        # A reload inside the cooldown adds no strike.
        await _list_bookmarks(client, db, redis, "?limit=2")
        await _list_bookmarks(client, db, redis, "?limit=2")
        assert _deleted_hashes(db) == []
        redis.expire_cooldowns()

    db = _mock_bookmark_list_db(rows)
    response = await _list_bookmarks(client, db, redis, "?limit=2")

    assert _deleted_hashes(db) == [[HANGING_HASH]]
    assert HANGING_STRIKE_KEY not in redis.store
    # The pruned row no longer occupies an offset, so page 2 starts at 1.
    assert response.json()["next"]["cursor"] == "1"


@pytest.mark.asyncio
async def test_answering_bookmark_resets_strikes(client, hanging_cast):
    redis = _StrikeRedis()
    redis.store[f"cast_bookmark:unresponsive:12345:{LIVE_HASH}"] = 2
    db = _mock_bookmark_list_db([SimpleNamespace(cast_hash=LIVE_HASH)])

    response = await _list_bookmarks(client, db, redis)

    assert response.status_code == 200
    assert not [key for key in redis.store if key.startswith("cast_bookmark:")]


@pytest.mark.asyncio
async def test_no_strikes_when_every_lookup_fails(client, hanging_cast):
    """If nothing on the page answers, the node may be down: never prune."""
    redis = _StrikeRedis()
    db = _mock_bookmark_list_db([SimpleNamespace(cast_hash=HANGING_HASH)])

    response = await _list_bookmarks(client, db, redis)

    assert response.status_code == 502
    assert redis.store == {}
