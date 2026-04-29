"""
GIFs router — proxies Giphy search/trending so the API key stays server-side.

Clients call /v1/gifs/search and /v1/gifs/trending with a JWT; we forward to
Giphy with our key and transform the response to a stable client contract so
we can swap providers later without breaking the app.
"""

import logging
import re
from urllib.parse import urlencode, urlparse

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import settings
from app.dependencies import get_current_user, get_redis
from app.schemas.gifs import GifResult, GifSearchResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/gifs", tags=["gifs"])

GIPHY_BASE = "https://api.giphy.com/v1/gifs"
GIPHY_RATING = "pg-13"
GIPHY_TIMEOUT_SECONDS = 10.0
DEFAULT_LIMIT = 24
MAX_LIMIT = 50

# Per-FID rate limit on /v1/gifs/* (combined across search + trending).
# Giphy's free tier is ~1000/day; 60/min/fid is generous for typing-debounce
# patterns yet stops a single client from draining the shared budget.
GIFS_RATE_LIMIT_PER_MIN = 60
GIFS_RATE_LIMIT_WINDOW_SEC = 60

# Allowlist for upstream-provided URLs. Giphy serves media from
# media.giphy.com, media[0-9].giphy.com, i.giphy.com, etc. — anything
# under giphy.com is fine, anything else gets dropped before we ever
# embed it in a Farcaster cast.
_GIPHY_HOST_RE = re.compile(r"^([a-z0-9-]+\.)?giphy\.com$")


class _GiphyUpstreamError(Exception):
    """Raised when the upstream Giphy call fails. Carries no api_key."""


def _parse_int_safe(value: str | int | None, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _is_safe_giphy_url(url: str | None) -> bool:
    """Validate that ``url`` is an https URL hosted on a giphy.com subdomain."""
    if not url:
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    if not parsed.netloc:
        return False
    return bool(_GIPHY_HOST_RE.match(parsed.netloc.lower()))


def _transform_giphy_response(payload: dict) -> GifSearchResponse:
    items = payload.get("data") or []
    results: list[GifResult] = []
    for item in items:
        images = item.get("images") or {}
        original = images.get("original") or {}
        preview = images.get("fixed_width") or {}
        original_url = original.get("url")
        preview_url = preview.get("url") or original_url

        # Defense in depth: if Giphy ever returns a non-Giphy URL (compromise
        # or upstream bug), drop the GIF rather than embed an arbitrary URL
        # in a user's public cast under their identity.
        if not _is_safe_giphy_url(original_url) or not _is_safe_giphy_url(
            preview_url
        ):
            logger.warning(
                "[gifs] Dropping GIF with non-Giphy URL: id=%s",
                item.get("id"),
            )
            continue

        results.append(
            GifResult(
                id=item.get("id", ""),
                gifUrl=original_url,
                previewUrl=preview_url,
                width=_parse_int_safe(original.get("width"), 1),
                height=_parse_int_safe(original.get("height"), 1),
            )
        )

    pagination = payload.get("pagination") or {}
    offset = _parse_int_safe(pagination.get("offset"), 0)
    count = _parse_int_safe(pagination.get("count"), 0)
    total = _parse_int_safe(pagination.get("total_count"), 0)
    next_start = offset + count
    next_offset: int | None = next_start if next_start < total else None

    return GifSearchResponse(results=results, next_offset=next_offset)


def _require_api_key() -> str:
    key = settings.GIPHY_API_KEY
    if not key:
        # Fail at request time so missing keys don't break unrelated startup.
        raise HTTPException(
            status_code=503,
            detail="GIF search is temporarily unavailable",
        )
    return key


async def _enforce_gifs_rate_limit(
    fid: int, redis: aioredis.Redis
) -> None:
    """Per-FID Redis-backed rate limit shared across /search and /trending.

    Mirrors ``RoomService._enforce_recording_rate_limit`` — sliding window
    via ``INCR`` + ``EXPIRE``. Exact accuracy isn't the goal; preventing
    one authenticated client from draining the Giphy quota is.
    """
    key = f"gifs:rl:{fid}"
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, GIFS_RATE_LIMIT_WINDOW_SEC)
    if count > GIFS_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit exceeded (max {GIFS_RATE_LIMIT_PER_MIN} "
                "requests/min)"
            ),
            headers={"Retry-After": str(GIFS_RATE_LIMIT_WINDOW_SEC)},
        )


