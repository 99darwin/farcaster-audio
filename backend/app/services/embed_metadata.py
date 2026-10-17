"""Hydrate Neynar-style ``metadata`` onto cast URL embeds.

Hypersnap returns embeds as bare ``{"url": ...}``. Clients classify media and
render link cards from Neynar's ``embed.metadata`` (``content_type``,
``html.ogTitle``/``ogDescription``/``ogImage``, ``html.oembed`` for X,
``fc_frame`` for mini apps), so without it extensionless image URLs
(``imagedelivery.net/.../original``) render as bare links, link cards come up
empty, and mini apps show as plain links with no launch button.

Each unique URL is fetched once (SSRF-safe, :mod:`app.services.link_preview`)
and cached in Redis. A feed request waits at most
:data:`FETCH_WAIT_SECONDS` for misses; slower fetches keep running in the
background and land in the cache for the next load. Best-effort throughout:
a failed fetch leaves the embed as Hypersnap returned it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import urllib.parse
import weakref
from dataclasses import dataclass, field
from typing import Any

import httpx
import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.services.cast_bookmark_service import iter_cast_dicts
from app.services.link_preview import (
    UnsafeUrlError,
    create_client,
    fetch_link_preview,
)

logger = logging.getLogger(__name__)

# v2: adds fc_frame, so v1 entries for mini-app links must not be reused.
CACHE_KEY_PREFIX = "embed_meta:v2:"
CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
# Failures are cached briefly so a dead link isn't refetched on every scroll.
NEGATIVE_CACHE_TTL_SECONDS = 60 * 60
# How long a read request waits for uncached URLs before responding.
FETCH_WAIT_SECONDS = 2.5
# Hard bound on one URL's fetch (all redirects + body).
FETCH_DEADLINE_SECONDS = 8.0
FETCH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
MAX_URLS_PER_PAYLOAD = 40
MAX_CONCURRENT_FETCHES = 16
# Past this many queued/running fetches, new misses are skipped (not cached)
# and retried on a later load, so a burst of feeds can't queue unbounded work.
MAX_PENDING_FETCHES = 500

TWEET_URL_RE = re.compile(
    r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/\w+/status/\d+", re.IGNORECASE
)
X_OEMBED_URL = "https://publish.x.com/oembed"
OEMBED_FIELDS = ("type", "html", "author_name", "author_url", "provider_name")
HTML_CONTENT_TYPE = "text/html"

# Mini-app embed tags, newest first (fc:frame is the pre-rename name).
MINIAPP_TAG_NAMES = ("miniapp", "frame")
# The app only recognises the pre-rename action type, so both are emitted as it.
LAUNCH_ACTION_TYPE = "launch_frame"
MAX_MINIAPP_FIELD_CHARS = 1024
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")
# Farcaster's own mini-app directory pages legitimately launch another domain.
# Any other page may only launch itself, so a cast link can't dress up as a
# card for one app and open another.
MINIAPP_DIRECTORY_HOSTS = frozenset(
    {"farcaster.xyz", "www.farcaster.xyz", "farcaster.com", "warpcast.com"}
)


@dataclass
class _LoopState:
    """Fetch state bound to one event loop (one in production; one per test)."""

    client: httpx.AsyncClient = field(
        default_factory=lambda: create_client(FETCH_TIMEOUT)
    )
    semaphore: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(MAX_CONCURRENT_FETCHES)
    )
    # URL -> its running fetch, so concurrent feeds share one fetch per URL.
    # Also the strong refs that let fetches outlive the request that started
    # them.
    in_flight: dict[str, asyncio.Task] = field(default_factory=dict)


_loop_states: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, _LoopState] = (
    weakref.WeakKeyDictionary()
)


def _loop_state() -> _LoopState:
    loop = asyncio.get_running_loop()
    if loop not in _loop_states:
        _loop_states[loop] = _LoopState()
    return _loop_states[loop]


def _get_client() -> httpx.AsyncClient:
    return _loop_state().client


def _cache_key(url: str) -> str:
    return CACHE_KEY_PREFIX + hashlib.sha256(url.encode()).hexdigest()


def _embeds_missing_metadata(payload: Any) -> list[dict]:
    embeds: list[dict] = []
    for cast in iter_cast_dicts(payload):
        for embed in cast.get("embeds") or []:
            if (
                isinstance(embed, dict)
                and isinstance(embed.get("url"), str)
                and not embed.get("metadata")
            ):
                embeds.append(embed)
    return embeds


def _metadata_from_og(content_type: str, og: dict[str, str]) -> dict:
    html_meta: dict[str, Any] = {}
    if og.get("title"):
        html_meta["ogTitle"] = og["title"]
    if og.get("description"):
        html_meta["ogDescription"] = og["description"]
    image = og.get("image", "")
    if image.startswith(("http://", "https://")):
        html_meta["ogImage"] = [{"url": image}]
    metadata: dict[str, Any] = {"content_type": content_type}
    if html_meta:
        metadata["html"] = html_meta
    return metadata


def _bounded_str(value: Any) -> str | None:
    if isinstance(value, str) and 0 < len(value) <= MAX_MINIAPP_FIELD_CHARS:
        return value
    return None


def _https_url(value: Any) -> str | None:
    url = _bounded_str(value)
    if url is None:
        return None
    parsed = urllib.parse.urlparse(url)
    return url if parsed.scheme == "https" and parsed.hostname else None


def _launch_url(page_url: str, action_url: str | None) -> str:
    """The action's URL if this page may launch it, else the page itself."""
    if action_url is None:
        return page_url
    page_host = urllib.parse.urlparse(page_url).hostname
    action_host = urllib.parse.urlparse(action_url).hostname
    if action_host == page_host or page_host in MINIAPP_DIRECTORY_HOSTS:
        return action_url
    return page_url


