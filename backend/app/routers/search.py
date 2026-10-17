"""Global search router — casts via Hypersnap, miniapps via Neynar.

Operator parsing (`from:`, `before:`, `after:`) happens server-side via
``app.services.search_query``. The client just sends a raw query string.
Hypersnap has no ``viewer_fid``, so the caller's viewer context is hydrated
locally (``app.services.farcaster_hydration``).

User and channel search live elsewhere (`/v1/users/search`,
`/v1/feed/channels/search`) and are reused as-is.
"""

from __future__ import annotations

import logging
from typing import Literal
from urllib.parse import urlsplit

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.config import settings
from app.dependencies import get_current_user, get_db, get_redis, get_spam_service
from app.services.block_service import filter_casts, get_blocked_fids
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from app.services.farcaster_hydration import prepare_cast_payload
from app.services.search_query import parse_cast_query
from app.services.spam_service import SpamService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/search", tags=["search"])

SEARCH_RATE_LIMIT_PER_MIN = 30
SEARCH_RATE_LIMIT_WINDOW_SECONDS = 60
MINIAPP_SEARCH_QUERY_MAX_LENGTH = 32
MINIAPP_UNSUPPORTED_STATUSES = {400, 403, 404, 405, 410, 422}
# Mini-app search stays on Neynar (MINIAPP_SEARCH_PROVIDER) until Hypersnap
# implements frame search/catalog; it returns 501 today.
NEYNAR_BASE = "https://api.neynar.com/v2"


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


def _raise_upstream_error(resp: httpx.Response) -> None:
    """Log the full Neynar response, raise a sanitized error to the client."""
    logger.error(
        "[search] Neynar %s → %s: %s",
        resp.request.url.path,
        resp.status_code,
        resp.text[:500],
    )
    status = 502 if resp.status_code >= 500 else resp.status_code
    raise HTTPException(status_code=status, detail="Upstream service error")


async def _enforce_search_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    """Bound search request churn per authenticated user.

    Each `/v1/search/casts` call can fan out to two Neynar requests
    (`user/by_username` for `from:` resolution + `cast/search`), so a
    moderate per-user cap keeps upstream cost and quota usage in check.
    """
    rate_key = f"search:rl:{fid}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, SEARCH_RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if int(count) > SEARCH_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Search rate limit exceeded. Try again later.",
            headers={"Retry-After": str(SEARCH_RATE_LIMIT_WINDOW_SECONDS)},
        )


async def _resolve_author_fid(username: str) -> int | None:
    """Resolve a username to an FID via Hypersnap. Returns None on 404."""
    try:
        data = await hypersnap.get("/user/by-username", {"username": username})
    except hypersnap.HypersnapNotFound:
        return None
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="search")

    # Accept both {"user": {...}} and a top-level user dict.
    user = data.get("user") or data
    fid = user.get("fid") if isinstance(user, dict) else None
    return int(fid) if fid is not None else None


def _miniapp_empty_response(*, unsupported: bool) -> dict:
    """Return the stable mini-app response contract for degraded requests."""
    return {
        "frames": [],
        "next": {"cursor": None},
        "meta": {
            "source": "fallback",
            "metrics_available": False,
            "unsupported": unsupported,
        },
    }


def _https_url(value: object) -> str | None:
    """Accept only absolute HTTPS URLs without embedded credentials."""
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            return None
    except ValueError:
        return None
    return value


