"""Tests for embed metadata hydration and the shared link-preview fetcher."""

import asyncio
import gzip
import html
import json
import time

import httpx
import pytest

from app.services import embed_metadata, link_preview
from app.services.embed_metadata import (
    CACHE_TTL_SECONDS,
    NEGATIVE_CACHE_TTL_SECONDS,
    hydrate_embed_metadata,
)
from app.services.link_preview import (
    LinkPreview,
    UnsafeUrlError,
    fetch_link_preview,
    is_private_ip,
    parse_meta_tags,
)

IMAGE_URL = "https://imagedelivery.net/acct/abc/original"
PAGE_URL = "https://example.com/post"
TWEET_URL = "https://x.com/someone/status/123?s=46"
IMAGE_METADATA = {"content_type": "image/jpeg"}


class _DictRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def mget(self, keys):
        return [self.store.get(key) for key in keys]

    async def set(self, key, value, ex=None):
        self.store[key] = value
        self.ttls[key] = ex


def _payload(*urls: str) -> dict:
    return {
        "casts": [
            {
                "hash": "0x" + "a" * 40,
                "text": "",
                "embeds": [{"url": url} for url in urls],
            }
        ]
    }


@pytest.fixture
def fetched(monkeypatch):
    """Stub the network fetch; records which URLs were fetched."""
    calls: list[str] = []
    results: dict[str, dict] = {}

    async def fake_fetch(url: str) -> dict:
        calls.append(url)
        return results.get(url, {})

    monkeypatch.setattr(embed_metadata, "_fetch_metadata", fake_fetch)
    return calls, results


# ---------------------------------------------------------------------------
# hydrate_embed_metadata
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hydrates_missing_metadata_and_caches(fetched):
    calls, results = fetched
    results[IMAGE_URL] = IMAGE_METADATA
    redis = _DictRedis()

    for _ in range(2):
        payload = _payload(IMAGE_URL, IMAGE_URL)
        await hydrate_embed_metadata(payload, redis=redis)
        embeds = payload["casts"][0]["embeds"]
        assert [e["metadata"] for e in embeds] == [IMAGE_METADATA, IMAGE_METADATA]

    assert calls == [IMAGE_URL]  # deduped, then served from cache
    assert list(redis.ttls.values()) == [CACHE_TTL_SECONDS]


@pytest.mark.asyncio
async def test_failed_fetch_is_negatively_cached_and_embed_left_alone(fetched):
    calls, _ = fetched
    redis = _DictRedis()
    payload = _payload(PAGE_URL)

    await hydrate_embed_metadata(payload, redis=redis)
    await hydrate_embed_metadata(_payload(PAGE_URL), redis=redis)

    assert payload["casts"][0]["embeds"] == [{"url": PAGE_URL}]
    assert calls == [PAGE_URL]
    assert list(redis.ttls.values()) == [NEGATIVE_CACHE_TTL_SECONDS]


@pytest.mark.asyncio
async def test_skips_embeds_with_metadata_and_quote_casts(fetched):
    calls, _ = fetched
    existing = {"content_type": "image/png"}
    payload = {
        "casts": [
            {
                "hash": "0x" + "a" * 40,
                "text": "",
                "embeds": [
                    {"url": IMAGE_URL, "metadata": existing},
                    {"cast": {"hash": "0x" + "b" * 40}},
                ],
            }
        ]
    }

    await hydrate_embed_metadata(payload)

    assert calls == []
    assert payload["casts"][0]["embeds"][0]["metadata"] is existing


@pytest.mark.asyncio
async def test_slow_fetch_returns_without_it_and_caches_in_background(monkeypatch):
    release = asyncio.Event()

    async def slow_fetch(url: str) -> dict:
        await release.wait()
        return IMAGE_METADATA

    monkeypatch.setattr(embed_metadata, "_fetch_metadata", slow_fetch)
    monkeypatch.setattr(embed_metadata, "FETCH_WAIT_SECONDS", 0.01)
    redis = _DictRedis()
    payload = _payload(IMAGE_URL)

    await hydrate_embed_metadata(payload, redis=redis)
    assert "metadata" not in payload["casts"][0]["embeds"][0]

    release.set()
    await asyncio.gather(*embed_metadata._loop_state().in_flight.values())
    assert [json.loads(v) for v in redis.store.values()] == [IMAGE_METADATA]


@pytest.mark.asyncio
async def test_page_metadata_maps_og_to_neynar_shape(monkeypatch):
    async def fake_preview(client, url):
        return LinkPreview(
            content_type="text/html",
            og={"title": "T", "description": "D", "image": "https://img/x.png"},
        )

    monkeypatch.setattr(embed_metadata, "fetch_link_preview", fake_preview)

    assert await embed_metadata._fetch_metadata(PAGE_URL) == {
        "content_type": "text/html",
        "html": {
            "ogTitle": "T",
            "ogDescription": "D",
            "ogImage": [{"url": "https://img/x.png"}],
        },
    }