async def _giphy_call(signed_url: str) -> httpx.Response:
    """Issue the actual upstream request.

    On httpx errors, drop ``signed_url`` (which contains the api_key in
    its query string) from this frame's locals BEFORE re-raising, so the
    key cannot end up in Sentry's frame-local capture for any frame in
    the propagated traceback / __context__ chain.
    """
    try:
        async with httpx.AsyncClient(timeout=GIPHY_TIMEOUT_SECONDS) as client:
            return await client.get(signed_url)
    except httpx.HTTPError:
        # Removing the parameter binding so it isn't in f_locals at the
        # point the exception escapes this frame.
        del signed_url
        raise


def _build_signed_url(path: str, query: dict) -> str:
    """Inline-fetch the api_key, build the URL, and let both fall out of
    scope when this function returns. The returned string still contains
    the key, but we hand it directly to ``_giphy_call`` and never store
    it on a frame that re-raises."""
    return (
        f"{GIPHY_BASE}/{path}?"
        f"{urlencode({'api_key': settings.GIPHY_API_KEY, **query})}"
    )


async def _fetch_giphy(path: str, query: dict) -> dict:
    """Call Giphy and return parsed JSON, or raise a sanitized exception.

    Security note: this frame deliberately does NOT bind ``api_key`` (or
    the signed URL containing it) to a local that survives past the
    network call. ``_build_signed_url`` returns a string that's passed
    straight into ``_giphy_call`` and not assigned. If httpx raises, the
    only locals on this frame are ``path`` and ``query`` (no key).
    Sentry's ``include_local_variables`` therefore cannot leak the key
    from any frame in this call chain. We additionally set
    ``include_local_variables=False`` in ``app.main`` as defense in depth.
    """
    try:
        resp = await _giphy_call(_build_signed_url(path, query))
    except httpx.HTTPError:
        raise _GiphyUpstreamError(f"network error calling {path}") from None

    if resp.status_code >= 400:
        # Sanitize before logging — upstream body is attacker-influenceable
        # in principle (Giphy is trusted, but defense in depth) and embedded
        # newlines/tabs would let it inject fake log lines into structured
        # log parsers.
        raw_preview = resp.text[:200]
        body_preview = "".join(
            c if c.isprintable() else " " for c in raw_preview
        )
        status_code = resp.status_code
        logger.error("[gifs] Giphy %s -> %s: %s", path, status_code, body_preview)
        raise HTTPException(status_code=502, detail="Upstream service error")

    try:
        return resp.json()
    except ValueError:
        logger.error("[gifs] Giphy %s returned non-JSON body", path)
        raise HTTPException(status_code=502, detail="Upstream service error")


async def _safe_fetch_giphy(path: str, query: dict) -> dict:
    """Wrap ``_fetch_giphy`` so the network-error log/raise happens in a
    frame whose locals are secret-free."""
    try:
        return await _fetch_giphy(path, query)
    except _GiphyUpstreamError:
        # Locals here: path, query (no api_key), exception. Safe to log.
        logger.exception("[gifs] Upstream Giphy request failed: path=%s", path)
        raise HTTPException(status_code=502, detail="Upstream service error")


@router.get("/search", response_model=GifSearchResponse)
async def search_gifs(
    q: str = Query(..., min_length=1, max_length=128),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
) -> GifSearchResponse:
    """Search Giphy for GIFs matching the query. Auth required."""
    _require_api_key()  # 503 fast if not configured; return value not bound.
    await _enforce_gifs_rate_limit(fid, redis)
    payload = await _safe_fetch_giphy(
        "search",
        {
            "q": q,
            "limit": limit,
            "offset": offset,
            "rating": GIPHY_RATING,
        },
    )
    return _transform_giphy_response(payload)


@router.get("/trending", response_model=GifSearchResponse)
async def trending_gifs(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
) -> GifSearchResponse:
    """Return trending GIFs. Auth required."""
    _require_api_key()  # 503 fast if not configured; return value not bound.
    await _enforce_gifs_rate_limit(fid, redis)
    payload = await _safe_fetch_giphy(
        "trending",
        {
            "limit": limit,
            "offset": offset,
            "rating": GIPHY_RATING,
        },
    )
    return _transform_giphy_response(payload)