def _launch_action(page_url: str, action: Any) -> dict[str, str]:
    if not isinstance(action, dict):
        action = {}
    color = action.get("splashBackgroundColor")
    optional_fields = {
        "name": _bounded_str(action.get("name")),
        "splash_image_url": _https_url(action.get("splashImageUrl")),
        "splash_background_color": (
            color if isinstance(color, str) and HEX_COLOR_RE.match(color) else None
        ),
    }
    return {
        "type": LAUNCH_ACTION_TYPE,
        "url": _launch_url(page_url, _https_url(action.get("url"))),
        **{key: value for key, value in optional_fields.items() if value},
    }


def _miniapp_from_fc(page_url: str, fc: dict[str, str]) -> dict | None:
    """Map an ``fc:miniapp``/``fc:frame`` embed to Neynar's ``fc_frame`` shape.

    Only allowlisted, type-checked fields pass: the JSON is attacker-written
    and the app turns it into a launch button.
    """
    raw = next((fc[name] for name in MINIAPP_TAG_NAMES if name in fc), None)
    if raw is None:
        return None
    try:
        embed = json.loads(raw)  # legacy v1 frames ("vNext") aren't JSON
    except ValueError:
        return None
    if not isinstance(embed, dict):
        return None
    image_url = _https_url(embed.get("imageUrl"))
    button = embed.get("button")
    if image_url is None or not isinstance(button, dict):
        return None
    frame: dict[str, Any] = {
        "image_url": image_url,
        "button": {"action": _launch_action(page_url, button.get("action"))},
    }
    if title := _bounded_str(button.get("title")):
        frame["button"]["title"] = title
    if version := _bounded_str(embed.get("version")):
        frame["version"] = version
    return frame


async def _fetch_tweet_metadata(url: str) -> dict:
    response = await _get_client().get(
        X_OEMBED_URL,
        params={"url": url, "omit_script": "1"},
        follow_redirects=True,
    )
    if response.status_code != httpx.codes.OK:
        return {}
    data = response.json()
    if not isinstance(data, dict):
        return {}
    oembed = {key: data[key] for key in OEMBED_FIELDS if isinstance(data.get(key), str)}
    return {"content_type": HTML_CONTENT_TYPE, "html": {"oembed": oembed}}


