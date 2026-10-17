"""Shared fixed-window limiter and concurrent-connection leases."""

import time

import pytest
from fastapi import HTTPException

from app.services.rate_limit import (
    RateLimit,
    enforce_rate_limits,
    is_over_limit,
    try_acquire_connection_lease,
)
from tests.direct_cast_fake import FakeRedis

KEY = "test:lease"


async def test_fixed_window_counts_and_arms_ttl_once():
    redis = FakeRedis()
    rule = RateLimit(limit=2, window_seconds=60)
    assert not await is_over_limit(redis, "k", rule)
    first_expiry = redis.store["k"][1]
    assert not await is_over_limit(redis, "k", rule)
    assert redis.store["k"][1] == first_expiry  # EXPIRE NX: window not extended
    assert await is_over_limit(redis, "k", rule)


async def test_enforce_rate_limits_raises_429_with_retry_after():
    redis = FakeRedis()
    rules = [("a", RateLimit(limit=5, window_seconds=60)), ("b", RateLimit(1, 3600))]
    await enforce_rate_limits(redis, rules)
    with pytest.raises(HTTPException) as exc:
        await enforce_rate_limits(redis, rules, detail="slow down")
    assert exc.value.status_code == 429
    assert exc.value.detail == "slow down"
    assert exc.value.headers == {"Retry-After": "3600"}


async def test_lease_admits_up_to_limit_then_refuses():
    redis = FakeRedis()
    leases = [
        await try_acquire_connection_lease(redis, KEY, limit=2, ttl_seconds=60)
        for _ in range(3)
    ]
    assert leases[0] is not None and leases[1] is not None
    assert leases[2] is None
    assert await redis.zcard(KEY) == 2  # the refused attempt was rolled back


async def test_released_lease_frees_a_slot():
    redis = FakeRedis()
    lease = await try_acquire_connection_lease(redis, KEY, limit=1, ttl_seconds=60)
    assert (
        await try_acquire_connection_lease(redis, KEY, limit=1, ttl_seconds=60) is None
    )
    await lease.release()
    assert await try_acquire_connection_lease(redis, KEY, limit=1, ttl_seconds=60)


async def test_expired_leases_are_pruned_on_acquire():
    redis = FakeRedis()
    redis.store[KEY] = ({"crashed-worker": time.time() - 1}, None)
    lease = await try_acquire_connection_lease(redis, KEY, limit=1, ttl_seconds=60)
    assert lease is not None
    assert "crashed-worker" not in redis.store[KEY][0]


async def test_renew_extends_only_existing_member():
    redis = FakeRedis()
    lease = await try_acquire_connection_lease(redis, KEY, limit=1, ttl_seconds=60)
    before = redis.store[KEY][0][lease.member]
    time.sleep(0.01)
    await lease.renew()
    assert redis.store[KEY][0][lease.member] > before
    await lease.release()
    await lease.renew()  # XX: a released lease is not resurrected
    assert lease.member not in redis.store[KEY][0]
