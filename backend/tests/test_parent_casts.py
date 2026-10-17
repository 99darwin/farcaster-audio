"""Tests for attaching parent casts to replies in feed payloads."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

from app.services import parent_casts
from app.services.parent_casts import (
    MISSING_PARENT_SENTINEL,
    PARENT_CACHE_PREFIX,
    attach_parent_casts,
)
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401

PARENT_HASH = "0x" + "a" * 40
OTHER_PARENT_HASH = "0x" + "b" * 40


def _parent_cast(cast_hash: str, *, author_fid: int = 7) -> dict:
    return {
        "hash": cast_hash.removeprefix("0x"),
        "author": {
            "fid": author_fid,
            "username": "parent",
            "display_name": "Parent",
            "pfp_url": "https://example.com/p.png",
            "custody_address": "0xdead",
        },
        "text": "original thought",
        "timestamp": "2026-10-16T12:00:00Z",
        "reactions": {"likes_count": 3},
    }


def _route_parents(fake, parents: dict[str, dict]) -> None:
    def cast_lookup(params):
        parent = parents.get(params["identifier"])
        if parent is None:
            return 404, {"message": "not found"}
        return {"cast": parent}

    fake.route(f"{V2}/cast", cast_lookup)


def _reply(parent_hash: str | None, *, cast_hash: str = "0x1") -> dict:
    return {"hash": cast_hash, "author": {"fid": 1}, "parent_hash": parent_hash}


def _redis(cached: dict[str, str] | None = None) -> MagicMock:
    cached = cached or {}
    redis = MagicMock()
    redis.mget = AsyncMock(side_effect=lambda keys: [cached.get(k) for k in keys])
    pipe = MagicMock()
    pipe.execute = AsyncMock()
    redis.pipeline.return_value = pipe
    return redis


async def test_attaches_full_parent_cast_to_replies(fake_hypersnap):
    _route_parents(fake_hypersnap, {PARENT_HASH: _parent_cast(PARENT_HASH)})
    casts = [_reply(PARENT_HASH), _reply(None, cast_hash="0x2")]

    attached = await attach_parent_casts(casts, blocked_fids=set(), redis=None)

    parent = casts[0]["parent_cast"]
    assert parent["hash"] == PARENT_HASH
    assert parent["text"] == "original thought"
    assert parent["author"]["username"] == "parent"
    assert parent["reactions"] == {"likes_count": 3}
    assert attached == [parent]
    assert "parent_cast" not in casts[1]


async def test_looks_up_each_distinct_parent_once(fake_hypersnap):
    _route_parents(fake_hypersnap, {PARENT_HASH: _parent_cast(PARENT_HASH)})
    casts = [_reply(PARENT_HASH, cast_hash=f"0x{i}") for i in range(3)]

    await attach_parent_casts(casts, blocked_fids=set(), redis=None)

    assert len(fake_hypersnap.calls_to(f"{V2}/cast")) == 1
    assert all(cast["parent_cast"]["hash"] == PARENT_HASH for cast in casts)


async def test_skips_parent_by_blocked_author(fake_hypersnap):
    _route_parents(
        fake_hypersnap, {PARENT_HASH: _parent_cast(PARENT_HASH, author_fid=99)}
    )
    casts = [_reply(PARENT_HASH)]

    await attach_parent_casts(casts, blocked_fids={99}, redis=None)

    assert "parent_cast" not in casts[0]


async def test_missing_parent_is_left_off_and_cached(fake_hypersnap):
    _route_parents(fake_hypersnap, {})
    redis = _redis()
    casts = [_reply(PARENT_HASH)]

    await attach_parent_casts(casts, blocked_fids=set(), redis=redis)

    assert "parent_cast" not in casts[0]
    redis.pipeline.return_value.set.assert_called_once_with(
        PARENT_CACHE_PREFIX + PARENT_HASH,
        MISSING_PARENT_SENTINEL,
        ex=parent_casts.MISSING_PARENT_CACHE_TTL_SECONDS,
    )


async def test_hung_parent_lookup_does_not_block_others(fake_hypersnap, monkeypatch):
    monkeypatch.setattr(parent_casts, "PARENT_LOOKUP_TIMEOUT_SECONDS", 0.01)
    real_get = parent_casts.hypersnap.get

    async def get(path, params=None):
        if params and params.get("identifier") == OTHER_PARENT_HASH:
            await asyncio.sleep(1)
        return await real_get(path, params)

    monkeypatch.setattr(parent_casts.hypersnap, "get", get)
    _route_parents(fake_hypersnap, {PARENT_HASH: _parent_cast(PARENT_HASH)})
    casts = [_reply(PARENT_HASH), _reply(OTHER_PARENT_HASH, cast_hash="0x2")]

    await attach_parent_casts(casts, blocked_fids=set(), redis=None)

    assert casts[0]["parent_cast"]["hash"] == PARENT_HASH
    assert "parent_cast" not in casts[1]


async def test_transient_failure_is_not_cached(fake_hypersnap):
    fake_hypersnap.route(f"{V2}/cast", (503, {"message": "down"}))
    redis = _redis()
    casts = [_reply(PARENT_HASH)]

    await attach_parent_casts(casts, blocked_fids=set(), redis=redis)

    assert "parent_cast" not in casts[0]
    redis.pipeline.return_value.set.assert_not_called()


async def test_uses_cached_parent_without_upstream_call(fake_hypersnap):
    preview = {"hash": PARENT_HASH, "author": {"fid": 7}, "text": "cached"}
    redis = _redis({PARENT_CACHE_PREFIX + PARENT_HASH: json.dumps(preview)})
    casts = [_reply(PARENT_HASH)]

    await attach_parent_casts(casts, blocked_fids=set(), redis=redis)

    assert casts[0]["parent_cast"] == preview
    assert fake_hypersnap.calls_to(f"{V2}/cast") == []


async def test_malformed_parent_hash_is_not_looked_up(fake_hypersnap):
    casts = [_reply("0xnot-a-hash"), _reply("../../admin", cast_hash="0x2")]

    await attach_parent_casts(casts, blocked_fids=set(), redis=None)

    assert all("parent_cast" not in cast for cast in casts)
    assert fake_hypersnap.calls_to(f"{V2}/cast") == []


async def test_cached_missing_parent_skips_upstream(fake_hypersnap):
    redis = _redis({PARENT_CACHE_PREFIX + PARENT_HASH: MISSING_PARENT_SENTINEL})
    casts = [_reply(PARENT_HASH)]

    await attach_parent_casts(casts, blocked_fids=set(), redis=redis)

    assert "parent_cast" not in casts[0]
    assert fake_hypersnap.calls_to(f"{V2}/cast") == []