async def _fetch_page_metadata(url: str) -> dict:
    preview = await fetch_link_preview(_get_client(), url)
    if preview is None or not preview.content_type:
        return {}
    metadata = _metadata_from_og(preview.content_type, preview.og)
    if miniapp := _miniapp_from_fc(url, preview.fc):
        metadata["fc_frame"] = miniapp
    return metadata


async def _fetch_metadata(url: str) -> dict:
    """Metadata for ``url``; ``{}`` when nothing could be learned."""
    fetch = _fetch_tweet_metadata if TWEET_URL_RE.match(url) else _fetch_page_metadata
    try:
        async with _loop_state().semaphore:
            return await asyncio.wait_for(fetch(url), FETCH_DEADLINE_SECONDS)
    except UnsafeUrlError:
        return {}
    except (httpx.HTTPError, asyncio.TimeoutError, ValueError) as exc:
        logger.info("embed metadata fetch failed for %r: %r", url, exc)
        return {}
    except Exception:
        # The page is attacker-controlled and this is best-effort enrichment:
        # an unforeseen failure must not 500 every feed that shows the cast.
        logger.exception("embed metadata fetch crashed for %r", url)
        return {}


async def _read_cache(redis: aioredis.Redis | None, urls: list[str]) -> dict[str, dict]:
    if redis is None:
        return {}
    try:
        raw_values = await redis.mget([_cache_key(url) for url in urls])
    except RedisError:
        logger.warning("embed metadata cache read failed", exc_info=True)
        return {}
    cached: dict[str, dict] = {}
    for url, raw in zip(urls, raw_values):
        if raw is None:
            continue
        try:
            value = json.loads(raw)
        except ValueError:
            continue
        if isinstance(value, dict):
            cached[url] = value
    return cached


async def _write_cache(redis: aioredis.Redis | None, url: str, metadata: dict) -> None:
    if redis is None:
        return
    ttl = CACHE_TTL_SECONDS if metadata else NEGATIVE_CACHE_TTL_SECONDS
    try:
        await redis.set(_cache_key(url), json.dumps(metadata), ex=ttl)
    except RedisError:
        logger.warning("embed metadata cache write failed", exc_info=True)


async def _fetch_and_cache(redis: aioredis.Redis | None, url: str) -> dict:
    metadata = await _fetch_metadata(url)
    await _write_cache(redis, url, metadata)
    return metadata


async def _fetch_misses(
    redis: aioredis.Redis | None, urls: list[str]
) -> dict[str, dict]:
    in_flight = _loop_state().in_flight
    tasks: dict[str, asyncio.Task] = {}
    for url in urls:
        if url not in in_flight:
            if len(in_flight) >= MAX_PENDING_FETCHES:
                continue
            in_flight[url] = asyncio.create_task(_fetch_and_cache(redis, url))
            in_flight[url].add_done_callback(lambda _, url=url: in_flight.pop(url))
        tasks[url] = in_flight[url]
    if not tasks:
        return {}
    await asyncio.wait(tasks.values(), timeout=FETCH_WAIT_SECONDS)
    return {
        url: task.result()
        for url, task in tasks.items()
        if task.done() and not task.cancelled()
    }


async def hydrate_embed_metadata(
    payload: Any, *, redis: aioredis.Redis | None = None
) -> Any:
    """Fill ``metadata`` on URL embeds that lack it, in place; returns ``payload``."""
    embeds = _embeds_missing_metadata(payload)
    if not embeds:
        return payload
    urls = list(dict.fromkeys(embed["url"] for embed in embeds))[:MAX_URLS_PER_PAYLOAD]
    metadata_by_url = await _read_cache(redis, urls)
    misses = [url for url in urls if url not in metadata_by_url]
    if misses:
        metadata_by_url.update(await _fetch_misses(redis, misses))
    for embed in embeds:
        metadata = metadata_by_url.get(embed["url"])
        if metadata:
            embed["metadata"] = metadata
    return payload
