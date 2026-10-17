"""Unit tests for ``_enrich_participant_pfps`` in spaces_discovery.

Covers:
- Backfills missing pfp_url + display_name from Hypersnap.
- Skips fids whose row is already populated.
- Reads from the per-fid Redis cache before calling Hypersnap.
- Writes the Hypersnap result back to the cache.
- Best-effort: any exception leaves the payload untouched.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest

from app.clients import hypersnap
from app.routers.spaces_discovery import (
    PFP_CACHE_PREFIX,
    _collect_room_user_dicts,
    _enrich_participant_pfps,
    _enrich_user_pfps,
)


class _FakeRedis:
    """Minimal aioredis stand-in for the enrich helper."""

    def __init__(self, initial: dict[str, str] | None = None) -> None:
        self.store: dict[str, str] = dict(initial or {})
        self.writes: list[tuple[str, str]] = []

    async def mget(self, *keys: str) -> list[Any]:
        return [self.store.get(k) for k in keys]

    def pipeline(self) -> "_FakePipe":
        return _FakePipe(self)


class _FakePipe:
    def __init__(self, parent: _FakeRedis) -> None:
        self.parent = parent
        self.ops: list[tuple[str, str]] = []

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.ops.append((key, value))

    async def execute(self) -> None:
        for k, v in self.ops:
            self.parent.store[k] = v
            self.parent.writes.append((k, v))


@asynccontextmanager
async def _hypersnap_routed_to(handler):
    """Point the process-wide Hypersnap client at a MockTransport handler."""
    previous = hypersnap._client
    client = hypersnap.HypersnapClient(
        base_url="https://hypersnap.test", transport=httpx.MockTransport(handler)
    )
    hypersnap.set_client(client)
    try:
        yield
    finally:
        await client.aclose()
        hypersnap.set_client(previous)


@pytest.mark.asyncio
async def test_enrich_backfills_missing_pfp_and_display_name():
    """A participant whose upstream payload has empty pfp_url and
    display_name gets both backfilled from Hypersnap."""
    redis = _FakeRedis()
    participants = [
        {
            "user": {"fid": 42, "username": "alice"},
            "role": "host",
        }
    ]

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path.endswith("/farcaster/user/bulk")
        assert req.url.params["fids"] == "42"
        return httpx.Response(
            200,
            json={
                "users": [
                    {
                        "fid": 42,
                        "username": "alice",
                        "display_name": "Alice Liddell",
                        "pfp_url": "https://example.com/alice.png",
                    }
                ]
            },
        )

    async with _hypersnap_routed_to(handler):
        await _enrich_participant_pfps(participants, redis)  # type: ignore[arg-type]

    assert participants[0]["user"]["pfp_url"] == "https://example.com/alice.png"
    assert participants[0]["user"]["display_name"] == "Alice Liddell"
    # Cached for next time.
    cache_key = f"{PFP_CACHE_PREFIX}42"
    assert cache_key in redis.store


@pytest.mark.asyncio
async def test_enrich_uses_cache_before_hypersnap():
    """A cached fid does NOT trigger a Hypersnap call."""
    redis = _FakeRedis(
        initial={
            f"{PFP_CACHE_PREFIX}42": json.dumps(
                {
                    "pfp_url": "https://cdn/example.png",
                    "display_name": "From Cache",
                }
            )
        }
    )
    participants = [{"user": {"fid": 42, "username": "alice"}, "role": "speaker"}]

    called = {"hit": False}

    def handler(req: httpx.Request) -> httpx.Response:
        called["hit"] = True
        return httpx.Response(500)

    async with _hypersnap_routed_to(handler):
        await _enrich_participant_pfps(participants, redis)  # type: ignore[arg-type]

    assert called["hit"] is False
    assert participants[0]["user"]["pfp_url"] == "https://cdn/example.png"
    assert participants[0]["user"]["display_name"] == "From Cache"


@pytest.mark.asyncio
async def test_enrich_skips_already_populated_rows():
    """A row with both pfp_url and display_name set is left alone — no
    cache lookup, no Hypersnap call."""
    redis = _FakeRedis()
    participants = [
        {
            "user": {
                "fid": 42,
                "username": "alice",
                "display_name": "Alice",
                "pfp_url": "https://example.com/alice.png",
            },
            "role": "host",
        }
    ]

    called = {"hit": False}

    def handler(req: httpx.Request) -> httpx.Response:
        called["hit"] = True
        return httpx.Response(500)

    async with _hypersnap_routed_to(handler):
        await _enrich_participant_pfps(participants, redis)  # type: ignore[arg-type]

    assert called["hit"] is False
    # Pfp / display untouched.
    assert participants[0]["user"]["pfp_url"] == "https://example.com/alice.png"
    assert participants[0]["user"]["display_name"] == "Alice"


@pytest.mark.asyncio
async def test_enrich_swallows_hypersnap_failure():
    """A Hypersnap error leaves the payload untouched — never raises."""
    redis = _FakeRedis()
    participants = [{"user": {"fid": 42, "username": "alice"}, "role": "listener"}]

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    async with _hypersnap_routed_to(handler):
        await _enrich_participant_pfps(participants, redis)  # type: ignore[arg-type]

    # No enrichment, but no crash.
    assert "pfp_url" not in participants[0]["user"]


@pytest.mark.asyncio
async def test_enrich_backfills_room_host_pfps():
    """Discovery list shape — `[AudioRoom]`, each with a top-level
    `host` dict — also gets pfp_url + display_name backfilled. This is
    what powers the spaces rail."""
    redis = _FakeRedis()
    rooms = [
        {
            "id": "room-a",
            "host": {"fid": 42, "username": "alice"},
        },
        {
            "id": "room-b",
            "host": {"fid": 99, "username": "bob"},
        },
    ]

    seen_fids: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen_fids.append(req.url.params["fids"])
        return httpx.Response(
            200,
            json={
                "users": [
                    {
                        "fid": 42,
                        "username": "alice",
                        "display_name": "Alice",
                        "pfp_url": "https://example.com/alice.png",
                    },
                    {
                        "fid": 99,
                        "username": "bob",
                        "display_name": "Bob",
                        "pfp_url": "https://example.com/bob.png",
                    },
                ]
            },
        )

    async with _hypersnap_routed_to(handler):
        await _enrich_user_pfps(_collect_room_user_dicts(rooms), redis)  # type: ignore[arg-type]

    # Single bulk call for both fids.
    assert len(seen_fids) == 1
    assert sorted(seen_fids[0].split(",")) == ["42", "99"]
    assert rooms[0]["host"]["pfp_url"] == "https://example.com/alice.png"
    assert rooms[0]["host"]["display_name"] == "Alice"
    assert rooms[1]["host"]["pfp_url"] == "https://example.com/bob.png"
    assert rooms[1]["host"]["display_name"] == "Bob"


@pytest.mark.asyncio
async def test_enrich_handles_duplicate_fid_across_rooms():
    """When the same fid hosts multiple rooms in the discovery list,
    all occurrences get enriched from a single bulk call — the fid
    doesn't get fetched twice."""
    redis = _FakeRedis()
    rooms = [
        {"id": "room-a", "host": {"fid": 42, "username": "alice"}},
        {"id": "room-b", "host": {"fid": 42, "username": "alice"}},
    ]

    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200,
            json={
                "users": [
                    {
                        "fid": 42,
                        "display_name": "Alice",
                        "pfp_url": "https://example.com/alice.png",
                    }
                ]
            },
        )

    async with _hypersnap_routed_to(handler):
        await _enrich_user_pfps(_collect_room_user_dicts(rooms), redis)  # type: ignore[arg-type]

    assert calls["n"] == 1
    # Both occurrences enriched.
    assert (
        rooms[0]["host"]["pfp_url"]
        == rooms[1]["host"]["pfp_url"]
        == "https://example.com/alice.png"
    )
    assert rooms[0]["host"]["display_name"] == "Alice"
    assert rooms[1]["host"]["display_name"] == "Alice"
