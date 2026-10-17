"""
Feed router — proxies feed reads and publishes the user's writes.

Writes (casts, threads, reactions, deletes) are signed server-side with the
user's approved Hypersnap app signer, which never leaves the backend, and
submitted as protocol messages via ``app.services.farcaster_writes``.
"""

import asyncio
import enum
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import BaseModel, Field, HttpUrl, model_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.dependencies import (
    get_current_user,
    get_db,
    get_redis,
    get_spam_service,
    require_non_demo_user,
)
from app.models.cast_bookmark import CastBookmark
from app.models.scheduled_cast import ScheduledCast
from app.models.user import User
from app.schemas.common import CAST_HASH_PATTERN
from app.services.block_service import (
    get_blocked_fids,
    filter_casts,
    filter_thread_payload,
)
from app.services.cast_ledger import record_cast
from app.services.cast_thread import ThreadSegmentInput, publish_thread
from app.services.farcaster_writes import (
    cast_ref,
    cast_response,
    load_user_signer,
    publish_cast,
    publish_cast_removal,
    publish_reaction,
    validate_embed_urls,
    write_errors_as_http,
)
from app.services.link_preview import (
    UnsafeUrlError,
    create_client,
    fetch_link_preview,
)
from app.services.media_embed import normalize_media_embed_url
from app.services.rate_limit import RateLimit, enforce_rate_limits
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from app.services.farcaster_hydration import (
    invalidate_viewer_reactions,
    normalize_cast_hashes,
    prepare_cast_payload,
)
from app.services.parent_casts import attach_parent_casts
from app.services.following_feed import fetch_following_page
from app.services.reaction_counts import (
    hydrate_reaction_counts,
    invalidate_reaction_counts,
)
from app.services.social_graph import get_following_fids
from app.services.spam_service import SpamService
from app.services.thread_ancestors import (
    fetch_thread_ancestors,
    trim_hidden_ancestors,
)
from app.services.scheduled_cast_publisher import (
    MAX_ACTIVE_SCHEDULED_CASTS_PER_USER,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/feed", tags=["feed"])

BOOKMARK_RATE_LIMIT_PER_MIN = 120
BOOKMARK_RATE_LIMIT_WINDOW_SECONDS = 60
# Each thread read can fan out to ~11 upstream calls (see thread_ancestors);
# generous for browsing, but bounds a single account hammering Hypersnap.
THREAD_READ_RATE_LIMIT_PER_MIN = 120
THREAD_READ_RATE_LIMIT_WINDOW_SECONDS = 60
# Thread publishing fans out into up to 10 sequential upstream calls with
# retries, so it is rate limited far more aggressively than single casts.
THREAD_RATE_LIMIT_PER_MIN = 5
THREAD_RATE_LIMIT_WINDOW_SECONDS = 60
# Publish and read are separate buckets: browsing threads must not burn the
# publish budget (and vice versa).
THREAD_PUBLISH_RATE_KEY = "cast_thread:publish:rl:{fid}"
THREAD_READ_RATE_KEY = "cast_thread:read:rl:{fid}"
# Single-cast publishing (composer, replies, and live-space chat replies,
# which post through this endpoint). Sized for a fast chatter in a space;
# bounds a stolen session / script spamming Farcaster under the user's
# signer.
CAST_RATE_LIMITS = (
    ("cast_create:rl:min:{fid}", RateLimit(limit=20, window_seconds=60)),
    ("cast_create:rl:day:{fid}", RateLimit(limit=500, window_seconds=24 * 60 * 60)),
)
CAST_RATE_LIMITED_DETAIL = "Cast rate limit exceeded. Try again later."
MAX_BOOKMARKS_PER_USER = 5000
# A live cast answers in well under a second; Hypersnap hangs on a deleted one.
BOOKMARK_LOOKUP_TIMEOUT_SECONDS = 3.0
# A bookmarked cast that keeps hanging (while its siblings answer) is treated
# as deleted: one strike per cooldown, pruned at BOOKMARK_PRUNE_STRIKES.
BOOKMARK_PRUNE_STRIKES = 3
BOOKMARK_STRIKE_COOLDOWN_SECONDS = 60 * 60
BOOKMARK_STRIKE_TTL_SECONDS = 7 * 24 * 60 * 60
BOOKMARK_STRIKE_PREFIX = "cast_bookmark:unresponsive:"
# Scheduled posts must be deliberate rather than an accidental immediate cast,
# and are capped to keep queue growth bounded. The one-year horizon is part of
# the public API contract; clients should not offer dates beyond it.
MIN_SCHEDULE_DELAY = timedelta(seconds=30)
MAX_SCHEDULE_HORIZON = timedelta(days=365)


async def _fetch_cast_page(
    path: str,
    params: dict[str, str | int | None],
    *,
    viewer_fid: int,
    redis: aioredis.Redis,
) -> dict:
    """GET a cast-bearing Hypersnap read and adapt it to the Neynar contract.

    Normalizes hashes to ``0x`` form and hydrates ``viewer_context`` (which
    Hypersnap omits, having no ``viewer_fid``). Upstream failures surface as
    sanitized ``HTTPException``s.
    """
    try:
        data = await hypersnap.get(path, params)
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="feed")
    return await prepare_cast_payload(data, viewer_fid, redis=redis)


