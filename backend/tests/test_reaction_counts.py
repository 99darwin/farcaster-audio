"""Tests for backfilling reaction counts Hypersnap's by-hash reads omit."""

import json

from app.services import reaction_counts
from app.services.reaction_counts import (
    REACTION_COUNTS_CACHE_PREFIX,
    REACTION_COUNTS_CACHE_TTL_SECONDS,
    hydrate_reaction_counts,
    invalidate_reaction_counts,
)
from tests.hypersnap_fake import fake_hypersnap  # noqa: F401

REACTIONS_BY_CAST_PATH = "/v1/reactionsByCast"
AUTHOR_FID = 99
HASH_A = "0x" + "a" * 40
HASH_B = "0x" + "b" * 40


def make_cast(cast_hash: str, *, likes: int = 0, recasts: int = 0) -> dict:
    return {
        "hash": cast_hash,
        "author": {"fid": AUTHOR_FID},
        "reactions": {
            "likes_count": likes,
            "recasts_count": recasts,
            "likes": [],
            "recasts": [],
        },
    }


def reactions_page(count: int, next_token: str = "") -> dict:
    return {
        "messages": [{"data": {}} for _ in range(count)],
        "nextPageToken": next_token,
    }


def counts_by_hash(table: dict[tuple[str, str], int]):
    """Route ``/v1/reactionsByCast`` to fixed counts keyed by (hash, type)."""

    def handler(params: dict[str, str]) -> dict:
        key = (params["target_hash"], params["reaction_type"])
        return reactions_page(table.get(key, 0))

    return handler


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def mget(self, keys):
        return [self.store.get(key) for key in keys]

    def pipeline(self):
        return _FakePipeline(self)

    async def delete(self, *keys):
        for key in keys:
            self.store.pop(key, None)


class _FakePipeline:
    def __init__(self, redis: _FakeRedis) -> None:
        self._redis = redis
        self._ops: list[tuple[str, str, int]] = []

    def set(self, key, value, ex=None):
        self._ops.append((key, value, ex))

    async def execute(self):
        for key, value, ex in self._ops:
            self._redis.store[key] = value
            self._redis.ttls[key] = ex


async def test_backfills_zero_counts_from_hub(fake_hypersnap):
    fake_hypersnap.route(
        REACTIONS_BY_CAST_PATH,
        counts_by_hash({(HASH_A, "Like"): 70, (HASH_A, "Recast"): 3}),
    )
    payload = {"conversation": {"cast": make_cast(HASH_A)}}

    await hydrate_reaction_counts(payload)

    reactions = payload["conversation"]["cast"]["reactions"]
    assert reactions["likes_count"] == 70
    assert reactions["recasts_count"] == 3
    params = fake_hypersnap.calls_to(REACTIONS_BY_CAST_PATH)[0].params
    assert params["target_fid"] == str(AUTHOR_FID)
    assert params["target_hash"] == HASH_A


async def test_keeps_larger_upstream_count(fake_hypersnap):
    # The hub misses pruned reactions, so it can undercount the indexer.
    fake_hypersnap.route(
        REACTIONS_BY_CAST_PATH, counts_by_hash({(HASH_A, "Like"): 564})
    )
    cast = make_cast(HASH_A, likes=1145, recasts=125)

    await hydrate_reaction_counts([cast])

    assert cast["reactions"]["likes_count"] == 1145
    assert cast["reactions"]["recasts_count"] == 125


async def test_follows_pages_up_to_cap(fake_hypersnap, monkeypatch):
    monkeypatch.setattr(reaction_counts, "MAX_REACTION_COUNT_PAGES", 2)

    def handler(params: dict[str, str]) -> dict:
        if params["reaction_type"] != "Like":
            return reactions_page(0)
        return reactions_page(5, next_token="more")

    fake_hypersnap.route(REACTIONS_BY_CAST_PATH, handler)
    cast = make_cast(HASH_A)

    await hydrate_reaction_counts([cast])

    assert cast["reactions"]["likes_count"] == 10
    like_calls = [
        c
        for c in fake_hypersnap.calls_to(REACTIONS_BY_CAST_PATH)
        if c.params["reaction_type"] == "Like"
    ]
    assert [c.params.get("pageToken") for c in like_calls] == [None, "more"]


async def test_duplicate_casts_are_counted_once(fake_hypersnap):
    fake_hypersnap.route(REACTIONS_BY_CAST_PATH, counts_by_hash({(HASH_A, "Like"): 4}))
    first, second = make_cast(HASH_A), make_cast(HASH_A)

    await hydrate_reaction_counts([first, second])

    assert first["reactions"]["likes_count"] == 4
    assert second["reactions"]["likes_count"] == 4
    assert len(fake_hypersnap.calls_to(REACTIONS_BY_CAST_PATH)) == 2


async def test_upstream_failure_leaves_counts_and_skips_cache(fake_hypersnap):
    fake_hypersnap.route(REACTIONS_BY_CAST_PATH, (500, {}))
    redis = _FakeRedis()
    cast = make_cast(HASH_A, likes=2)

    await hydrate_reaction_counts([cast], redis=redis)

    assert cast["reactions"]["likes_count"] == 2
    assert redis.store == {}


async def test_counts_are_cached_and_reused(fake_hypersnap):
    fake_hypersnap.route(REACTIONS_BY_CAST_PATH, counts_by_hash({(HASH_A, "Like"): 7}))
    redis = _FakeRedis()

    await hydrate_reaction_counts([make_cast(HASH_A)], redis=redis)
    key = REACTION_COUNTS_CACHE_PREFIX + HASH_A
    assert json.loads(redis.store[key]) == {"likes": 7, "recasts": 0}
    assert redis.ttls[key] == REACTION_COUNTS_CACHE_TTL_SECONDS

    fake_hypersnap.calls.clear()
    cast = make_cast(HASH_A)
    await hydrate_reaction_counts([cast], redis=redis)
    assert cast["reactions"]["likes_count"] == 7
    assert fake_hypersnap.calls == []


async def test_invalidate_drops_cached_counts():
    redis = _FakeRedis()
    redis.store[REACTION_COUNTS_CACHE_PREFIX + HASH_B] = "{}"

    # Keys are lowercase; writes may carry mixed-case hashes.
    await invalidate_reaction_counts(redis, "0x" + "B" * 40)

    assert redis.store == {}


async def test_counted_casts_are_bounded(fake_hypersnap, monkeypatch):
    monkeypatch.setattr(reaction_counts, "MAX_COUNTED_CASTS", 1)
    fake_hypersnap.route(
        REACTIONS_BY_CAST_PATH,
        counts_by_hash({(HASH_A, "Like"): 1, (HASH_B, "Like"): 1}),
    )
    first, second = make_cast(HASH_A), make_cast(HASH_B)

    await hydrate_reaction_counts([first, second])

    assert first["reactions"]["likes_count"] == 1
    assert second["reactions"]["likes_count"] == 0


async def test_casts_without_author_are_skipped(fake_hypersnap):
    await hydrate_reaction_counts([{"hash": HASH_A, "text": "no author"}])

    assert fake_hypersnap.calls_to(REACTIONS_BY_CAST_PATH) == []
