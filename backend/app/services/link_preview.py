"""SSRF-safe fetching of link previews (content type + Open Graph tags).

Shared by the composer's ``GET /v1/feed/og`` and feed embed hydration
(:mod:`app.services.embed_metadata`). URLs are attacker-controlled (anyone can
cast a link), so:

* every hop is checked twice: the hostname must resolve only to public
  addresses before connecting, and the peer actually connected to must be
  public before any body is read (closes the DNS-rebinding gap between our
  lookup and httpx's);
* bodies are decompressed by hand with a hard output cap, so a gzip bomb
  can't expand past :data:`MAX_HTML_BYTES`;
* OG parsing is linear in the page size (no backtracking regex over the
  whole page).
"""

from __future__ import annotations

import asyncio
import html
import ipaddress
import re
import socket
import urllib.parse
import zlib
from dataclasses import dataclass, field

import httpx

USER_AGENT = "farcaster-audio-bot/1.0 (link preview)"
MAX_REDIRECTS = 5
# OG tags live in <head>, which can be huge (YouTube's ends ~780 KB in).
# Reading stops at </head> or this many decoded bytes, whichever comes first.
MAX_HTML_BYTES = 1024 * 1024
HEAD_END_MARKER = b"</head>"
META_TAG_START = "<meta"
TAG_END = ">"
# Real <meta> tags are short; longer "tags" are skipped, bounding attr parsing.
# fc:miniapp tags carry entity-encoded JSON, so allow some headroom.
MAX_META_TAG_CHARS = 8192
OG_PREFIX = "og:"
FC_PREFIX = "fc:"
META_PREFIXES = (OG_PREFIX, FC_PREFIX)
HTTP_SCHEMES = ("http", "https")
# Only the standard web ports: an explicit port turns the fetcher into a
# port scanner against public hosts (and odd services on them).
ALLOWED_PORTS = frozenset({80, 443})
# Only encodings we can decompress with a bounded output size.
ACCEPT_ENCODING = "gzip, deflate"
IDENTITY_ENCODING = "identity"
# zlib ``wbits``: 16+MAX_WBITS for gzip, MAX_WBITS for zlib-wrapped deflate.
DECOMPRESS_WBITS = {"gzip": 16 + zlib.MAX_WBITS, "deflate": zlib.MAX_WBITS}
DEFAULT_CHARSET = "utf-8"
# IPv6 prefixes that embed an IPv4 address the packet is really bound for.
NAT64_NETWORK = ipaddress.ip_network("64:ff9b::/96")

_ATTRIBUTE_RE = re.compile(
    r"""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""", re.IGNORECASE
)


class UnsafeUrlError(ValueError):
    """The URL is not http(s), does not resolve, or resolves to a private IP."""


@dataclass(frozen=True)
class LinkPreview:
    """What a fetch learned: the final ``content_type`` plus ``og:*`` and
    ``fc:*`` (mini-app embed) meta tags, keyed without their prefix."""

    content_type: str
    og: dict[str, str] = field(default_factory=dict)
    fc: dict[str, str] = field(default_factory=dict)


def create_client(timeout: httpx.Timeout | float) -> httpx.AsyncClient:
    """An ``AsyncClient`` for preview fetches.

    ``trust_env=False``: a proxy from the environment would make the peer
    check see the proxy's address and resolve hostnames out of our sight.
    """
    return httpx.AsyncClient(timeout=timeout, trust_env=False)


def is_private_ip(ip_str: str) -> bool:
    """Whether an address isn't publicly routable (unparseable counts)."""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped:
            return is_private_ip(str(addr.ipv4_mapped))
        if addr.sixtofour:
            return is_private_ip(str(addr.sixtofour))
        if addr in NAT64_NETWORK:
            return is_private_ip(str(ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)))
    return not addr.is_global or addr.is_multicast


async def assert_public_url(target: str) -> None:
    """Raise :class:`UnsafeUrlError` unless ``target`` resolves only publicly."""
    parsed = urllib.parse.urlparse(target)
    if parsed.scheme not in HTTP_SCHEMES:
        raise UnsafeUrlError("Only http/https URLs are allowed")
    if not parsed.hostname:
        raise UnsafeUrlError("Invalid URL")
    try:
        port = parsed.port
    except ValueError as exc:
        raise UnsafeUrlError("Invalid URL port") from exc
    if port is not None and port not in ALLOWED_PORTS:
        raise UnsafeUrlError("Only ports 80 and 443 are allowed")
    try:
        resolved = await asyncio.get_running_loop().getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise UnsafeUrlError("Cannot resolve hostname") from exc
    if any(is_private_ip(sockaddr[0]) for *_, sockaddr in resolved):
        raise UnsafeUrlError("URL resolves to a blocked address")