@pytest.mark.asyncio
async def test_tweet_metadata_uses_x_oembed(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"author_name": "Someone", "html": "<p>hi</p>", "width": 550},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(embed_metadata, "_get_client", lambda: client)

    metadata = await embed_metadata._fetch_metadata(TWEET_URL)

    assert seen[0].url.host == "publish.x.com"
    assert seen[0].url.params["url"] == TWEET_URL
    assert metadata == {
        "content_type": "text/html",
        "html": {"oembed": {"author_name": "Someone", "html": "<p>hi</p>"}},
    }


# ---------------------------------------------------------------------------
# link_preview
# ---------------------------------------------------------------------------


def test_parse_og_tags_unescapes_entities_and_handles_attribute_order():
    page = (
        '<meta property="og:image" content="https://a/b?x=1&amp;y=2"/>'
        '<meta content="Title &quot;q&quot;" property="og:title">'
    )

    assert parse_meta_tags(page) == {
        "og:image": "https://a/b?x=1&y=2",
        "og:title": 'Title "q"',
    }


@pytest.mark.parametrize(
    "ip, expected",
    [
        ("10.0.0.1", True),
        ("169.254.169.254", True),
        ("::ffff:127.0.0.1", True),
        ("100.64.0.1", True),
        ("not-an-ip", True),
        ("93.184.216.34", False),
    ],
)
def test_is_private_ip(ip, expected):
    assert is_private_ip(ip) is expected


@pytest.fixture
def public_dns(monkeypatch):
    async def allow(url: str) -> None:
        if "internal" in url:
            raise UnsafeUrlError("blocked")

    monkeypatch.setattr(link_preview, "assert_public_url", allow)


