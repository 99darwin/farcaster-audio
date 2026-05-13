"""
Feed router — proxies Neynar API calls so the API key stays server-side.

The user's signer_uuid is always looked up from the database, never accepted
from the client, so it never leaves the backend.
"""

import asyncio
import ipaddress
import logging
import re
import socket
import urllib.parse
from typing import Literal

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import (
    _is_valid_neynar_signer,
    get_current_user,
    get_db,
    get_redis,
    get_spam_service,
    require_non_demo_user,
)
from app.models.cast_bookmark import CastBookmark
from app.models.user import User
from app.services.block_service import (
    get_blocked_fids,
    filter_casts,
    filter_thread_payload,
)
from app.services.media_embed import normalize_media_embed_url
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from app.services.spam_service import SpamService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/feed", tags=["feed"])

NEYNAR_BASE = "https://api.neynar.com/v2"
BOOKMARK_RATE_LIMIT_PER_MIN = 120
BOOKMARK_RATE_LIMIT_WINDOW_SECONDS = 60
MAX_BOOKMARKS_PER_USER = 5000


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


def _raise_upstream_error(resp: httpx.Response) -> None:
    """Log the full Neynar response, raise a sanitized error to the client."""
    logger.error(
        "[feed] Neynar %s → %s: %s",
        resp.request.url.path,
        resp.status_code,
        resp.text[:500],
    )
    status = 502 if resp.status_code >= 500 else resp.status_code
    raise HTTPException(status_code=status, detail="Upstream service error")


async def _enforce_bookmark_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    """Bound bookmark write churn by authenticated user."""
    rate_key = f"cast_bookmark:rl:{fid}"
    pipe = redis.pipeline()
    pipe.incr(rate_key)
    pipe.expire(rate_key, BOOKMARK_RATE_LIMIT_WINDOW_SECONDS)
    count, _ = await pipe.execute()
    if int(count) > BOOKMARK_RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail="Bookmark rate limit exceeded. Try again later.",
            headers={"Retry-After": str(BOOKMARK_RATE_LIMIT_WINDOW_SECONDS)},
        )


async def _ensure_bookmark_capacity(db: AsyncSession, fid: int) -> None:
    result = await db.execute(
        select(func.count()).select_from(CastBookmark).where(CastBookmark.fid == fid)
    )
    if result.scalar_one() >= MAX_BOOKMARKS_PER_USER:
        raise HTTPException(
            status_code=429,
            detail="Bookmark limit reached.",
        )


async def _get_signer_uuid(db: AsyncSession, fid: int) -> str:
    """Look up the user's signer_uuid from the database."""
    result = await db.execute(select(User.signer_uuid).where(User.fid == fid))
    signer_uuid = result.scalar_one_or_none()
    logger.info(
        "[feed] signer_uuid lookup for fid=%s: found=%s", fid, bool(signer_uuid)
    )
    if not signer_uuid:
        raise HTTPException(status_code=400, detail="No signer found for user")
    # Defense-in-depth: any non-UUID signer (demo-readonly, dev-signer, legacy
    # sentinels) cannot cast to Neynar.
    if not _is_valid_neynar_signer(signer_uuid):
        raise HTTPException(
            status_code=403,
            detail="Sign in with Farcaster to post or host.",
        )
    return signer_uuid


# --- Request schemas ---


class ReactionRequest(BaseModel):
    reaction_type: Literal["like", "recast"]
    target: str = Field(pattern=r"^0x[a-fA-F0-9]+$")


class CastIdEmbed(BaseModel):
    fid: int
    hash: str = Field(pattern=r"^0x[a-fA-F0-9]+$")


class CastRequest(BaseModel):
    text: str = Field(max_length=10000)
    parent: str | None = Field(default=None, pattern=r"^0x[a-fA-F0-9]+$")
    embeds: list[HttpUrl] | None = Field(default=None, max_length=4)
    quote: CastIdEmbed | None = None
    channel_id: str | None = Field(
        default=None,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
    )


# --- Endpoints ---


@router.get("/following")
async def feed_following(
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(
        default=None, max_length=500, pattern=r"^[a-zA-Z0-9_\-=.%]+$"
    ),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    spam_service: SpamService = Depends(get_spam_service),
):
    """Proxy Neynar feed/following endpoint."""
    params: dict[str, str | int] = {
        "fid": current_user,
        "limit": limit,
        "viewer_fid": current_user,
    }
    if cursor:
        params["cursor"] = cursor

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/feed/following",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    await spam_service.annotate_casts(data.get("casts", []))
    blocked_fids = await get_blocked_fids(db, current_user)
    data["casts"] = filter_casts(data.get("casts", []), blocked_fids)
    await annotate_bookmarked_casts(db, current_user, data)
    return data