def _iter_meta_tags(page: str):
    """Yield the inside of each ``<meta ...>`` tag in one linear pass."""
    lowered = page.lower()
    cursor = 0
    while (start := lowered.find(META_TAG_START, cursor)) != -1:
        end = lowered.find(TAG_END, start)
        if end == -1:
            return
        if end - start <= MAX_META_TAG_CHARS:
            yield page[start + len(META_TAG_START) : end]
        cursor = end + 1


def parse_meta_tags(page: str) -> dict[str, str]:
    """Extract ``og:*``/``fc:*`` meta tags by full name (first wins), decoded."""
    tags: dict[str, str] = {}
    for tag in _iter_meta_tags(page):
        attributes = {
            match.group(1).lower(): next(g for g in match.groups()[1:] if g is not None)
            for match in _ATTRIBUTE_RE.finditer(tag)
        }
        key = (attributes.get("property") or attributes.get("name") or "").lower()
        if key.startswith(META_PREFIXES) and "content" in attributes:
            tags.setdefault(key, html.unescape(attributes["content"]))
    return tags


def _strip_prefix(tags: dict[str, str], prefix: str) -> dict[str, str]:
    return {k[len(prefix) :]: v for k, v in tags.items() if k.startswith(prefix)}


def _assert_public_peer(response: httpx.Response) -> None:
    stream = response.extensions.get("network_stream")
    server_addr = stream.get_extra_info("server_addr") if stream else None
    if server_addr and is_private_ip(server_addr[0]):
        raise UnsafeUrlError("Connected to a blocked address")


def _decode(body: bytes, charset: str | None) -> str:
    try:
        return body.decode(charset or DEFAULT_CHARSET, errors="replace")
    except LookupError:  # unknown charset label
        return body.decode(DEFAULT_CHARSET, errors="replace")


async def _read_head(response: httpx.Response) -> str:
    """Decoded ``<head>`` (capped), or ``""`` for an unsupported encoding."""
    content_encoding = response.headers.get(
        "content-encoding", IDENTITY_ENCODING
    ).lower()
    decompressor = None
    if content_encoding != IDENTITY_ENCODING:
        if content_encoding not in DECOMPRESS_WBITS:
            return ""
        decompressor = zlib.decompressobj(DECOMPRESS_WBITS[content_encoding])
    body = bytearray()
    try:
        async for raw in response.aiter_raw():
            remaining = MAX_HTML_BYTES - len(body)
            chunk = decompressor.decompress(raw, remaining) if decompressor else raw
            # Only the new chunk (plus overlap for a split marker) can newly
            # contain </head>, so don't rescan the whole buffer.
            scan_from = max(0, len(body) - len(HEAD_END_MARKER))
            body.extend(chunk[:remaining])
            if (
                len(body) >= MAX_HTML_BYTES
                or body.find(HEAD_END_MARKER, scan_from) != -1
            ):
                break
    except zlib.error:
        return ""
    return _decode(bytes(body), response.charset_encoding)


async def fetch_link_preview(client: httpx.AsyncClient, url: str) -> LinkPreview | None:
    """Fetch ``url`` (following safe redirects) and describe what it serves.

    Returns ``None`` for a non-200 final response. Only HTML bodies are read,
    and only up to ``</head>``. Raises :class:`UnsafeUrlError` if any hop
    targets a private address, and ``httpx.HTTPError`` on transport failure.
    """
    target = url
    headers = {"User-Agent": USER_AGENT, "Accept-Encoding": ACCEPT_ENCODING}
    for _ in range(MAX_REDIRECTS + 1):
        await assert_public_url(target)
        request = client.build_request("GET", target, headers=headers)
        response = await client.send(request, stream=True, follow_redirects=False)
        try:
            _assert_public_peer(response)
            location = response.headers.get("location")
            if response.is_redirect and location:
                target = urllib.parse.urljoin(str(response.url), location)
                continue
            if response.status_code != httpx.codes.OK:
                return None
            content_type = response.headers.get("content-type", "")
            media_type = content_type.split(";")[0].strip().lower()
            if "html" not in media_type:
                return LinkPreview(content_type=media_type)
            tags = parse_meta_tags(await _read_head(response))
            return LinkPreview(
                content_type=media_type,
                og=_strip_prefix(tags, OG_PREFIX),
                fc=_strip_prefix(tags, FC_PREFIX),
            )
        finally:
            await response.aclose()
    return None
