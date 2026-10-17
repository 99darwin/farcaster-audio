"""Tests for app.clients.hypersnap (paths, pagination, error mapping)."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from app.clients import hypersnap
from app.clients.hypersnap import (
    HypersnapClient,
    HypersnapNotFound,
    HypersnapResponseTooLarge,
    HypersnapUpstreamError,
)


def _client(handler) -> HypersnapClient:
    return HypersnapClient("https://node.test/", transport=httpx.MockTransport(handler))


async def test_get_uses_v2_prefix_and_drops_none_params():
    seen: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return httpx.Response(200, json={"user": {"fid": 3}})

    client = _client(handler)
    data = await client.get("user", {"fid": 3, "viewer_fid": None})
    await client.aclose()
    assert data == {"user": {"fid": 3}}
    assert seen[0].path == "/v2/farcaster/user"
    assert dict(seen[0].params) == {"fid": "3"}


async def test_get_v1_path():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"signers": []})

    client = _client(handler)
    await client.get_v1("/signersByFid", {"fid": 3})
    await client.aclose()
    assert seen == ["/v1/signersByFid"]


async def test_paginate_follows_cursor_until_exhausted():
    cursors: list[str | None] = []
    pages = {
        None: {"casts": [1], "next": {"cursor": "c1"}},
        "c1": {"casts": [2], "next": {"cursor": "c2"}},
        "c2": {"casts": [3], "next": {"cursor": None}},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        cursor = request.url.params.get("cursor")
        cursors.append(cursor)
        assert request.url.params["fid"] == "3"
        return httpx.Response(200, json=pages[cursor])

    client = _client(handler)
    results = [page async for page in client.paginate("/feed", {"fid": 3})]
    await client.aclose()
    assert [page["casts"][0] for page in results] == [1, 2, 3]
    assert cursors == [None, "c1", "c2"]


async def test_paginate_respects_max_pages():
    def handler(request: httpx.Request) -> httpx.Response:
        n = int(request.url.params.get("cursor", "0"))
        return httpx.Response(200, json={"n": n, "next": {"cursor": str(n + 1)}})

    client = _client(handler)
    results = [page async for page in client.paginate("/feed", max_pages=3)]
    await client.aclose()
    assert [page["n"] for page in results] == [0, 1, 2]


async def test_paginate_stops_on_repeated_cursor():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"next": {"cursor": "same"}})

    client = _client(handler)
    results = [page async for page in client.paginate("/feed", max_pages=10)]
    await client.aclose()
    assert len(results) == 2


async def test_paginate_rejects_zero_pages():
    client = _client(lambda _: httpx.Response(200, json={}))
    with pytest.raises(ValueError):
        async for _ in client.paginate("/feed", max_pages=0):
            pass
    await client.aclose()


@pytest.mark.parametrize(
    "response,error_type,status",
    [
        (httpx.Response(404, json={"message": "nope"}), HypersnapNotFound, 404),
        (httpx.Response(500, text="boom"), HypersnapUpstreamError, 500),
        (httpx.Response(429, text="slow down"), HypersnapUpstreamError, 429),
        (httpx.Response(200, text="<html>"), HypersnapUpstreamError, 200),
        (httpx.Response(200, json=[1, 2]), HypersnapUpstreamError, 200),
    ],
)
async def test_error_mapping(response, error_type, status):
    client = _client(lambda _: response)
    with pytest.raises(error_type) as info:
        await client.get("/cast", {"identifier": "0x1"})
    await client.aclose()
    assert info.value.status_code == status
    assert info.value.path == "/v2/farcaster/cast"


async def test_transport_error_mapping():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    client = _client(handler)
    with pytest.raises(HypersnapUpstreamError) as info:
        await client.get("/cast")
    await client.aclose()
    assert info.value.status_code is None


@pytest.mark.parametrize(
    "upstream_status,expected",
    [(None, 502), (500, 502), (503, 502), (404, 404), (400, 400)],
)
def test_raise_for_upstream(upstream_status, expected):
    exc = HypersnapUpstreamError(
        "x", path="/v2/farcaster/cast", status_code=upstream_status, body="secret-ish"
    )
    with pytest.raises(HTTPException) as info:
        hypersnap.raise_for_upstream(exc, context="test")
    assert info.value.status_code == expected
    assert info.value.detail == "Upstream service error"


async def test_module_singleton_roundtrip():
    client = _client(lambda _: httpx.Response(200, json={"ok": True}))
    hypersnap.set_client(client)
    try:
        assert await hypersnap.get("/info") == {"ok": True}
        assert await hypersnap.get_v1("/info") == {"ok": True}
    finally:
        await hypersnap.close_client()
    assert hypersnap._client is None


# ---------------------------------------------------------------------------
# Body cap, deadline, production https
# ---------------------------------------------------------------------------

SMALL_CAP_BYTES = 64


async def _chunks(count: int, size: int, *, delay: float = 0.0):
    for _ in range(count):
        if delay:
            await asyncio.sleep(delay)
        yield b"x" * size


async def test_streamed_body_over_cap_is_aborted():
    consumed: list[int] = []

    async def body():
        async for chunk in _chunks(100, 32):
            consumed.append(len(chunk))
            yield chunk

    client = HypersnapClient(
        "https://node.test",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body())),
        max_response_bytes=SMALL_CAP_BYTES,
    )
    with pytest.raises(HypersnapResponseTooLarge) as info:
        await client.get("/user")
    await client.aclose()
    assert isinstance(info.value, HypersnapUpstreamError)
    # Aborted mid-stream, not after buffering everything.
    assert sum(consumed) <= SMALL_CAP_BYTES + 32


async def test_declared_length_over_cap_is_rejected_before_reading():
    client = HypersnapClient(
        "https://node.test",
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, content=b"{}" + b" " * SMALL_CAP_BYTES)
        ),
        max_response_bytes=SMALL_CAP_BYTES,
    )
    with pytest.raises(HypersnapResponseTooLarge):
        await client.get_v1("/info")
    await client.aclose()


async def test_body_at_cap_is_accepted():
    body = b'{"a": "' + b"x" * (SMALL_CAP_BYTES - 10) + b'"}'
    assert len(body) <= SMALL_CAP_BYTES
    client = HypersnapClient(
        "https://node.test",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)),
        max_response_bytes=SMALL_CAP_BYTES,
    )
    assert (await client.get("/user"))["a"].startswith("x")
    await client.aclose()


async def test_slow_body_exceeds_overall_deadline():
    client = HypersnapClient(
        "https://node.test",
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, content=_chunks(50, 1, delay=0.05))
        ),
        deadline_seconds=0.1,
    )
    with pytest.raises(HypersnapUpstreamError) as info:
        await client.get("/user")
    await client.aclose()
    assert "deadline" in str(info.value)
    assert info.value.status_code is None


def test_production_requires_https_base_url(monkeypatch):
    monkeypatch.setattr(hypersnap.settings, "ENVIRONMENT", "production")
    with pytest.raises(ValueError, match="https"):
        HypersnapClient("http://node.test")
    HypersnapClient("https://node.test")


def test_non_production_allows_http_base_url(monkeypatch):
    monkeypatch.setattr(hypersnap.settings, "ENVIRONMENT", "development")
    HypersnapClient("http://localhost:3381")


@pytest.mark.parametrize("url", ["http://node.test", "node.test", "https://"])
def test_settings_reject_non_https_hypersnap_url_in_production(monkeypatch, url):
    from pydantic import ValidationError

    from app.config import Settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HYPERSNAP_HTTP_URL", url)
    with pytest.raises(ValidationError, match="HYPERSNAP_HTTP_URL"):
        Settings(_env_file=None)


def test_settings_accept_https_hypersnap_url_in_production(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HYPERSNAP_HTTP_URL", "https://node.test")
    assert Settings(_env_file=None).HYPERSNAP_HTTP_URL == "https://node.test"


async def test_get_prefixes_bare_cast_hashes_at_any_depth():
    bare = "910aace694877f6c43899a2033d6c75f37ae23fa"
    parent = "AC0355A62CC6" + "0" * 28

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "conversation": {
                    "cast": {
                        "hash": bare,
                        "parent_hash": parent,
                        "thread_hash": None,
                        "direct_replies": [{"hash": "0x" + bare}],
                        "embeds": [{"cast": {"hash": bare}}],
                        "author": {"custody_address": "ab" * 20},
                        "text": bare,
                    }
                }
            },
        )

    client = _client(handler)
    data = await client.get("/cast/conversation", {"identifier": "0x" + bare})
    await client.aclose()
    cast = data["conversation"]["cast"]
    assert cast["hash"] == "0x" + bare
    assert cast["parent_hash"] == "0x" + parent.lower()
    assert cast["thread_hash"] is None
    assert cast["direct_replies"][0]["hash"] == "0x" + bare
    assert cast["embeds"][0]["cast"]["hash"] == "0x" + bare
    # Only hash keys are touched: addresses and free text stay as returned.
    assert cast["author"]["custody_address"] == "ab" * 20
    assert cast["text"] == bare


async def test_get_v1_leaves_hashes_untouched():
    bare = "910aace694877f6c43899a2033d6c75f37ae23fa"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"hash": bare})

    client = _client(handler)
    data = await client.get_v1("/castById")
    await client.aclose()
    assert data == {"hash": bare}


async def test_get_retries_once_after_transport_error():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, json={"ok": True})

    client = _client(handler)
    assert await client.get("/cast") == {"ok": True}
    await client.aclose()
    assert calls == 2


async def test_get_gives_up_after_retry():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("slow", request=request)

    client = _client(handler)
    with pytest.raises(HypersnapUpstreamError):
        await client.get("/cast")
    await client.aclose()
    assert calls == 2


async def test_get_does_not_retry_http_errors():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, text="down")

    client = _client(handler)
    with pytest.raises(HypersnapUpstreamError):
        await client.get("/cast")
    await client.aclose()
    assert calls == 1


def test_prefix_cast_hashes_handles_deep_nesting():
    depth = 5000
    data = json.loads("[" * depth + '{"hash": "' + "a" * 40 + '"}' + "]" * depth)
    hypersnap.prefix_cast_hashes(data)
    node = data
    for _ in range(depth):
        node = node[0]
    assert node["hash"] == "0x" + "a" * 40


def _zero_width(*starts: int) -> list[dict[str, int]]:
    return [{"start": start, "end": start} for start in starts]


async def test_get_inlines_mentions_into_cast_text():
    text = "drove  and I started /gmfarcaster but builders like  return"
    starts = [text.index("  ") + 1, text.index("like ") + 5]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "casts": [
                    {
                        "text": text,
                        "mentioned_profiles": [
                            {"username": "adrienne"},
                            {"username": "jake"},
                        ],
                        "mentioned_profiles_ranges": _zero_width(*starts),
                        "mentioned_channels": [],
                        "mentioned_channels_ranges": [],
                    }
                ]
            },
        )

    client = _client(handler)
    data = await client.get("/feed/user/casts", {"fid": 4167})
    await client.aclose()
    cast = data["casts"][0]
    assert cast["text"] == (
        "drove @adrienne and I started /gmfarcaster but builders like @jake return"
    )
    encoded = cast["text"].encode()
    spans = [
        encoded[r["start"] : r["end"]].decode()
        for r in cast["mentioned_profiles_ranges"]
    ]
    assert spans == ["@adrienne", "@jake"]


def test_inline_cast_mentions_uses_utf8_byte_offsets():
    text = "🎧 café  hi"
    cast = {
        "text": text,
        "mentioned_profiles": [{"username": "dwr"}],
        "mentioned_profiles_ranges": _zero_width(len("🎧 café ".encode())),
    }
    hypersnap.inline_cast_mentions({"cast": cast})
    assert cast["text"] == "🎧 café @dwr hi"
    span = cast["mentioned_profiles_ranges"][0]
    assert cast["text"].encode()[span["start"] : span["end"]] == b"@dwr"


@pytest.mark.parametrize(
    "cast",
    [
        # Already inlined (Neynar shape): ranges span the token.
        {
            "text": "hi @dwr",
            "mentioned_profiles": [{"username": "dwr"}],
            "mentioned_profiles_ranges": [{"start": 3, "end": 7}],
        },
        # Offset inside a multi-byte character.
        {
            "text": "🎧",
            "mentioned_profiles": [{"username": "dwr"}],
            "mentioned_profiles_ranges": _zero_width(1),
        },
        # Offset past the end of the text.
        {
            "text": "hi",
            "mentioned_profiles": [{"username": "dwr"}],
            "mentioned_profiles_ranges": _zero_width(9),
        },
        # Mismatched lengths.
        {
            "text": "hi ",
            "mentioned_profiles": [{"username": "dwr"}, {"username": "v"}],
            "mentioned_profiles_ranges": _zero_width(3),
        },
        # Missing username.
        {
            "text": "hi ",
            "mentioned_profiles": [{"fid": 3}],
            "mentioned_profiles_ranges": _zero_width(3),
        },
        # One valid mention, one malformed: nothing is applied.
        {
            "text": "hi ",
            "mentioned_profiles": [{"username": "dwr"}, {"username": "v"}],
            "mentioned_profiles_ranges": _zero_width(3, 99),
        },
        # More mentions than the protocol allows.
        {
            "text": "",
            "mentioned_profiles": [{"username": "a"}] * 11,
            "mentioned_profiles_ranges": _zero_width(*[0] * 11),
        },
        # Lone surrogate (valid JSON escape, unencodable as UTF-8).
        {
            "text": "\ud800",
            "mentioned_profiles": [{"username": "dwr"}],
            "mentioned_profiles_ranges": _zero_width(0),
        },
    ],
)
def test_inline_cast_mentions_leaves_unusable_casts_untouched(cast):
    original = json.loads(json.dumps(cast))
    hypersnap.inline_cast_mentions(cast)
    assert cast == original