@router.get("/channel/{channel_id}")
async def feed_channel(
    channel_id: str = Path(..., pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$"),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(
        default=None,
        max_length=500,
        pattern=r"^[a-zA-Z0-9_\-=.%]+$",
    ),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    spam_service: SpamService = Depends(get_spam_service),
):
    """Proxy Neynar channel feed endpoint for a single Farcaster channel."""
    params: dict[str, str | int] = {
        "channel_ids": channel_id,
        "limit": limit,
        "viewer_fid": current_user,
    }
    if cursor:
        params["cursor"] = cursor

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/feed/channels",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    await spam_service.annotate_casts(data.get("casts", []))
    blocked_fids = await get_blocked_fids(db, current_user)
    data["casts"] = filter_casts(data.get("casts", []), blocked_fids)
    await annotate_bookmarked_casts(db, current_user, data)
    return data


async def _fetch_bookmarked_cast(
    client: httpx.AsyncClient,
    cast_hash: str,
    viewer_fid: int,
) -> dict | None:
    resp = await client.get(
        f"{NEYNAR_BASE}/farcaster/cast",
        params={"identifier": cast_hash, "type": "hash", "viewer_fid": viewer_fid},
        headers=_neynar_headers(),
        timeout=15.0,
    )
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    cast = data.get("cast", data)
    if not isinstance(cast, dict) or cast.get("hash") != cast_hash:
        return None

    cast["viewer_context"] = {
        **(cast.get("viewer_context") or {}),
        "bookmarked": True,
    }
    return cast


@router.get("/bookmarks")
async def list_bookmarks(
    limit: int = Query(default=25, ge=1, le=50),
    cursor: str | None = Query(default=None, max_length=10, pattern=r"^\d+$"),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    spam_service: SpamService = Depends(get_spam_service),
):
    """Return the user's private bookmark list as hydrated Neynar casts."""
    offset = int(cursor) if cursor else 0
    result = await db.execute(
        select(CastBookmark)
        .where(CastBookmark.fid == current_user)
        .order_by(CastBookmark.created_at.desc())
        .offset(offset)
        .limit(limit + 1)
    )
    rows = result.scalars().all()
    page = rows[:limit]
    next_cursor = str(offset + limit) if len(rows) > limit else None
    if not page:
        return {"casts": [], "next": {"cursor": None}}

    async with httpx.AsyncClient() as client:
        hydrated = await asyncio.gather(
            *(
                _fetch_bookmarked_cast(client, bookmark.cast_hash, current_user)
                for bookmark in page
            )
        )

    casts = [cast for cast in hydrated if cast is not None]
    await spam_service.annotate_casts(casts)
    return {"casts": casts, "next": {"cursor": next_cursor}}


@router.get("/channels/search")
async def search_channels(
    q: str = Query(
        ...,
        min_length=1,
        max_length=100,
        pattern=r"^[a-zA-Z0-9 _-]+$",
    ),
    limit: int = Query(default=8, ge=1, le=20),
    _current_user: int = Depends(get_current_user),
):
    """Search Farcaster channels by ID or name via Neynar."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/channel/search",
            params={"q": q, "limit": limit},
            headers=_neynar_headers(),
            timeout=10.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    channels = data.get("channels") or data.get("result", {}).get("channels", [])
    return {
        "channels": [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "description": c.get("description"),
                "image_url": c.get("image_url"),
                "follower_count": c.get("follower_count"),
            }
            for c in channels
            if c.get("id")
        ]
    }


@router.post("/cast")
async def create_cast(
    body: CastRequest,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Post a new cast (or reply) to Farcaster via Neynar."""
    if not body.text.strip() and not body.embeds and not body.quote:
        raise HTTPException(
            status_code=400,
            detail="Cast must have text, embeds, or a quote",
        )
    if body.parent and body.channel_id:
        raise HTTPException(status_code=400, detail="Replies cannot target a channel")
    signer_uuid = await _get_signer_uuid(db, current_user)

    payload: dict = {
        "signer_uuid": signer_uuid,
        "text": body.text,
    }
    if body.parent:
        payload["parent"] = body.parent
    embeds: list[dict] = []
    if body.embeds:
        embeds.extend(
            {"url": normalize_media_embed_url(str(url))} for url in body.embeds
        )
    if body.quote:
        embeds.append({"cast_id": {"fid": body.quote.fid, "hash": body.quote.hash}})
    if embeds:
        payload["embeds"] = embeds
    if body.channel_id:
        payload["channel_id"] = body.channel_id

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{NEYNAR_BASE}/farcaster/cast",
            json=payload,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


