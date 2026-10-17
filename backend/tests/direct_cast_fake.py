"""In-process fakes for the Direct Casts upstream and Redis.

``FakeDirectCast`` backs a real ``httpx.AsyncClient`` with
``httpx.MockTransport`` (same approach as ``hypersnap_fake.py``) so tests
exercise ``FarcasterDirectCastService._request`` — headers, retries, error
mapping, envelope validation — instead of mocking it away. Routes are keyed
by ``(METHOD, path)``; unrouted requests answer 404 so a typo in a path
fails loudly.

``FakeRedis`` is a tiny in-memory subset (strings with TTL, counters,
pipelines, pub/sub) sufficient for the read cache, rate limits, the poller
lock/snapshot and the events channel.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from app.services.direct_cast_service import FarcasterDirectCastService

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "direct_cast"
FAKE_BASE_URL = "https://client.farcaster.test"
VIEWER_FID = 1001
PEER_FID = 2002
OTHER_FID = 3003
ONE_TO_ONE_ID = f"{VIEWER_FID}-{PEER_FID}"
GROUP_ID = "8f3a1c2b9d7e4f60a1b2c3d4e5f60718"

RouteResult = dict | tuple[int, Any] | httpx.Response
RouteHandler = Callable[["RecordedRequest"], RouteResult]


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text())


@dataclass
class RecordedRequest:
    method: str
    path: str
    params: dict[str, str]
    json: Any
    headers: dict[str, str]


@dataclass
class FakeDirectCast:
    routes: dict[tuple[str, str], RouteResult | RouteHandler | list[RouteResult]] = (
        field(default_factory=dict)
    )
    calls: list[RecordedRequest] = field(default_factory=list)

    def route(
        self,
        method: str,
        path: str,
        result: RouteResult | RouteHandler | list[RouteResult],
    ) -> None:
        """Register a response. A list is consumed one item per call."""
        self.routes[(method, path)] = result

    def calls_to(self, method: str, path: str) -> list[RecordedRequest]:
        return [c for c in self.calls if c.method == method and c.path == path]

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        recorded = RecordedRequest(
            method=request.method,
            path=request.url.path,
            params=dict(request.url.params),
            json=body,
            headers={k.lower(): v for k, v in request.headers.items()},
        )
        self.calls.append(recorded)
        result = self.routes.get((request.method, request.url.path))
        if result is None:
            return httpx.Response(404, json={"errors": [{"message": "no route"}]})
        if isinstance(result, list):
            result = result.pop(0) if len(result) > 1 else result[0]
        if callable(result):
            result = result(recorded)
        if isinstance(result, httpx.Response):
            return result
        status, payload = result if isinstance(result, tuple) else (200, result)
        if isinstance(payload, str):
            return httpx.Response(
                status, text=payload, headers={"content-type": "text/html"}
            )
        return httpx.Response(status, json=payload)

    def http_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))


def make_service(
    fake: FakeDirectCast,
    redis: FakeRedis | None = None,
    *,
    cache_ttl_seconds: int = 0,
    user_lookup: Any = None,
    on_token_rejected: Any = None,
) -> FarcasterDirectCastService:
    async def no_profiles(_fids: Any) -> dict:
        return {}

    return FarcasterDirectCastService(
        redis=redis if redis is not None else FakeRedis(),
        http=fake.http_client(),
        base_url=FAKE_BASE_URL,
        retry_base_seconds=0,
        cache_ttl_seconds=cache_ttl_seconds,
        user_lookup=user_lookup or no_profiles,
        on_token_rejected=on_token_rejected,
    )


# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------


class _FakePipeline:
    def __init__(self, redis: FakeRedis) -> None:
        self._redis = redis
        self._ops: list[tuple[str, tuple, dict]] = []

    def incr(self, key: str) -> _FakePipeline:
        self._ops.append(("incr", (key,), {}))
        return self

    def expire(self, key: str, seconds: int, **kwargs: Any) -> _FakePipeline:
        self._ops.append(("expire", (key, seconds), kwargs))
        return self

    def __getattr__(self, name: str) -> Callable[..., _FakePipeline]:
        # Queue any other FakeRedis command (zadd, zcard, ...) for execute().
        if name.startswith("_") or not hasattr(self._redis, name):
            raise AttributeError(name)

        def queue(*args: Any, **kwargs: Any) -> _FakePipeline:
            self._ops.append((name, args, kwargs))
            return self

        return queue

    async def execute(self) -> list[Any]:
        results = [
            await getattr(self._redis, name)(*args, **kwargs)
            for name, args, kwargs in self._ops
        ]
        self._ops.clear()
        return results


class _FakePubSub:
    def __init__(self, redis: FakeRedis) -> None:
        self._redis = redis
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.channels: set[str] = set()

    async def subscribe(self, *channels: str) -> None:
        for channel in channels:
            self.channels.add(channel)
            self._redis.subscribers[channel].append(self._queue)

    async def unsubscribe(self, *channels: str) -> None:
        for channel in channels or tuple(self.channels):
            self.channels.discard(channel)
            subs = self._redis.subscribers[channel]
            if self._queue in subs:
                subs.remove(self._queue)

    async def get_message(
        self, ignore_subscribe_messages: bool = False, timeout: float = 0.0
    ) -> dict[str, Any] | None:
        try:
            return await asyncio.wait_for(self._queue.get(), timeout=max(timeout, 0))
        except TimeoutError:
            return None

    async def aclose(self) -> None:
        await self.unsubscribe()

    async def close(self) -> None:
        await self.aclose()


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, tuple[Any, float | None]] = {}
        self.published: list[tuple[str, str]] = []
        self.subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)

    def _live(self, key: str) -> Any:
        item = self.store.get(key)
        if item is None:
            return None
        value, expires_at = item
        if expires_at is not None and time.monotonic() >= expires_at:
            del self.store[key]
            return None
        return value

    async def get(self, key: str) -> Any:
        return self._live(key)

    async def set(
        self,
        key: str,
        value: Any,
        *,
        ex: int | None = None,
        px: int | None = None,
        nx: bool = False,
    ) -> bool | None:
        if nx and self._live(key) is not None:
            return None
        ttl = ex if ex is not None else (px / 1000 if px is not None else None)
        expires_at = time.monotonic() + ttl if ttl is not None else None
        self.store[key] = (value, expires_at)
        return True

    async def incr(self, key: str) -> int:
        value = int(self._live(key) or 0) + 1
        expires_at = self.store.get(key, (None, None))[1]
        self.store[key] = (value, expires_at)
        return value

    async def expire(self, key: str, seconds: int, *, nx: bool = False) -> bool:
        if self._live(key) is None:
            return False
        value, expires_at = self.store[key]
        if nx and expires_at is not None:
            return False
        self.store[key] = (value, time.monotonic() + seconds)
        return True

    async def ttl(self, key: str) -> int:
        if self._live(key) is None:
            return -2
        expires_at = self.store[key][1]
        return -1 if expires_at is None else int(expires_at - time.monotonic())

    async def delete(self, *keys: str) -> int:
        return sum(1 for key in keys if self.store.pop(key, None) is not None)

    async def getdel(self, key: str) -> Any:
        value = self._live(key)
        self.store.pop(key, None)
        return value

    def pipeline(self, transaction: bool = True) -> _FakePipeline:
        return _FakePipeline(self)

    # Sorted sets (connection leases). Stored as ``dict[member, score]``.
    def _zset(self, key: str) -> dict[str, float]:
        value = self._live(key)
        if value is None:
            value = {}
            self.store[key] = (value, None)
        return value

    async def zadd(
        self, key: str, mapping: dict[str, float], *, xx: bool = False
    ) -> int:
        zset = self._zset(key)
        added = 0
        for member, score in mapping.items():
            if xx and member not in zset:
                continue
            added += member not in zset
            zset[member] = score
        return added

    async def zrem(self, key: str, *members: str) -> int:
        zset = self._live(key) or {}
        return sum(1 for member in members if zset.pop(member, None) is not None)

    async def zcard(self, key: str) -> int:
        return len(self._live(key) or {})

    async def zremrangebyscore(self, key: str, low: Any, high: Any) -> int:
        zset = self._live(key) or {}
        low_f, high_f = float(low), float(high)
        doomed = [m for m, score in zset.items() if low_f <= score <= high_f]
        for member in doomed:
            del zset[member]
        return len(doomed)

    def pubsub(self) -> _FakePubSub:
        return _FakePubSub(self)

    async def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        subs = list(self.subscribers.get(channel, []))
        for queue in subs:
            queue.put_nowait({"type": "message", "channel": channel, "data": message})
        return len(subs)

    async def close(self) -> None:
        return None