async def _enforce_fixed_window_rate_limit(
    redis: aioredis.Redis,
    *,
    key: str,
    limit: int,
    window_seconds: int,
    detail: str,
) -> None:
    """Fixed-window per-key rate limit backed by a Redis counter."""
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, window_seconds)
    count, _ = await pipe.execute()
    if int(count) > limit:
        raise HTTPException(
            status_code=429,
            detail=detail,
            headers={"Retry-After": str(window_seconds)},
        )


async def _enforce_bookmark_rate_limit(fid: int, redis: aioredis.Redis) -> None:
    """Bound bookmark write churn by authenticated user."""
    await _enforce_fixed_window_rate_limit(
        redis,
        key=f"cast_bookmark:rl:{fid}",
        limit=BOOKMARK_RATE_LIMIT_PER_MIN,
        window_seconds=BOOKMARK_RATE_LIMIT_WINDOW_SECONDS,
        detail="Bookmark rate limit exceeded. Try again later.",
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


# --- Request schemas ---


class ReactionRequest(BaseModel):
    reaction_type: Literal["like", "recast"]
    target: str = Field(pattern=CAST_HASH_PATTERN)


class CastIdEmbed(BaseModel):
    fid: int
    hash: str = Field(pattern=CAST_HASH_PATTERN)


class CastRequest(BaseModel):
    text: str = Field(max_length=10000)
    parent: str | None = Field(default=None, pattern=CAST_HASH_PATTERN)
    embeds: list[HttpUrl] | None = Field(default=None, max_length=4)
    quote: CastIdEmbed | None = None
    channel_id: str | None = Field(
        default=None,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
    )


class ScheduledCastRequest(CastRequest):
    scheduled_for: datetime


class ThreadSegment(BaseModel):
    text: str = Field(max_length=10000)
    embeds: list[HttpUrl] | None = Field(default=None, max_length=4)
    quote: CastIdEmbed | None = None

    @model_validator(mode="after")
    def _require_content(self) -> "ThreadSegment":
        # Same rule as _validate_cast_request, enforced at parse time (422).
        # No combined embeds+quote cap: like /v1/feed/cast, up to 4 URL
        # embeds plus a quote are forwarded as-is (Farcaster Pro accepts 4).
        # If Neynar rejects a segment for the caller's tier, the 207 partial
        # path returns the published prefix + failed_index for recovery.
        if not self.text.strip() and not self.embeds and not self.quote:
            raise ValueError("Each segment must have text, embeds, or a quote")
        return self


class CastThreadRequest(BaseModel):
    casts: list[ThreadSegment] = Field(min_length=2, max_length=10)
    # Farcaster cast hashes are exactly 20 bytes; bound the pattern so
    # oversized junk is rejected here instead of forwarded upstream.
    parent: str | None = Field(default=None, pattern=r"^0x[a-fA-F0-9]{40}$")
    channel_id: str | None = Field(
        default=None,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
    )

    @model_validator(mode="after")
    def _validate_thread(self) -> "CastThreadRequest":
        if self.parent and self.channel_id:
            raise ValueError("Replies cannot target a channel")
        if any(segment.quote is not None for segment in self.casts[1:]):
            raise ValueError("A quote is only allowed on the first segment")
        return self


def _validate_cast_request(body: CastRequest) -> None:
    if not body.text.strip() and not body.embeds and not body.quote:
        raise HTTPException(
            status_code=400,
            detail="Cast must have text, embeds, or a quote",
        )
    if body.parent and body.channel_id:
        raise HTTPException(status_code=400, detail="Replies cannot target a channel")


def _normalized_embed_urls(body: CastRequest) -> list[str]:
    return [normalize_media_embed_url(str(url)) for url in (body.embeds or [])]


def _scheduled_cast_json(job: ScheduledCast) -> dict:
    return {
        "id": str(job.id),
        "text": job.text,
        "parent": job.parent,
        "embeds": job.embeds or [],
        "quote": (
            {"fid": job.quote_fid, "hash": job.quote_hash}
            if job.quote_fid is not None and job.quote_hash is not None
            else None
        ),
        "channel_id": job.channel_id,
        "scheduled_for": job.scheduled_for,
        "next_attempt_at": job.next_attempt_at,
        "status": job.status,
        "attempts": job.attempts,
        "last_error": job.last_error,
        "published_hash": job.published_hash,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "published_at": job.published_at,
        "cancelled_at": job.cancelled_at,
    }


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
    redis: aioredis.Redis = Depends(get_redis),
):
    """Return the viewer's following feed, shaped like X's Following timeline.

    See :mod:`app.services.following_feed` for which replies are shown.
    """
    following_fids, blocked_fids = await asyncio.gather(
        get_following_fids(redis, current_user),
        get_blocked_fids(db, current_user),
    )
    data = await fetch_following_page(
        viewer_fid=current_user,
        limit=limit,
        cursor=cursor,
        following_fids=following_fids,
        blocked_fids=blocked_fids,
    )
    parents = await attach_parent_casts(
        data["casts"], blocked_fids=blocked_fids, redis=redis
    )
    await asyncio.gather(
        prepare_cast_payload(data, current_user, redis=redis),
        hydrate_reaction_counts(parents, redis=redis),
    )
    await spam_service.annotate_casts([*data["casts"], *parents])
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
    redis: aioredis.Redis = Depends(get_redis),
):
    """Return the cast feed for a single Farcaster channel from Hypersnap."""
    data = await _fetch_cast_page(
        "/feed/channels",
        {"channel_ids": channel_id, "limit": limit, "cursor": cursor},
        viewer_fid=current_user,
        redis=redis,
    )
    blocked_fids = await get_blocked_fids(db, current_user)
    data["casts"] = filter_casts(data.get("casts", []), blocked_fids)
    parents = await attach_parent_casts(
        data["casts"], blocked_fids=blocked_fids, redis=redis
    )
    await prepare_cast_payload(
        parents, current_user, redis=redis, backfill_reaction_counts=True
    )
    await spam_service.annotate_casts([*data["casts"], *parents])
    await annotate_bookmarked_casts(db, current_user, data)
    return data


