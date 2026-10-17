"""Tests for GET /v1/feed/cast/thread ancestor chain (chronological_parent_casts)."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from app.services.thread_ancestors import (
    fetch_thread_ancestors,
    trim_hidden_ancestors,
)
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401

VIEWER_FID = 12345
ROOT, MID, LEAF = ("1" * 40, "2" * 40, "3" * 40)


def _auth() -> dict[str, str]:
    token = jwt.encode(
        {"fid": VIEWER_FID, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _cast(cast_hash: str, parent: str | None, fid: int) -> dict:
    return {
        "hash": cast_hash,
        "parent_hash": parent,
        "author": {"fid": fid, "username": f"u{fid}"},
        "text": f"cast {cast_hash[:4]}",
        "timestamp": "2026-10-01T00:00:00Z",
    }


class _SpamService:
    async def annotate_thread(self, data):
        return data


@pytest.fixture
def overrides():
    result = MagicMock()
    result.scalars.return_value.all.return_value = []
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)

    async def _db():
        yield db

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


def _route_chain(fake, casts: dict[str, dict]) -> None:
    fake.route(
        f"{V2}/cast",
        lambda params: (
            {"cast": casts[params["identifier"].removeprefix("0x")]}
            if params["identifier"].removeprefix("0x") in casts
            else (404, {"message": "not found"})
        ),
    )


async def _get_thread(client, cast_hash: str):
    return await client.get(f"/v1/feed/cast/thread?hash=0x{cast_hash}", headers=_auth())


@pytest.mark.asyncio
async def test_thread_returns_ancestors_oldest_first(client, overrides, fake_hypersnap):
    fake_hypersnap.route(
        f"{V2}/cast/conversation",
        {"conversation": {"cast": _cast(LEAF, MID, 3)}},
    )
    _route_chain(fake_hypersnap, {MID: _cast(MID, ROOT, 2), ROOT: _cast(ROOT, None, 1)})

    response = await _get_thread(client, LEAF)

    assert response.status_code == 200
    ancestors = response.json()["conversation"]["chronological_parent_casts"]
    assert [a["hash"] for a in ancestors] == ["0x" + ROOT, "0x" + MID]


@pytest.mark.asyncio
async def test_root_cast_has_no_ancestors_and_no_lookups(
    client, overrides, fake_hypersnap
):
    fake_hypersnap.route(
        f"{V2}/cast/conversation",
        {"conversation": {"cast": _cast(ROOT, None, 1)}},
    )

    response = await _get_thread(client, ROOT)

    assert response.json()["conversation"]["chronological_parent_casts"] == []
    assert fake_hypersnap.calls_to(f"{V2}/cast") == []


@pytest.mark.asyncio
async def test_missing_parent_keeps_partial_chain(client, overrides, fake_hypersnap):
    fake_hypersnap.route(
        f"{V2}/cast/conversation",
        {"conversation": {"cast": _cast(LEAF, MID, 3)}},
    )
    # MID resolves but its parent ROOT is deleted upstream.
    _route_chain(fake_hypersnap, {MID: _cast(MID, ROOT, 2)})

    response = await _get_thread(client, LEAF)

    assert response.status_code == 200
    ancestors = response.json()["conversation"]["chronological_parent_casts"]
    assert [a["hash"] for a in ancestors] == ["0x" + MID]


@pytest.mark.asyncio
async def test_ancestor_walk_is_capped(fake_hypersnap):
    _route_chain(fake_hypersnap, {MID: _cast(MID, ROOT, 2), ROOT: _cast(ROOT, None, 1)})

    chain = await fetch_thread_ancestors(
        {"hash": "0x" + LEAF, "parent_hash": "0x" + MID},
        redis=_uncached_redis(),
        limit=1,
    )

    assert [a["hash"] for a in chain] == ["0x" + MID]


def _uncached_redis() -> AsyncMock:
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    return redis


@pytest.mark.asyncio
async def test_cached_ancestors_skip_upstream(fake_hypersnap):
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=json.dumps(_cast(MID, None, 2)))

    chain = await fetch_thread_ancestors(
        {"hash": LEAF, "parent_hash": MID}, redis=redis
    )

    assert [a["hash"] for a in chain] == [MID]
    assert fake_hypersnap.calls_to(f"{V2}/cast") == []
    redis.set.assert_not_called()


@pytest.mark.asyncio
async def test_fetched_ancestors_are_cached(fake_hypersnap):
    _route_chain(fake_hypersnap, {MID: _cast(MID, None, 2)})
    redis = _uncached_redis()

    await fetch_thread_ancestors({"hash": LEAF, "parent_hash": MID}, redis=redis)

    redis.set.assert_awaited_once()
    assert redis.set.await_args.kwargs["ex"] > 0


def test_trim_cuts_chain_at_nearest_spam_ancestor():
    root, mid = _cast(ROOT, None, 1), _cast(MID, ROOT, 2)
    mid["author"]["is_spam"] = True

    assert trim_hidden_ancestors([root, mid], blocked_fids=set()) == []
    assert trim_hidden_ancestors([root], blocked_fids=set()) == [root]


@pytest.mark.asyncio
async def test_blocked_ancestor_cuts_the_chain_above_it(
    client, overrides, fake_hypersnap
):
    fake_hypersnap.route(
        f"{V2}/cast/conversation",
        {"conversation": {"cast": _cast(LEAF, MID, 3)}},
    )
    _route_chain(fake_hypersnap, {MID: _cast(MID, ROOT, 2), ROOT: _cast(ROOT, None, 1)})

    # Blocking ROOT's author keeps MID; blocking MID's would leave nothing,
    # never ROOT drawn as if LEAF replied to it.
    with patch("app.routers.feed.get_blocked_fids", new=AsyncMock(return_value={1})):
        response = await _get_thread(client, LEAF)
    ancestors = response.json()["conversation"]["chronological_parent_casts"]
    assert [a["hash"] for a in ancestors] == ["0x" + MID]

    with patch("app.routers.feed.get_blocked_fids", new=AsyncMock(return_value={2})):
        response = await _get_thread(client, LEAF)
    assert response.json()["conversation"]["chronological_parent_casts"] == []