@router.get("/cast/thread")
async def get_cast_thread(
    hash: str = Query(..., pattern=r"^0x[a-fA-F0-9]+$"),
    reply_depth: int = Query(default=2, ge=1, le=5),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    spam_service: SpamService = Depends(get_spam_service),
):
    """Proxy Neynar cast conversation endpoint to fetch a thread."""
    params: dict[str, str | int] = {
        "identifier": hash,
        "type": "hash",
        "reply_depth": reply_depth,
        "viewer_fid": current_user,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/cast/conversation",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    await spam_service.annotate_thread(data)
    blocked_fids = await get_blocked_fids(db, current_user)
    data = filter_thread_payload(data, blocked_fids)
    await annotate_bookmarked_casts(db, current_user, data)
    return data


@router.post("/bookmarks/{cast_hash}", status_code=201)
async def create_bookmark(
    cast_hash: str = Path(..., pattern=r"^0x[a-fA-F0-9]+$"),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Bookmark a cast locally. Only the hash is stored."""
    await _enforce_bookmark_rate_limit(current_user, redis)
    existing = await db.execute(
        select(CastBookmark.cast_hash).where(
            CastBookmark.fid == current_user,
            CastBookmark.cast_hash == cast_hash,
        )
    )
    if existing.scalar_one_or_none():
        return {"status": "bookmarked"}
    await _ensure_bookmark_capacity(db, current_user)
    stmt = (
        pg_insert(CastBookmark)
        .values(fid=current_user, cast_hash=cast_hash)
        .on_conflict_do_nothing(index_elements=["fid", "cast_hash"])
    )
    await db.execute(stmt)
    await db.commit()
    return {"status": "bookmarked"}


@router.delete("/bookmarks/{cast_hash}")
async def delete_bookmark(
    cast_hash: str = Path(..., pattern=r"^0x[a-fA-F0-9]+$"),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Remove a local cast bookmark if it exists."""
    await _enforce_bookmark_rate_limit(current_user, redis)
    await db.execute(
        delete(CastBookmark).where(
            CastBookmark.fid == current_user,
            CastBookmark.cast_hash == cast_hash,
        )
    )
    await db.commit()
    return {"status": "unbookmarked"}


@router.delete("/cast/{cast_hash}")
async def delete_cast(
    cast_hash: str = Path(..., pattern=r"^0x[a-fA-F0-9]+$"),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a cast from Farcaster via Neynar."""
    signer_uuid = await _get_signer_uuid(db, current_user)

    async with httpx.AsyncClient() as client:
        resp = await client.request(
            "DELETE",
            f"{NEYNAR_BASE}/farcaster/cast",
            json={
                "signer_uuid": signer_uuid,
                "target_hash": cast_hash,
            },
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


@router.post("/reaction")
async def create_reaction(
    body: ReactionRequest,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Proxy Neynar reaction creation (like/recast). Injects signer server-side."""
    signer_uuid = await _get_signer_uuid(db, current_user)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{NEYNAR_BASE}/farcaster/reaction",
            json={
                "signer_uuid": signer_uuid,
                "reaction_type": body.reaction_type,
                "target": body.target,
            },
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


@router.delete("/reaction")
async def delete_reaction(
    body: ReactionRequest,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Proxy Neynar reaction deletion (unlike/unrecast). Injects signer server-side."""
    signer_uuid = await _get_signer_uuid(db, current_user)

    async with httpx.AsyncClient() as client:
        resp = await client.request(
            "DELETE",
            f"{NEYNAR_BASE}/farcaster/reaction",
            json={
                "signer_uuid": signer_uuid,
                "reaction_type": body.reaction_type,
                "target": body.target,
            },
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


# ---------------------------------------------------------------------------
# OG metadata preview — used by the composer to show a link preview before
# publishing. We scrape minimal OG tags server-side so the API key / scraping
# stays off the client.
# ---------------------------------------------------------------------------

# SSRF protection: block private/reserved IP ranges
_BLOCKED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

# Per-user rate limit: track recent requests (fid -> list of timestamps)
_og_rate_limits: dict[int, list[float]] = {}
_OG_RATE_LIMIT = 15  # requests per minute
_OG_MAX_BODY = 32768  # 32 KB


def _is_private_ip(ip_str: str) -> bool:
    """Check if an IP address belongs to a private/reserved network."""
    try:
        addr = ipaddress.ip_address(ip_str)
        return any(addr in net for net in _BLOCKED_NETWORKS)
    except ValueError:
        return True  # block on parse failure


def _check_url_safety(target: str) -> None:
    """Validate URL scheme and resolve DNS to block SSRF against internal hosts."""
    parsed = urllib.parse.urlparse(target)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http/https URLs are allowed")
    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="Invalid URL")
    try:
        resolved = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Cannot resolve hostname")
    for _family, _type, _proto, _canonname, sockaddr in resolved:
        if _is_private_ip(sockaddr[0]):
            raise HTTPException(
                status_code=400, detail="URL resolves to a blocked address"
            )


def _check_og_rate_limit(fid: int) -> None:
    """Simple in-memory per-user rate limit for OG fetches."""
    import time

    now = time.monotonic()
    window = _og_rate_limits.get(fid, [])
    # Prune entries older than 60s
    window = [t for t in window if now - t < 60]
    if len(window) >= _OG_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    window.append(now)
    _og_rate_limits[fid] = window


def _parse_og_tags(html: str) -> dict[str, str]:
    """Extract og:* meta tags from HTML. Runs in a thread to avoid blocking the event loop."""
    # Use atomic patterns to prevent catastrophic backtracking (no nested quantifiers)
    tag_re = re.compile(
        r'<meta\s[^>]*?(?:property|name)\s*=\s*["\']og:(\w+)["\'][^>]*?content\s*=\s*["\']([^"\']*)["\']',
        re.IGNORECASE,
    )
    tag_re_rev = re.compile(
        r'<meta\s[^>]*?content\s*=\s*["\']([^"\']*)["\'][^>]*?(?:property|name)\s*=\s*["\']og:(\w+)["\']',
        re.IGNORECASE,
    )
    og: dict[str, str] = {}
    for match in tag_re.finditer(html):
        og.setdefault(match.group(1).lower(), match.group(2))
    for match in tag_re_rev.finditer(html):
        og.setdefault(match.group(2).lower(), match.group(1))
    return og


class OgResponse(BaseModel):
    url: str
    title: str | None = None
    description: str | None = None
    image: str | None = None


@router.get("/og", response_model=OgResponse)
async def fetch_og_metadata(
    url: HttpUrl = Query(...),
    _current_user: int = Depends(get_current_user),
):
    """Fetch Open Graph metadata for a URL (composer link preview)."""
    target = str(url)

    # Rate limit per user
    _check_og_rate_limit(_current_user)

    # SSRF protection: validate scheme + resolve DNS before connecting
    _check_url_safety(target)

    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=8.0) as client:
            resp = await client.get(
                target,
                headers={"User-Agent": "farcaster-audio-bot/1.0 (OG preview)"},
            )
            # Handle redirects manually to re-validate each target
            redirects = 0
            while resp.is_redirect and redirects < 5:
                redirects += 1
                location = resp.headers.get("location", "")
                if not location:
                    break
                # Resolve relative redirects
                redirect_url = urllib.parse.urljoin(str(resp.url), location)
                _check_url_safety(redirect_url)
                resp = await client.get(
                    redirect_url,
                    headers={"User-Agent": "farcaster-audio-bot/1.0 (OG preview)"},
                )
    except HTTPException:
        raise
    except httpx.HTTPError:
        return OgResponse(url=target)

    if resp.status_code != 200:
        return OgResponse(url=target)

    # Only parse HTML responses
    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type:
        return OgResponse(url=target)

    # Stream-safe: httpx already read the body, but cap what we parse
    # Check Content-Length upfront to reject obviously huge responses
    cl = resp.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > 1_000_000:
        return OgResponse(url=target)

    html = resp.text[:_OG_MAX_BODY]

    # Run regex parsing in a thread with a timeout to prevent ReDoS
    try:
        og = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, _parse_og_tags, html),
            timeout=2.0,
        )
    except asyncio.TimeoutError:
        return OgResponse(url=target)

    # Validate OG image URL scheme
    image_url = og.get("image")
    if image_url and not image_url.startswith(("http://", "https://")):
        image_url = None

    return OgResponse(
        url=target,
        title=og.get("title"),
        description=og.get("description"),
        image=image_url,
    )
