"""Single async read client for the Hypersnap node.

Hypersnap's ``/v2/farcaster/*`` API mirrors Neynar's response shapes and needs
no API key. Node-native endpoints live under ``/v1/*`` (``/v1/info``,
``/v1/signersByFid``, ``/v1/submitMessage``).

Usage::

    from app.clients import hypersnap

    try:
        data = await hypersnap.get("/user/bulk", {"fids": "3,5650"})
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc)

All callers share one ``httpx.AsyncClient`` (connection pooling, uniform
timeouts). Every request is bounded by an overall deadline
(:data:`REQUEST_DEADLINE_SECONDS`) and a response-body cap
(:data:`MAX_RESPONSE_BYTES`). Errors are typed: :class:`HypersnapNotFound`
for 404, :class:`HypersnapResponseTooLarge` past the body cap, and
:class:`HypersnapUpstreamError` for every other failure (non-2xx, transport,
deadline, undecodable body).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Iterator, Mapping
from typing import Any, NoReturn, Self

import httpx
from fastapi import HTTPException

from app.config import require_https_in_production, settings

logger = logging.getLogger(__name__)

V2_PREFIX = "/v2/farcaster"
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
DEFAULT_MAX_PAGES = 10
# Overall wall-clock bound per request (connect + headers + full body).
# ``DEFAULT_TIMEOUT`` only bounds each socket operation, so a slow-drip body
# could otherwise hold a request open indefinitely.
REQUEST_DEADLINE_SECONDS = 30.0
# Idempotent GETs are retried this many times after a transport failure
# (e.g. a ReadTimeout): the public node drops the occasional request.
GET_TRANSPORT_RETRIES = 1
# Decoded response bodies larger than this are aborted mid-stream.
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
HEADER_CONTENT_TYPE = "content-type"
HEADER_CONTENT_LENGTH = "content-length"
# Upstream bodies are logged (never returned) and truncated to this length.
LOGGED_BODY_CHARS = 500
UPSTREAM_ERROR_DETAIL = "Upstream service error"
HTTP_NOT_FOUND = 404
HTTP_BAD_GATEWAY = 502
HTTP_SERVER_ERROR_FLOOR = 500
# Hypersnap's /v2 API returns 20-byte message hashes as bare hex, while /v1,
# Neynar and every Juke route use the 0x-prefixed form. /v2 bodies are
# normalised so hashes compare and route consistently.
BARE_HASH_PATTERN = re.compile(r"[0-9a-fA-F]{40}")
HASH_KEY = "hash"
HASH_KEY_SUFFIX = "_hash"
# Hypersnap's /v2 casts carry protocol text: ``@username`` mentions are
# stripped out and recorded as zero-width UTF-8 byte ranges. Neynar inlined
# them, which is what every client renders, so /v2 bodies are normalised to
# that form. Channel mentions are never stripped (they stay literal text).
TEXT_KEY = "text"
MENTIONS_KEY = "mentioned_profiles"
MENTION_RANGES_KEY = "mentioned_profiles_ranges"
USERNAME_KEY = "username"
RANGE_START_KEY = "start"
RANGE_END_KEY = "end"
MENTION_PREFIX = "@"
# Protocol cap; a cast claiming more is malformed and left untouched.
MAX_MENTIONS_PER_CAST = 10

Params = Mapping[str, Any] | None


class HypersnapError(Exception):
    """Base class for Hypersnap failures.

    ``status_code`` is the upstream HTTP status (``None`` for transport
    failures); ``body`` is the truncated upstream body, for logs only.
    """

    def __init__(
        self,
        message: str,
        *,
        path: str,
        status_code: int | None = None,
        body: str = "",
    ) -> None:
        super().__init__(message)
        self.path = path
        self.status_code = status_code
        self.body = body

    @classmethod
    def from_response(cls, message: str, resp: httpx.Response, full_path: str) -> Self:
        """Carry the upstream status and truncated body (for logs only)."""
        return cls(
            message,
            path=full_path,
            status_code=resp.status_code,
            body=resp.text[:LOGGED_BODY_CHARS],
        )


class HypersnapNotFound(HypersnapError):
    """The node returned 404 for the requested resource."""


class HypersnapUpstreamError(HypersnapError):
    """Non-2xx (other than 404), transport failure, or undecodable body."""


class HypersnapResponseTooLarge(HypersnapUpstreamError):
    """The response body exceeded :data:`MAX_RESPONSE_BYTES`; it was aborted."""


class HypersnapClient:
    """Thin async wrapper over one shared ``httpx.AsyncClient``."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: httpx.Timeout = DEFAULT_TIMEOUT,
        deadline_seconds: float = REQUEST_DEADLINE_SECONDS,
        max_response_bytes: int = MAX_RESPONSE_BYTES,
    ) -> None:
        self._base_url = (base_url or settings.HYPERSNAP_HTTP_URL).rstrip("/")
        require_https_in_production(
            self._base_url,
            setting_name="HYPERSNAP_HTTP_URL",
            environment=settings.ENVIRONMENT,
        )
        self._deadline_seconds = deadline_seconds
        self._max_response_bytes = max_response_bytes
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=timeout,
            transport=transport,
            headers={"accept": "application/json"},
        )

    @property
    def base_url(self) -> str:
        return self._base_url

    async def aclose(self) -> None:
        await self._http.aclose()

    async def get(self, path: str, params: Params = None) -> dict[str, Any]:
        """GET a ``/v2/farcaster`` endpoint; ``path`` excludes the prefix.

        Cast hashes in the response are ``0x``-prefixed (see
        :func:`prefix_cast_hashes`) and mentions are inlined into cast text
        (see :func:`inline_cast_mentions`).
        """
        data = await self._get_json(V2_PREFIX + _normalize_path(path), params)
        return inline_cast_mentions(prefix_cast_hashes(data))

    async def get_v1(self, path: str, params: Params = None) -> dict[str, Any]:
        """GET a node-native ``/v1`` endpoint, e.g. ``/signersByFid``."""
        return await self._get_json("/v1" + _normalize_path(path), params)

    async def post_v1_bytes(
        self, path: str, content: bytes, *, content_type: str
    ) -> httpx.Response:
        """POST raw bytes to a ``/v1`` endpoint and return the raw response.

        Status handling is left to the caller (``submitMessage`` has its own
        error envelope); only transport, deadline and body-cap failures are
        mapped here. The returned response is fully buffered.
        """
        full_path = "/v1" + _normalize_path(path)
        return await self._request(
            "POST",
            full_path,
            content=content,
            headers={HEADER_CONTENT_TYPE: content_type},
        )

    async def request(
        self, method: str, full_path: str, **kwargs: Any
    ) -> httpx.Response:
        """Raw request (``full_path`` includes its prefix) under the deadline
        and body cap. Status handling is left to the caller; used by the
        signed webhook-management client."""
        return await self._request(method, full_path, **kwargs)

    async def paginate(
        self,
        path: str,
        params: Params = None,
        *,
        max_pages: int = DEFAULT_MAX_PAGES,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield successive ``/v2/farcaster`` pages following ``next.cursor``.

        The cursor is opaque and passed back verbatim. Stops when the node
        returns no cursor, repeats a cursor, or ``max_pages`` is reached.
        """
        if max_pages < 1:
            raise ValueError("max_pages must be >= 1")
        page_params = dict(params or {})
        seen_cursors: set[str] = set()
        for _ in range(max_pages):
            page = await self.get(path, page_params)
            yield page
            cursor = _next_cursor(page)
            if not cursor or cursor in seen_cursors:
                return
            seen_cursors.add(cursor)
            page_params["cursor"] = cursor

    async def _request(
        self, method: str, full_path: str, **kwargs: Any
    ) -> httpx.Response:
        """Send one request under the deadline and body cap.

        Returns a buffered ``httpx.Response`` (``.json()``/``.text`` work)
        holding at most ``max_response_bytes`` of decoded body.
        """
        try:
            async with asyncio.timeout(self._deadline_seconds):
                async with self._http.stream(method, full_path, **kwargs) as resp:
                    body = await self._read_capped(resp, full_path)
        except TimeoutError:
            raise HypersnapUpstreamError(
                "Hypersnap request exceeded deadline", path=full_path
            ) from None
        except httpx.HTTPError as exc:
            raise HypersnapUpstreamError(
                f"Hypersnap transport error: {type(exc).__name__}", path=full_path
            ) from exc
        # Rebuilt without transfer headers: ``body`` is already decoded.
        headers = {}
        if HEADER_CONTENT_TYPE in resp.headers:
            headers[HEADER_CONTENT_TYPE] = resp.headers[HEADER_CONTENT_TYPE]
        return httpx.Response(
            resp.status_code, headers=headers, content=body, request=resp.request
        )

    async def _get_with_retry(
        self, full_path: str, params: dict[str, Any]
    ) -> httpx.Response:
        for _ in range(GET_TRANSPORT_RETRIES):
            try:
                return await self._request("GET", full_path, params=params)
            except HypersnapUpstreamError as exc:
                if not isinstance(exc.__cause__, httpx.TransportError):
                    raise
                logger.warning(
                    "Hypersnap GET %s transport error, retrying: %s",
                    full_path,
                    type(exc.__cause__).__name__,
                )
        return await self._request("GET", full_path, params=params)

    async def _read_capped(self, resp: httpx.Response, full_path: str) -> bytes:
        declared = resp.headers.get(HEADER_CONTENT_LENGTH)
        if (
            declared is not None
            and declared.isdigit()
            and int(declared) > self._max_response_bytes
        ):
            raise self._too_large(resp, full_path)
        chunks: list[bytes] = []
        received = 0
        async for chunk in resp.aiter_bytes():
            received += len(chunk)
            if received > self._max_response_bytes:
                raise self._too_large(resp, full_path)
            chunks.append(chunk)
        return b"".join(chunks)

    def _too_large(
        self, resp: httpx.Response, full_path: str
    ) -> HypersnapResponseTooLarge:
        return HypersnapResponseTooLarge(
            f"Hypersnap response exceeded {self._max_response_bytes} bytes",
            path=full_path,
            status_code=resp.status_code,
        )

    async def _get_json(self, full_path: str, params: Params) -> dict[str, Any]:
        resp = await self._get_with_retry(full_path, _clean_params(params))
        if resp.status_code == HTTP_NOT_FOUND:
            raise HypersnapNotFound.from_response(
                "Hypersnap resource not found", resp, full_path
            )
        if resp.is_error:
            raise HypersnapUpstreamError.from_response(
                f"Hypersnap returned HTTP {resp.status_code}", resp, full_path
            )
        try:
            data = resp.json()
        except ValueError as exc:
            raise HypersnapUpstreamError.from_response(
                "Hypersnap returned a non-JSON body", resp, full_path
            ) from exc
        if not isinstance(data, dict):
            raise HypersnapUpstreamError.from_response(
                "Hypersnap returned a non-object JSON body", resp, full_path
            )
        return data


def prefix_cast_hashes(data: Any) -> Any:
    """Return ``data`` with bare-hex cast hashes ``0x``-prefixed, in place.

    Applies to every ``hash`` / ``*_hash`` key at any depth (casts, parents,
    threads, embedded and quoted casts) whose value is exactly 40 hex chars.
    """
    for node in _iter_dicts(data):
        for key, value in node.items():
            if (
                isinstance(value, str)
                and _is_hash_key(key)
                and BARE_HASH_PATTERN.fullmatch(value)
            ):
                node[key] = "0x" + value.lower()
    return data


def inline_cast_mentions(data: Any) -> Any:
    """Return ``data`` with mentions spliced into cast text, in place.

    Every cast at any depth whose mention ranges are all zero-width gets
    ``@username`` inserted at those byte offsets and its ranges rewritten to
    span the inserted tokens (Neynar's shape). Casts with already-inlined or
    malformed mentions are left untouched.
    """
    for node in _iter_dicts(data):
        _inline_mentions(node)
    return data


def _inline_mentions(cast: dict[str, Any]) -> None:
    text = cast.get(TEXT_KEY)
    mentions = cast.get(MENTIONS_KEY)
    ranges = cast.get(MENTION_RANGES_KEY)
    if not isinstance(text, str) or not mentions:
        return
    if not isinstance(mentions, list) or not isinstance(ranges, list):
        return
    if len(mentions) != len(ranges) or len(mentions) > MAX_MENTIONS_PER_CAST:
        return
    try:
        encoded = text.encode()
        insertions = [
            _mention_insertion(mention, span, encoded)
            for mention, span in zip(mentions, ranges, strict=True)
        ]
    except UnicodeEncodeError:  # lone surrogates decode from JSON escapes
        return
    if None in insertions:
        return
    spliced = bytearray()
    cursor = 0
    for position, token, span in sorted(insertions, key=lambda item: item[0]):
        spliced += encoded[cursor:position]
        span[RANGE_START_KEY] = len(spliced)
        spliced += token
        span[RANGE_END_KEY] = len(spliced)
        cursor = position
    spliced += encoded[cursor:]
    cast[TEXT_KEY] = spliced.decode()


def _mention_insertion(
    mention: Any, span: Any, encoded: bytes
) -> tuple[int, bytes, dict[str, Any]] | None:
    """``(offset, b"@name", span)`` for a usable zero-width mention, else
    ``None`` (the cast is left untouched)."""
    if not isinstance(mention, dict) or not isinstance(span, dict):
        return None
    username = mention.get(USERNAME_KEY)
    start = span.get(RANGE_START_KEY)
    if not isinstance(username, str) or not username:
        return None
    if type(start) is not int or span.get(RANGE_END_KEY) != start:
        return None
    if not _is_char_boundary(encoded, start):
        return None
    return start, (MENTION_PREFIX + username).encode(), span


def _is_char_boundary(encoded: bytes, position: int) -> bool:
    if not 0 <= position <= len(encoded):
        return False
    # UTF-8 continuation bytes are 0b10xxxxxx.
    return position == len(encoded) or encoded[position] & 0xC0 != 0x80


def _iter_dicts(data: Any) -> Iterator[dict[str, Any]]:
    """Yield every dict in a decoded JSON value, at any depth.

    Walks with an explicit stack: ``json`` decodes nesting deeper than the
    interpreter's recursion limit, so recursion here could raise. Callers may
    reassign existing keys of the yielded dict before the walk resumes.
    """
    stack = [data]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, dict):
            yield node
            stack.extend(
                value for value in node.values() if isinstance(value, (list, dict))
            )


def _is_hash_key(key: str) -> bool:
    return key == HASH_KEY or key.endswith(HASH_KEY_SUFFIX)


def _normalize_path(path: str) -> str:
    return path if path.startswith("/") else "/" + path


def _clean_params(params: Params) -> dict[str, Any]:
    """Drop ``None`` values so optional params can be passed unconditionally."""
    if not params:
        return {}
    return {key: value for key, value in params.items() if value is not None}


def _next_cursor(page: Mapping[str, Any]) -> str | None:
    next_block = page.get("next")
    if not isinstance(next_block, Mapping):
        return None
    cursor = next_block.get("cursor")
    return cursor if isinstance(cursor, str) and cursor else None


def raise_for_upstream(exc: HypersnapError, *, context: str = "hypersnap") -> NoReturn:
    """Log the full upstream failure, raise a sanitized ``HTTPException``.

    Mirrors ``routers/search.py::_raise_upstream_error``: 5xx and transport
    failures become 502, upstream 4xx statuses pass through, and the client
    only ever sees ``"Upstream service error"``.
    """
    logger.error(
        "[%s] Hypersnap %s → %s: %s",
        context,
        exc.path,
        exc.status_code if exc.status_code is not None else "transport-error",
        exc.body or str(exc),
    )
    status = exc.status_code
    if status is None or status >= HTTP_SERVER_ERROR_FLOOR:
        status = HTTP_BAD_GATEWAY
    raise HTTPException(status_code=status, detail=UPSTREAM_ERROR_DETAIL) from exc


# ---------------------------------------------------------------------------
# Process-wide shared client
# ---------------------------------------------------------------------------

_client: HypersnapClient | None = None


def get_client() -> HypersnapClient:
    """Return the lazily-created process-wide client."""
    global _client
    if _client is None:
        _client = HypersnapClient()
    return _client


def set_client(client: HypersnapClient | None) -> None:
    """Replace the shared client (tests, or runtime base-URL switching)."""
    global _client
    _client = client


async def close_client() -> None:
    """Close the shared client; call from the app lifespan shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def get(path: str, params: Params = None) -> dict[str, Any]:
    return await get_client().get(path, params)


async def get_v1(path: str, params: Params = None) -> dict[str, Any]:
    return await get_client().get_v1(path, params)


def paginate(
    path: str, params: Params = None, *, max_pages: int = DEFAULT_MAX_PAGES
) -> AsyncIterator[dict[str, Any]]:
    return get_client().paginate(path, params, max_pages=max_pages)