class _BookmarkLookup(enum.Enum):
    """Why a bookmarked cast could not be returned (besides not existing)."""

    FAILED = "failed"
    # No answer within BOOKMARK_LOOKUP_TIMEOUT_SECONDS: how Hypersnap answers
    # a deleted cast (verified on haatz: it hangs rather than 404ing).
    UNRESPONSIVE = "unresponsive"


async def _fetch_bookmarked_cast(cast_hash: str) -> dict | None | _BookmarkLookup:
    """Look up one bookmarked cast; ``None`` when it no longer exists.

    Each lookup is bounded on its own so one deleted cast cannot stall the
    whole page, and a per-cast failure is reported via :class:`_BookmarkLookup`
    instead of failing the page.
    """
    try:
        data = await asyncio.wait_for(
            hypersnap.get("/cast", {"identifier": cast_hash, "type": "hash"}),
            BOOKMARK_LOOKUP_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        logger.warning("[feed] bookmark cast %s lookup timed out", cast_hash)
        return _BookmarkLookup.UNRESPONSIVE
    except hypersnap.HypersnapNotFound:
        return None
    except hypersnap.HypersnapError as exc:
        logger.warning("[feed] bookmark cast %s lookup failed: %s", cast_hash, exc)
        return _BookmarkLookup.FAILED

    cast = data.get("cast", data)
    if not isinstance(cast, dict):
        return None
    normalize_cast_hashes(cast)
    if str(cast.get("hash", "")).lower() != cast_hash.lower():
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
    redis: aioredis.Redis = Depends(get_redis),
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

    hydrated = await asyncio.gather(
        *(_fetch_bookmarked_cast(bookmark.cast_hash) for bookmark in page)
    )
    if all(isinstance(cast, _BookmarkLookup) for cast in hydrated):
        raise HTTPException(status_code=502, detail="Upstream service error")

    pruned = await _prune_unresponsive_bookmarks(
        db,
        redis,
        fid=current_user,
        outcomes={b.cast_hash: cast for b, cast in zip(page, hydrated)},
    )
    if next_cursor is not None and pruned:
        # Pruned rows no longer occupy offsets, so the next page starts earlier.
        next_cursor = str(offset + limit - pruned)

    casts = [cast for cast in hydrated if isinstance(cast, dict)]
    await prepare_cast_payload(
        casts, current_user, redis=redis, backfill_reaction_counts=True
    )
    await spam_service.annotate_casts(casts)
    return {"casts": casts, "next": {"cursor": next_cursor}}


async def _prune_unresponsive_bookmarks(
    db: AsyncSession,
    redis: aioredis.Redis,
    *,
    fid: int,
    outcomes: dict[str, dict | None | _BookmarkLookup],
) -> int:
    """Delete bookmarks whose cast has stopped answering; return how many.

    Only called when some lookup on the page succeeded, so the node itself is
    healthy. A cast earns at most one strike per BOOKMARK_STRIKE_COOLDOWN and
    is pruned at BOOKMARK_PRUNE_STRIKES consecutive strikes (any answer resets
    them), so a transient blip cannot delete a bookmark.
    """
    answered = [
        _bookmark_strike_key(fid, cast_hash)
        for cast_hash, cast in outcomes.items()
        if not isinstance(cast, _BookmarkLookup)
    ]
    if answered:
        await redis.delete(*answered)
    to_prune: list[str] = []
    for cast_hash, cast in outcomes.items():
        if cast is not _BookmarkLookup.UNRESPONSIVE:
            continue
        strike_key = _bookmark_strike_key(fid, cast_hash)
        is_new_strike = await redis.set(
            f"{strike_key}:cooldown",
            1,
            nx=True,
            ex=BOOKMARK_STRIKE_COOLDOWN_SECONDS,
        )
        if not is_new_strike:
            continue
        strikes = await redis.incr(strike_key)
        await redis.expire(strike_key, BOOKMARK_STRIKE_TTL_SECONDS)
        if int(strikes) >= BOOKMARK_PRUNE_STRIKES:
            to_prune.append(cast_hash)
    if not to_prune:
        return 0
    await db.execute(
        delete(CastBookmark).where(
            CastBookmark.fid == fid, CastBookmark.cast_hash.in_(to_prune)
        )
    )
    await db.commit()
    await redis.delete(*(_bookmark_strike_key(fid, h) for h in to_prune))
    logger.info(
        "[feed] pruned %d unresponsive bookmarks for fid=%s", len(to_prune), fid
    )
    return len(to_prune)


def _bookmark_strike_key(fid: int, cast_hash: str) -> str:
    return f"{BOOKMARK_STRIKE_PREFIX}{fid}:{cast_hash}"


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
    """Search Farcaster channels by ID or name via Hypersnap.

    Hypersnap reports ``member_count`` and no ``image_url``; the response
    keeps the Neynar-era keys so clients need no change.
    """
    try:
        data = await hypersnap.get("/channel/search", {"q": q, "limit": limit})
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="feed")

    channels = data.get("channels") or data.get("result", {}).get("channels", [])
    return {
        "channels": [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "description": c.get("description"),
                "image_url": c.get("image_url"),
                "follower_count": c.get("follower_count", c.get("member_count")),
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
    redis: aioredis.Redis = Depends(get_redis),
):
    """Post a new cast (or reply) to Farcaster via Hypersnap."""
    _validate_cast_request(body)
    await enforce_rate_limits(
        redis,
        [
            (template.format(fid=current_user), rule)
            for template, rule in CAST_RATE_LIMITS
        ],
        detail=CAST_RATE_LIMITED_DETAIL,
    )
    with write_errors_as_http("feed"):
        signer = await load_user_signer(db, current_user)
        cast_hash = await publish_cast(
            signer,
            text=body.text,
            embed_urls=_normalized_embed_urls(body),
            quote=cast_ref(body.quote.fid, body.quote.hash) if body.quote else None,
            parent_hash=body.parent,
            channel_id=body.channel_id,
        )
    await record_cast(db, fid=current_user, cast_hash=cast_hash, source="composer")
    return cast_response(cast_hash, fid=current_user, text=body.text)


@router.post("/cast/thread", status_code=201)
async def create_cast_thread(
    body: CastThreadRequest,
    response: Response,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Publish an ordered cast thread: a root cast plus chained replies.

    Segments post strictly sequentially — each reply targets the previous
    segment's canonical hash. Returns 201 when every segment published,
    207 with the published prefix on partial failure, and 502 when the
    root itself failed (nothing was published).
    """
    await _enforce_fixed_window_rate_limit(
        redis,
        key=THREAD_PUBLISH_RATE_KEY.format(fid=current_user),
        limit=THREAD_RATE_LIMIT_PER_MIN,
        window_seconds=THREAD_RATE_LIMIT_WINDOW_SECONDS,
        detail="Thread publish rate limit exceeded. Try again later.",
    )
    with write_errors_as_http("feed"):
        signer = await load_user_signer(db, current_user)
    segments = [
        ThreadSegmentInput(
            text=segment.text,
            embed_urls=tuple(
                normalize_media_embed_url(str(url)) for url in (segment.embeds or [])
            ),
            quote_fid=segment.quote.fid if segment.quote else None,
            quote_hash=segment.quote.hash if segment.quote else None,
        )
        for segment in body.casts
    ]

    with write_errors_as_http("feed"):
        outcome = await publish_thread(
            db,
            signer=signer,
            segments=segments,
            parent=body.parent,
            channel_id=body.channel_id,
        )

    published = [
        {"index": index, "hash": cast_hash}
        for index, cast_hash in enumerate(outcome.hashes)
    ]
    if outcome.failed_index is not None:
        if not published:
            raise HTTPException(status_code=502, detail=outcome.error)
        response.status_code = 207
        return {
            "success": False,
            "casts": published,
            "failed_index": outcome.failed_index,
            "error": outcome.error,
        }
    return {
        "success": True,
        "casts": published,
        "failed_index": None,
        "error": None,
    }


@router.post("/scheduled-casts", status_code=201)
async def schedule_cast(
    body: ScheduledCastRequest,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Schedule a cast between 30 seconds and one year in the future."""
    _validate_cast_request(body)
    embed_urls = _normalized_embed_urls(body)
    with write_errors_as_http("feed"):
        validate_embed_urls(embed_urls, has_quote=body.quote is not None)
    if body.scheduled_for.tzinfo is None or body.scheduled_for.utcoffset() is None:
        raise HTTPException(
            status_code=400, detail="scheduled_for must include a UTC offset"
        )
    scheduled_for = body.scheduled_for.astimezone(timezone.utc)
    now = datetime.now(tz=timezone.utc)
    if scheduled_for < now + MIN_SCHEDULE_DELAY:
        raise HTTPException(
            status_code=400,
            detail="scheduled_for must be at least 30 seconds in the future",
        )
    if scheduled_for > now + MAX_SCHEDULE_HORIZON:
        raise HTTPException(
            status_code=400,
            detail="scheduled_for cannot be more than 365 days in the future",
        )

    # Validate the signer now for fast user feedback; the publisher deliberately
    # loads it again so a signer rotation between scheduling and publication
    # does not strand the job. No signer material is stored on this row.
    with write_errors_as_http("feed"):
        await load_user_signer(db, current_user)

    # Serialize capacity checks for one user's queue. Under Postgres this row
    # lock prevents concurrent schedules from racing past the per-user cap.
    await db.execute(select(User.fid).where(User.fid == current_user).with_for_update())
    active_count = (
        await db.execute(
            select(func.count())
            .select_from(ScheduledCast)
            .where(
                ScheduledCast.fid == current_user,
                ScheduledCast.status.in_(("pending", "processing", "retrying")),
            )
        )
    ).scalar_one()
    if active_count >= MAX_ACTIVE_SCHEDULED_CASTS_PER_USER:
        raise HTTPException(status_code=429, detail="Scheduled cast limit reached")

    job = ScheduledCast(
        fid=current_user,
        text=body.text,
        parent=body.parent,
        embeds=embed_urls,
        quote_fid=body.quote.fid if body.quote else None,
        quote_hash=body.quote.hash if body.quote else None,
        channel_id=body.channel_id,
        scheduled_for=scheduled_for,
        next_attempt_at=scheduled_for,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return _scheduled_cast_json(job)


@router.get("/scheduled-casts")
async def list_scheduled_casts(
    limit: int = Query(default=50, ge=1, le=100),
    include_history: bool = Query(default=False),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """List the caller's pending, processing, and retrying scheduled casts."""
    query = select(ScheduledCast).where(ScheduledCast.fid == current_user)
    if not include_history:
        query = query.where(
            ScheduledCast.status.in_(("pending", "processing", "retrying"))
        ).order_by(ScheduledCast.scheduled_for, ScheduledCast.id)
    else:
        query = query.order_by(ScheduledCast.created_at.desc(), ScheduledCast.id)
    result = await db.execute(query.limit(limit))
    return {"scheduled_casts": [_scheduled_cast_json(job) for job in result.scalars()]}


@router.delete("/scheduled-casts/{scheduled_cast_id}")
async def cancel_scheduled_cast(
    scheduled_cast_id: uuid.UUID,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel one caller-owned job if no worker has claimed it yet."""
    job = (
        await db.execute(
            select(ScheduledCast)
            .where(
                ScheduledCast.id == scheduled_cast_id,
                ScheduledCast.fid == current_user,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    # Collapse non-ownership and non-existence to the same response (no IDOR
    # oracle). An owned but already-claimed job gets an explicit conflict.
    if job is None:
        raise HTTPException(status_code=404, detail="Scheduled cast not found")
    if job.status not in {"pending", "retrying"}:
        raise HTTPException(
            status_code=409, detail="Scheduled cast can no longer be cancelled"
        )
    now = datetime.now(tz=timezone.utc)
    job.status = "cancelled"
    job.cancelled_at = now
    job.updated_at = now
    job.lease_expires_at = None
    await db.commit()
    return {"status": "cancelled", "id": str(job.id), "cancelled_at": now}


@router.get("/cast/thread")
async def get_cast_thread(
    hash: str = Query(..., pattern=CAST_HASH_PATTERN),
    reply_depth: int = Query(default=2, ge=1, le=5),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    spam_service: SpamService = Depends(get_spam_service),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Fetch a cast conversation (thread) from Hypersnap.

    ``conversation.chronological_parent_casts`` carries the focused cast's
    ancestors (oldest first) so clients can render the chain inline.
    """
    await _enforce_fixed_window_rate_limit(
        redis,
        key=THREAD_READ_RATE_KEY.format(fid=current_user),
        limit=THREAD_READ_RATE_LIMIT_PER_MIN,
        window_seconds=THREAD_READ_RATE_LIMIT_WINDOW_SECONDS,
        detail="Thread rate limit exceeded. Try again later.",
    )
    try:
        data = await hypersnap.get(
            "/cast/conversation",
            {"identifier": hash, "type": "hash", "reply_depth": reply_depth},
        )
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="feed")
    conversation = data.get("conversation")
    if isinstance(conversation, dict) and isinstance(conversation.get("cast"), dict):
        conversation["chronological_parent_casts"] = await fetch_thread_ancestors(
            conversation["cast"], redis=redis
        )
    data = await prepare_cast_payload(
        data, current_user, redis=redis, backfill_reaction_counts=True
    )
    await spam_service.annotate_thread(data)
    blocked_fids = await get_blocked_fids(db, current_user)
    data = filter_thread_payload(data, blocked_fids)
    conversation = data.get("conversation")
    if isinstance(conversation, dict) and conversation.get(
        "chronological_parent_casts"
    ):
        conversation["chronological_parent_casts"] = trim_hidden_ancestors(
            conversation["chronological_parent_casts"], blocked_fids
        )
    await annotate_bookmarked_casts(db, current_user, data)
    return data


@router.post("/bookmarks/{cast_hash}", status_code=201)
async def create_bookmark(
    cast_hash: str = Path(..., pattern=CAST_HASH_PATTERN),
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
    cast_hash: str = Path(..., pattern=CAST_HASH_PATTERN),
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
    cast_hash: str = Path(..., pattern=CAST_HASH_PATTERN),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete one of the caller's casts (``CastRemove``)."""
    with write_errors_as_http("feed"):
        signer = await load_user_signer(db, current_user)
        removal_hash = await publish_cast_removal(signer, cast_hash)
    return {"success": True, "hash": removal_hash}


@router.post("/reaction")
async def create_reaction(
    body: ReactionRequest,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Like or recast a cast, signed server-side with the user's signer."""
    return await _publish_reaction(db, redis, current_user, body, action="add")


@router.delete("/reaction")
async def delete_reaction(
    body: ReactionRequest,
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Undo a like or recast, signed server-side with the user's signer."""
    return await _publish_reaction(db, redis, current_user, body, action="remove")


async def _publish_reaction(
    db: AsyncSession,
    redis: aioredis.Redis,
    fid: int,
    body: ReactionRequest,
    *,
    action: Literal["add", "remove"],
) -> dict:
    with write_errors_as_http("feed"):
        signer = await load_user_signer(db, fid)
        message_hash = await publish_reaction(
            signer,
            action=action,
            reaction_type=body.reaction_type,
            target_hash=body.target,
        )
    await invalidate_viewer_reactions(redis, fid)
    await invalidate_reaction_counts(redis, body.target)
    return {"success": True, "hash": message_hash}


# ---------------------------------------------------------------------------
# OG metadata preview — used by the composer to show a link preview before
# publishing. We scrape minimal OG tags server-side so the API key / scraping
# stays off the client.
# ---------------------------------------------------------------------------

# Per-user limit, shared across workers/replicas via Redis (it was a
# per-process dict that grew without bound and multiplied with workers).
OG_RATE_LIMIT = RateLimit(limit=15, window_seconds=60)
OG_RATE_KEY = "feed_og:rl:{fid}"
_OG_FETCH_TIMEOUT_SECONDS = 8.0
# Generic on purpose: the UnsafeUrlError text says *why* a URL was refused
# (resolved private IP, port, ...), which helps an attacker map the SSRF guard.
OG_URL_REJECTED_DETAIL = "URL not allowed"


class OgResponse(BaseModel):
    url: str
    title: str | None = None
    description: str | None = None
    image: str | None = None


@router.get("/og", response_model=OgResponse)
async def fetch_og_metadata(
    url: HttpUrl = Query(...),
    current_user: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Fetch Open Graph metadata for a URL (composer link preview)."""
    target = str(url)
    await enforce_rate_limits(
        redis, [(OG_RATE_KEY.format(fid=current_user), OG_RATE_LIMIT)]
    )

    try:
        async with create_client(_OG_FETCH_TIMEOUT_SECONDS) as client:
            preview = await fetch_link_preview(client, target)
    except UnsafeUrlError as exc:
        logger.info("[feed] og fetch refused: %s", exc)
        raise HTTPException(status_code=400, detail=OG_URL_REJECTED_DETAIL) from exc
    except httpx.HTTPError:
        return OgResponse(url=target)
    if preview is None:
        return OgResponse(url=target)

    og = preview.og
    image_url = og.get("image")
    if image_url and not image_url.startswith(("http://", "https://")):
        image_url = None

    return OgResponse(
        url=target,
        title=og.get("title"),
        description=og.get("description"),
        image=image_url,
    )