def _nonempty_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _normalize_miniapp_frame(frame: object) -> dict | None:
    """Map Neynar's legacy and current mini-app shapes to one contract."""
    if not isinstance(frame, dict):
        return None

    frames_url = _https_url(frame.get("frames_url"))
    if frames_url is None:
        return None

    manifest = frame.get("manifest")
    manifest = manifest if isinstance(manifest, dict) else {}
    config = manifest.get("miniapp")
    if not isinstance(config, dict):
        config = manifest.get("frame")
    config = config if isinstance(config, dict) else {}

    name = (
        _nonempty_string(frame.get("name"))
        or _nonempty_string(config.get("name"))
        or _nonempty_string(frame.get("title"))
        or urlsplit(frames_url).hostname
        or "Mini App"
    )
    description = _nonempty_string(frame.get("description")) or _nonempty_string(
        config.get("description")
    )
    image_url = (
        _https_url(frame.get("image_url"))
        or _https_url(frame.get("image"))
        or _https_url(config.get("icon_url"))
        or _https_url(config.get("image_url"))
    )
    author = frame.get("author")
    metrics = frame.get("metrics")
    rank = frame.get("rank")

    return {
        "name": name,
        "description": description,
        "image_url": image_url,
        "frames_url": frames_url,
        "author": author if isinstance(author, dict) else None,
        "metrics": metrics if isinstance(metrics, dict) and metrics else None,
        "rank": (
            rank
            if isinstance(rank, (int, float)) and not isinstance(rank, bool)
            else None
        ),
    }


def _parse_miniapp_payload(data: object) -> tuple[list[dict], str | None, bool]:
    """Safely parse any upstream JSON value without assuming object nesting."""
    if not isinstance(data, dict):
        return [], None, False

    result = data.get("result")
    result = result if isinstance(result, dict) else {}
    frames_raw = data.get("frames")
    if not isinstance(frames_raw, list):
        frames_raw = result.get("frames")
    if not isinstance(frames_raw, list):
        frames_raw = []

    frames = [
        normalized
        for raw_frame in frames_raw
        if (normalized := _normalize_miniapp_frame(raw_frame)) is not None
    ]

    next_block = data.get("next")
    if not isinstance(next_block, dict):
        next_block = result.get("next")
    next_block = next_block if isinstance(next_block, dict) else {}
    next_cursor = next_block.get("cursor")
    if not isinstance(next_cursor, str) or not next_cursor:
        next_cursor = None

    return frames, next_cursor, any(frame["metrics"] is not None for frame in frames)