@pytest.mark.asyncio
async def test_fetch_link_preview_reads_og_from_html(public_dns):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            stream=httpx.ByteStream(
                b'<head><meta property="og:title" content="Hi"></head><body>'
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        preview = await fetch_link_preview(client, PAGE_URL)

    assert preview == LinkPreview(content_type="text/html", og={"title": "Hi"})


@pytest.mark.asyncio
async def test_fetch_link_preview_reports_media_type_without_reading_body(
    public_dns,
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "image/jpeg"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        preview = await fetch_link_preview(client, IMAGE_URL)

    assert preview == LinkPreview(content_type="image/jpeg")


@pytest.mark.asyncio
async def test_fetch_link_preview_rechecks_each_redirect_hop(public_dns):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://internal/admin"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(UnsafeUrlError):
            await fetch_link_preview(client, PAGE_URL)


@pytest.mark.asyncio
async def test_assert_public_url_rejects_loopback_and_non_http():
    with pytest.raises(UnsafeUrlError):
        await link_preview.assert_public_url("http://127.0.0.1/")
    with pytest.raises(UnsafeUrlError):
        await link_preview.assert_public_url("file:///etc/passwd")


# ---------------------------------------------------------------------------
# Hardening regressions
# ---------------------------------------------------------------------------


def test_parse_og_tags_is_linear_on_unclosed_meta_tags():
    page = "<meta property='og:x' " * 50_000  # ~1 MB, never closes a tag
    started = time.monotonic()

    assert parse_meta_tags(page) == {}
    assert time.monotonic() - started < 1.0


@pytest.mark.parametrize(
    "ip",
    ["64:ff9b::a00:1", "2002:7f00:1::", "224.0.0.1", "198.18.0.1", "240.0.0.1"],
)
def test_is_private_ip_covers_embedded_and_reserved_ranges(ip):
    assert is_private_ip(ip) is True


@pytest.mark.asyncio
async def test_fetch_link_preview_caps_gzip_bombs(public_dns):
    bomb = gzip.compress(b"<head>" + b" " * (20 * 1024 * 1024))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html", "content-encoding": "gzip"},
            stream=httpx.ByteStream(bomb),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        head = await link_preview._read_head(
            await client.send(client.build_request("GET", PAGE_URL), stream=True)
        )

    assert len(head) == link_preview.MAX_HTML_BYTES


@pytest.mark.asyncio
async def test_fetch_link_preview_survives_unknown_charset(public_dns):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=bogus-charset"},
            stream=httpx.ByteStream(b'<meta property="og:title" content="Hi"></head>'),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        preview = await fetch_link_preview(client, PAGE_URL)

    assert preview.og == {"title": "Hi"}


@pytest.mark.asyncio
async def test_unexpected_fetch_error_does_not_break_hydration(monkeypatch):
    async def explode(url: str) -> dict:
        raise RuntimeError("boom")

    monkeypatch.setattr(embed_metadata, "_fetch_page_metadata", explode)
    payload = _payload(PAGE_URL)

    await hydrate_embed_metadata(payload)

    assert payload["casts"][0]["embeds"] == [{"url": PAGE_URL}]


@pytest.mark.asyncio
async def test_concurrent_requests_share_one_fetch_per_url(monkeypatch):
    calls: list[str] = []
    release = asyncio.Event()

    async def slow_fetch(url: str) -> dict:
        calls.append(url)
        await release.wait()
        return IMAGE_METADATA

    monkeypatch.setattr(embed_metadata, "_fetch_metadata", slow_fetch)
    monkeypatch.setattr(embed_metadata, "FETCH_WAIT_SECONDS", 0.01)

    await asyncio.gather(
        hydrate_embed_metadata(_payload(IMAGE_URL)),
        hydrate_embed_metadata(_payload(IMAGE_URL)),
    )
    release.set()
    await asyncio.gather(*embed_metadata._loop_state().in_flight.values())

    assert calls == [IMAGE_URL]


# ---------------------------------------------------------------------------
# Mini-app embeds
# ---------------------------------------------------------------------------

MINIAPP_URL = "https://yoink.party/framesV2/"
MINIAPP_EMBED = {
    "version": "1",
    "imageUrl": "https://yoink.party/og.png",
    "button": {
        "title": "Start",
        "action": {
            "type": "launch_miniapp",
            "name": "Yoink!",
            "url": "https://yoink.party/framesV2",
            "splashImageUrl": "https://yoink.party/logo.png",
            "splashBackgroundColor": "#f5f0ec",
        },
    },
}


def _miniapp_page(embed: dict, tag: str = "fc:miniapp") -> bytes:
    content = html.escape(json.dumps(embed), quote=True)
    return (
        f'<head><meta property="og:title" content="Yoink">'
        f'<meta name="{tag}" content="{content}"></head>'
    ).encode()


async def _page_metadata(monkeypatch, page_url: str, page: bytes) -> dict:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            stream=httpx.ByteStream(page),
        )

    async def allow(url: str) -> None:
        return None

    monkeypatch.setattr(link_preview, "assert_public_url", allow)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(embed_metadata, "_get_client", lambda: client)
    return await embed_metadata._fetch_metadata(page_url)


@pytest.mark.asyncio
@pytest.mark.parametrize("tag", ["fc:miniapp", "fc:frame"])
async def test_miniapp_embed_maps_to_fc_frame(monkeypatch, tag):
    metadata = await _page_metadata(
        monkeypatch, MINIAPP_URL, _miniapp_page(MINIAPP_EMBED, tag)
    )

    assert metadata["html"] == {"ogTitle": "Yoink"}
    assert metadata["fc_frame"] == {
        "version": "1",
        "image_url": "https://yoink.party/og.png",
        "button": {
            "title": "Start",
            "action": {
                "type": "launch_frame",
                "url": "https://yoink.party/framesV2",
                "name": "Yoink!",
                "splash_image_url": "https://yoink.party/logo.png",
                "splash_background_color": "#f5f0ec",
            },
        },
    }


@pytest.mark.asyncio
async def test_miniapp_cannot_launch_another_domain(monkeypatch):
    embed = json.loads(json.dumps(MINIAPP_EMBED))
    embed["button"]["action"]["url"] = "https://evil.example/drain"

    metadata = await _page_metadata(monkeypatch, MINIAPP_URL, _miniapp_page(embed))

    assert metadata["fc_frame"]["button"]["action"]["url"] == MINIAPP_URL


@pytest.mark.asyncio
async def test_miniapp_directory_page_may_launch_the_app(monkeypatch):
    directory_url = "https://farcaster.xyz/miniapps/abc/yoink"

    metadata = await _page_metadata(
        monkeypatch, directory_url, _miniapp_page(MINIAPP_EMBED)
    )

    action = metadata["fc_frame"]["button"]["action"]
    assert action["url"] == "https://yoink.party/framesV2"


@pytest.mark.asyncio
async def test_miniapp_drops_unsafe_fields(monkeypatch):
    embed = json.loads(json.dumps(MINIAPP_EMBED))
    action = embed["button"]["action"]
    action["splashImageUrl"] = "javascript:alert(1)"
    action["splashBackgroundColor"] = "red; background: url(x)"
    action["name"] = {"nested": "object"}
    embed["extra"] = "ignored"

    metadata = await _page_metadata(monkeypatch, MINIAPP_URL, _miniapp_page(embed))

    assert metadata["fc_frame"]["button"]["action"] == {
        "type": "launch_frame",
        "url": "https://yoink.party/framesV2",
    }
    assert "extra" not in metadata["fc_frame"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content",
    [
        "vNext",  # legacy v1 frame
        json.dumps({**MINIAPP_EMBED, "imageUrl": "http://insecure/og.png"}),
        json.dumps({**MINIAPP_EMBED, "button": "Start"}),
        json.dumps(["not", "an", "object"]),
    ],
)
async def test_invalid_miniapp_embed_is_ignored(monkeypatch, content):
    page = (
        f'<head><meta property="og:title" content="Yoink">'
        f'<meta name="fc:miniapp" content="{html.escape(content, quote=True)}">'
        f"</head>"
    ).encode()

    metadata = await _page_metadata(monkeypatch, MINIAPP_URL, page)

    assert "fc_frame" not in metadata
    assert metadata["html"] == {"ogTitle": "Yoink"}
