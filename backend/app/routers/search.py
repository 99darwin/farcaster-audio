"""Global search router — casts and miniapps via Neynar.

Operator parsing (`from:`, `before:`, `after:`) happens server-side via
``app.services.search_query``. The client just sends a raw query string.
We forward to Neynar with `viewer_fid` injected from the JWT so the
upstream response carries the caller's viewer context.

User and channel search live elsewhere (`/v1/users/search`,
`/v1/feed/channels/search`) and are reused as-is.
"""

from __future__ import annotations

import logging
from typing import Literal

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_redis, get_spam_service
from app.routers.feed import NEYNAR_BASE, _neynar_headers, _raise_upstream_error
from app.services.block_service import filter_casts, get_blocked_fids
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from app.services.search_query import parse_cast_query
from app.services.spam_service import SpamService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/search", tags=["search"])

SEARCH_RATE_LIMIT_PER_MIN = 30
SEARCH_RATE_LIMIT_WINDOW_SECONDS = 60


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


async def _resolve_author_fid(
    client: httpx.AsyncClient,
    username: str,
    viewer_fid: int,
) -> int | None:
    """Resolve a username to an FID via Neynar. Returns None on 404."""
    resp = await client.get(
        f"{NEYNAR_BASE}/farcaster/user/by_username",
        params={"username": username, "viewer_fid": viewer_fid},
        headers=_neynar_headers(),
        timeout=15.0,
    )
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    # Neynar's user/by_username can return either {"user": {...}} or the
    # user dict at the top level depending on plan/version — accept both.
    user = data.get("user") or data
    fid = user.get("fid") if isinstance(user, dict) else None
    return int(fid) if fid is not None else None


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
    """Search Farcaster casts via Neynar with operator support."""
    await _enforce_search_rate_limit(current_user, redis)
    parsed = parse_cast_query(q)
    parsed_payload = parsed.model_dump(mode="json")

    async with httpx.AsyncClient() as client:
        author_fid: int | None = None
        if parsed.author_username:
            author_fid = await _resolve_author_fid(
                client, parsed.author_username, current_user
            )
            if author_fid is None:
                return {
                    "casts": [],
                    "next": {"cursor": None},
                    "meta": {"parsed": parsed_payload, "unknown_author": True},
                }

        # Neynar's cast/search requires a non-empty `q`. If the user only
        # typed an operator (e.g. `from:dwr`), fall back to the original
        # raw query so the upstream call doesn't 400.
        upstream_q = parsed.text or q

        params: dict[str, str | int] = {
            "q": upstream_q,
            "viewer_fid": current_user,
            "limit": limit,
            "sort_type": "algorithmic" if sort == "popular" else "desc_chron",
        }
        if cursor:
            params["cursor"] = cursor
        if author_fid is not None:
            params["author_fid"] = author_fid

        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/cast/search",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    # Neynar's payload shape varies between API versions for cast/search —
    # accept either {"result": {"casts": [...], "next": {...}}} or the
    # flatter {"casts": [...], "next": {...}}.
    result_block = data.get("result") if isinstance(data.get("result"), dict) else {}
    casts = result_block.get("casts") or data.get("casts", []) or []
    next_block = result_block.get("next") or data.get("next") or {}
    next_cursor = next_block.get("cursor") if isinstance(next_block, dict) else None

    # Hydrate identical to feed/following so reactions/bookmarks/spam flags
    # line up with what the user sees elsewhere.
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
    params: dict[str, str | int] = {"q": q, "limit": limit}
    if cursor:
        params["cursor"] = cursor

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/frame/search",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code == 404:
        return {"frames": [], "next": {"cursor": None}, "meta": {"unsupported": True}}
    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    frames_raw = data.get("frames") or data.get("result", {}).get("frames", []) or []
    next_block = data.get("next") or data.get("result", {}).get("next") or {}
    next_cursor = next_block.get("cursor") if isinstance(next_block, dict) else None

    frames: list[dict] = []
    for frame in frames_raw:
        if not isinstance(frame, dict):
            continue
        # Defense-in-depth: only forward miniapps with an https frames_url so
        # the client never receives a non-web scheme to hand to Linking.openURL.
        frames_url = frame.get("frames_url")
        if not isinstance(frames_url, str) or not frames_url.startswith("https://"):
            continue
        entry: dict = {
            "name": frame.get("name"),
            "image_url": frame.get("image_url"),
            "frames_url": frames_url,
        }
        author = frame.get("author")
        if author is not None:
            entry["author"] = author
        frames.append(entry)

    return {
        "frames": frames,
        "next": {"cursor": next_cursor},
        "meta": {"unsupported": False},
    }
