"""Redis fixed-window rate limiting and concurrent-connection leases."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status

RATE_LIMITED_DETAIL = "Rate limit exceeded. Try again later."


@dataclass(frozen=True)
class RateLimit:
    """``limit`` hits per ``window_seconds`` for one key namespace."""

    limit: int
    window_seconds: int


async def is_over_limit(redis: Any, key: str, rule: RateLimit) -> bool:
    """Count one hit on ``key``; True once it exceeds ``rule.limit``.

    ``EXPIRE NX`` arms the window only on the first hit so steady traffic
    cannot keep extending it.
    """
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, rule.window_seconds, nx=True)
    count, _ = await pipe.execute()
    return int(count) > rule.limit


async def enforce_rate_limits(
    redis: Any,
    rules: list[tuple[str, RateLimit]],
    *,
    detail: str = RATE_LIMITED_DETAIL,
) -> None:
    """429 if any ``(key, rule)`` pair is over its limit (all are counted)."""
    for key, rule in rules:
        if await is_over_limit(redis, key, rule):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=detail,
                headers={"Retry-After": str(rule.window_seconds)},
            )


# ---------------------------------------------------------------------------
# Concurrent connection leases
# ---------------------------------------------------------------------------
#
# A sorted set per key: member = lease id, score = lease expiry (unix s).
# Expired members are pruned on every acquire, so a crashed process that
# never released its leases frees them after ``ttl_seconds`` instead of
# locking the key out forever (the "TTL safety" an INCR/DECR counter lacks).
# Long-lived holders call ``renew`` more often than ``ttl_seconds``.


@dataclass
class ConnectionLease:
    redis: Any
    key: str
    member: str
    ttl_seconds: int

    async def renew(self) -> None:
        """Push this lease's expiry out by another ``ttl_seconds``."""
        expires_at = time.time() + self.ttl_seconds
        pipe = self.redis.pipeline()
        pipe.zadd(self.key, {self.member: expires_at}, xx=True)
        pipe.expire(self.key, self.ttl_seconds)
        await pipe.execute()

    async def release(self) -> None:
        await self.redis.zrem(self.key, self.member)


async def try_acquire_connection_lease(
    redis: Any, key: str, *, limit: int, ttl_seconds: int
) -> ConnectionLease | None:
    """Take one of ``limit`` concurrent slots on ``key`` or return ``None``.

    Add-then-count inside one MULTI: a racing acquirer can only cause a
    spurious rejection near the limit, never admit more than ``limit``.
    """
    now = time.time()
    member = uuid.uuid4().hex
    pipe = redis.pipeline(transaction=True)
    pipe.zremrangebyscore(key, "-inf", now)
    pipe.zadd(key, {member: now + ttl_seconds})
    pipe.zcard(key)
    pipe.expire(key, ttl_seconds)
    _, _, held, _ = await pipe.execute()
    if int(held) > limit:
        await redis.zrem(key, member)
        return None
    return ConnectionLease(redis=redis, key=key, member=member, ttl_seconds=ttl_seconds)