async def _fetch_miniapps(
    *, endpoint: Literal["search", "catalog"], params: dict[str, str | int]
) -> dict:
    """Fetch and normalize mini apps, degrading unsupported APIs safely."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{NEYNAR_BASE}/farcaster/frame/{endpoint}/",
                params=params,
                headers=_neynar_headers(),
                timeout=15.0,
            )
    except httpx.HTTPError as exc:
        logger.warning("[search] Neynar mini-app %s request failed: %s", endpoint, exc)
        return _miniapp_empty_response(unsupported=False)

    if resp.status_code == 401:
        # An upstream credential failure is not an end-user auth failure. A 401
        # here would trigger the web client's refresh/logout path incorrectly.
        logger.error("[search] Neynar mini-app %s authentication failed", endpoint)
        return _miniapp_empty_response(unsupported=False)
    if resp.status_code in MINIAPP_UNSUPPORTED_STATUSES:
        logger.info(
            "[search] Neynar mini-app %s unavailable (status=%s)",
            endpoint,
            resp.status_code,
        )
        return _miniapp_empty_response(unsupported=True)
    if resp.status_code != 200:
        _raise_upstream_error(resp)

    try:
        data = resp.json()
    except (TypeError, ValueError):
        logger.warning("[search] Neynar mini-app %s returned invalid JSON", endpoint)
        return _miniapp_empty_response(unsupported=False)

    frames, next_cursor, metrics_available = _parse_miniapp_payload(data)
    if not isinstance(data, dict):
        logger.warning(
            "[search] Neynar mini-app %s returned unexpected payload type %s",
            endpoint,
            type(data).__name__,
        )
        return _miniapp_empty_response(unsupported=False)

    return {
        "frames": frames,
        "next": {"cursor": next_cursor},
        "meta": {
            "source": "neynar",
            "metrics_available": metrics_available,
            "unsupported": False,
        },
    }


@router.get("/casts")
async def search_casts(
    q: str = Query(..., min_length=1, max_length=200),
    sort: Literal["popular", "recent"] = Query(default="popular"),
    limit: int = Query(default=20, ge=1, le=25),
    cursor: str | None = Query(default=None, max_length=500),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    spam_service: SpamService = Depends(get_spam_service),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Search Farcaster casts via Hypersnap with operator support.

    ``sort`` is accepted for client compatibility but no longer forwarded:
    Hypersnap's cast search has no ``sort_type`` and returns its own order.
    """
    await _enforce_search_rate_limit(current_user, redis)
    parsed = parse_cast_query(q)
    parsed_payload = parsed.model_dump(mode="json")

    author_fid: int | None = None
    if parsed.author_username:
        author_fid = await _resolve_author_fid(parsed.author_username)
        if author_fid is None:
            return {
                "casts": [],
                "next": {"cursor": None},
                "meta": {"parsed": parsed_payload, "unknown_author": True},
            }

    # cast/search requires a non-empty `q`. If the user only typed an
    # operator (e.g. `from:dwr`), fall back to the original raw query so the
    # upstream call doesn't 400.
    upstream_q = parsed.text or q
    params: dict[str, str | int | None] = {
        "q": upstream_q,
        "limit": limit,
        "cursor": cursor,
        "author_fid": author_fid,
    }
    try:
        data = await hypersnap.get("/cast/search", params)
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="search")

    # Accept either {"result": {"casts": [...], "next": {...}}} (Hypersnap,
    # Neynar v2) or the flatter {"casts": [...], "next": {...}}.
    result_block = data.get("result") if isinstance(data.get("result"), dict) else {}
    casts = result_block.get("casts") or data.get("casts", []) or []
    next_block = result_block.get("next") or data.get("next") or {}
    next_cursor = next_block.get("cursor") if isinstance(next_block, dict) else None

    # Hydrate identical to feed/following so reactions/bookmarks/spam flags
    # line up with what the user sees elsewhere.
    await prepare_cast_payload(
        casts, current_user, redis=redis, backfill_reaction_counts=True
    )
    await spam_service.annotate_casts(casts)
    blocked_fids = await get_blocked_fids(db, current_user)
    casts = filter_casts(casts, blocked_fids)
    await annotate_bookmarked_casts(db, current_user, {"casts": casts})

    return {
        "casts": casts,
        "next": {"cursor": next_cursor},
        "meta": {"parsed": parsed_payload, "unknown_author": False},
    }


@router.get("/miniapps")
async def search_miniapps(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(default=12, ge=1, le=25),
    cursor: str | None = Query(default=None, max_length=500),
    current_user: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Search Farcaster mini-apps (frames) via Neynar.

    Neynar returns 404 when the underlying frame search isn't enabled for
    the current plan — surface that as ``meta.unsupported`` so the client
    can hide the tab gracefully instead of showing an error.
    """
    await _enforce_search_rate_limit(current_user, redis)
    # Neynar documents a 32-character maximum. Keep the client-facing limit
    # generous and truncate upstream so a long search never turns into a 422.
    params: dict[str, str | int] = {
        "q": q[:MINIAPP_SEARCH_QUERY_MAX_LENGTH],
        "limit": limit,
    }
    if cursor:
        params["cursor"] = cursor
    return await _fetch_miniapps(endpoint="search", params=params)


@router.get("/miniapps/discover")
async def discover_miniapps(
    limit: int = Query(default=24, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=500),
    current_user: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Return Neynar's curated mini-app catalog in the stable client contract.

    Neynar uses engagement signals to order this catalog but does not expose
    numeric app metrics in the documented response. Consequently, metrics and
    rank remain ``null`` unless the upstream explicitly supplies those fields.
    """
    await _enforce_search_rate_limit(current_user, redis)
    params: dict[str, str | int] = {"limit": limit, "time_window": "7d"}
    if cursor:
        params["cursor"] = cursor
    return await _fetch_miniapps(endpoint="catalog", params=params)
