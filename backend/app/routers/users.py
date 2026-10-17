"""
Users router — profile reads via Hypersnap; follow/unfollow writes as signed
protocol messages.
"""

import logging
from contextlib import aclosing
from datetime import datetime, timedelta, timezone
from typing import Literal

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.clients import hypersnap
from app.dependencies import (
    get_current_user,
    get_db,
    get_redis,
    get_spam_service,
    require_non_demo_user,
)
from app.models.recording import Recording
from app.models.room import Room
from app.schemas.room import RecordingListResponse, RecordingResponse
from app.services.cast_bookmark_service import annotate_bookmarked_casts
from app.services.farcaster_hydration import (
    hydrate_user_viewer_context,
    prepare_cast_payload,
)
from app.services.block_service import (
    create_block,
    delete_block,
    filter_casts,
    get_blocked_fids,
    is_blocked,
    list_blocked_users,
)
from app.services.farcaster_writes import (
    load_user_signer,
    publish_follow,
    write_errors_as_http,
)
from app.services.spam_service import SpamService
from app.services.storage_service import StorageService
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/users", tags=["users"])

# Upstream pages read per request to fill a page of top-level casts.
USER_CASTS_MAX_PAGES = 4


class BlockRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


@router.get("/search")
async def search_users(
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(default=5, ge=1, le=10),
    _current_user: int = Depends(get_current_user),
    spam_service: SpamService = Depends(get_spam_service),
):
    """Search for users by username prefix via Hypersnap."""
    try:
        data = await hypersnap.get("/user/search", {"q": q, "limit": limit})
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="users")

    # Hypersnap returns ``users`` at the top level; Neynar nested it under
    # ``result``. Accept both.
    users = data.get("users") or (data.get("result") or {}).get("users", [])
    # Score the full user objects (follower count, age, ...) for fresh FIDs
    await spam_service.annotate_users(users)
    user_list = [
        {
            "fid": u.get("fid"),
            "username": u.get("username"),
            "display_name": u.get("display_name"),
            "pfp_url": u.get("pfp_url"),
            "is_spam": u.get("is_spam", False),
        }
        for u in users
    ]
    return {"users": user_list}


@router.get("/by-username/{username}")
async def get_user_by_username(
    username: str = Path(..., min_length=1, max_length=64),
    _current_user: int = Depends(get_current_user),
):
    """Look up a user by username via Hypersnap, with viewer follow state."""
    try:
        data = await hypersnap.get("/user/by-username", {"username": username})
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="users")

    user = data.get("user")
    if isinstance(user, dict):
        await hydrate_user_viewer_context(user, _current_user)
    return data


@router.get("/blocked")
async def get_blocked_users(
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return users blocked by the current viewer."""
    return {"users": await list_blocked_users(db, current_user)}


@router.post("/{fid}/block", status_code=201)
async def block_user(
    body: BlockRequest | None = None,
    fid: int = Path(..., ge=1),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Block a Farcaster user at the app layer."""
    await create_block(
        db,
        blocker_fid=current_user,
        blocked_fid=fid,
        reason=body.reason if body else None,
    )
    return {"status": "blocked", "fid": fid}


@router.delete("/{fid}/block")
async def unblock_user(
    fid: int = Path(..., ge=1),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove an app-layer block if it exists."""
    await delete_block(db, blocker_fid=current_user, blocked_fid=fid)
    return {"status": "unblocked", "fid": fid}


@router.get("/{fid}")
async def get_user(
    fid: int = Path(..., ge=1),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Fetch a user profile by FID via Hypersnap, with viewer context."""
    try:
        data = await hypersnap.get("/user/bulk", {"fids": str(fid)})
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context="users")

    users = data.get("users", [])
    if not users:
        raise HTTPException(status_code=404, detail="User not found")

    user = await hydrate_user_viewer_context(users[0], current_user)
    viewer_context = {
        **(user.get("viewer_context") or {}),
        "blocked": await is_blocked(db, blocker_fid=current_user, blocked_fid=fid),
    }
    user["viewer_context"] = viewer_context
    return {"user": user}


@router.get("/{fid}/casts")
async def get_user_casts(
    fid: int = Path(..., ge=1),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(default=None),
    include_replies: bool = Query(default=False),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Fetch a user's casts via Hypersnap.

    Set ``include_replies=true`` to include the user's reply casts. The
    param is forwarded, but Hypersnap currently returns replies regardless,
    so replies are dropped locally when it is false. To keep pages full,
    further upstream pages (up to ``USER_CASTS_MAX_PAGES``) are read until
    ``limit`` top-level casts are collected; every consumed page is returned
    whole, so a page can hold slightly more than ``limit`` casts.
    """
    params: dict[str, str | int | None] = {
        "fid": fid,
        "limit": limit,
        "cursor": cursor,
        "include_replies": str(include_replies).lower(),
    }
    casts: list[dict] = []
    next_cursor: str | None = None
    try:
        async with aclosing(
            hypersnap.paginate(
                "/feed/user/casts", params, max_pages=USER_CASTS_MAX_PAGES
            )
        ) as pages:
            async for page in pages:
                casts.extend(
                    cast
                    for cast in page.get("casts") or []
                    if include_replies or not cast.get("parent_hash")
                )
                next_cursor = (page.get("next") or {}).get("cursor") or None
                if len(casts) >= limit:
                    break
    except hypersnap.HypersnapError as exc:
        if not casts:
            hypersnap.raise_for_upstream(exc, context="users")
        # Keep what earlier pages gave; ``next_cursor`` resumes after them.
        logger.warning("[users] user casts page fill stopped early: %s", exc)

    data = {"casts": casts, "next": {"cursor": next_cursor}}
    await prepare_cast_payload(data, current_user, redis=redis)
    blocked_fids = await get_blocked_fids(db, current_user)
    data["casts"] = filter_casts(data.get("casts", []), blocked_fids)
    await annotate_bookmarked_casts(db, current_user, data)
    return data


@router.post("/{fid}/follow")
async def follow_user(
    fid: int = Path(..., ge=1),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Follow a user (``LinkAdd``), signed with the caller's app signer."""
    return await _publish_follow(db, current_user, fid, action="add")


@router.delete("/{fid}/follow")
async def unfollow_user(
    fid: int = Path(..., ge=1),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Unfollow a user (``LinkRemove``), signed with the caller's app signer."""
    return await _publish_follow(db, current_user, fid, action="remove")


async def _publish_follow(
    db: AsyncSession,
    current_user: int,
    target_fid: int,
    *,
    action: Literal["add", "remove"],
) -> dict:
    with write_errors_as_http("users"):
        signer = await load_user_signer(db, current_user)
        message_hash = await publish_follow(
            signer, action=action, target_fid=target_fid
        )
    return {"success": True, "hash": message_hash}


# ---------------------------------------------------------------------------
# Recordings
# ---------------------------------------------------------------------------

RECORDING_RETENTION_DAYS = 30


@router.get("/{fid}/recordings", response_model=RecordingListResponse)
async def list_user_recordings(
    fid: int = Path(..., ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    cursor: int = Query(default=0, ge=0),
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RecordingListResponse:
    """Return recorded spaces hosted by ``fid`` within the retention window.

    Only rooms whose ``recording_url`` has been populated (i.e. the egress
    webhook has fired) and whose ``ended_at`` falls within the last
    ``RECORDING_RETENTION_DAYS`` are included. Older rows are filtered here
    as a safety net; the retention cleanup job removes them outright.
    """
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=RECORDING_RETENTION_DAYS)
    if await is_blocked(db, blocker_fid=current_user, blocked_fid=fid):
        return RecordingListResponse(recordings=[], next_cursor=None)

    # Recordings are public-by-design — any caller can list recordings for any
    # host fid within the retention window. A host opts into making a space
    # recording the moment they toggle REC on; ACL checks here would be
    # security theater. Non-public (private) recordings are out of scope.
    #
    # Filters applied:
    #   - host_fid matches
    #   - recording URL populated AND non-empty (skip webhook-in-flight rows
    #     and rows where cleanup emptied the string without dropping the row)
    #   - within retention window
    #   - room status not "deleted" (soft-delete sentinel). Status column
    #     currently carries {scheduled, active, ended, cancelled} so this is
    #     a no-op today but keeps the endpoint safe if "deleted" is added.
    #   - TODO: if Room ever grows an is_private / unlisted column, filter it
    #     out here too.
    # Source from the recordings table so the per-user list reflects
    # multiple segments per space, sorted by segment start.
    query = (
        select(Recording, Room)
        .join(Room, Room.id == Recording.room_id)
        .where(
            Room.host_fid == fid,
            Room.status != "deleted",
            Recording.started_at >= cutoff,
        )
        .order_by(Recording.started_at.desc())
        .offset(cursor)
        .limit(limit + 1)
    )
    result = await db.execute(query)
    rows = list(result.all())

    has_more = len(rows) > limit
    page = rows[:limit]

    # For rows with a stored key, mint a short-lived (15 min) presigned
    # GET so leaked URLs can't be replayed and the bucket can stay
    # private. For legacy rows that only have ``recording_url`` we fall
    # through to it.
    storage: StorageService | None = None

    def _get_storage() -> StorageService:
        nonlocal storage
        if storage is None:
            storage = StorageService()
        return storage

    PRESIGN_TTL_SECONDS = 15 * 60

    recordings: list[RecordingResponse] = []
    for rec, room in page:
        url = ""
        if rec.s3_key:
            try:
                url = _get_storage().generate_presigned_get_url(
                    rec.s3_key, expires_in=PRESIGN_TTL_SECONDS
                )
            except Exception:
                logger.exception(
                    "Failed to presign recording_id=%s key=%s",
                    rec.id,
                    rec.s3_key,
                )
                url = ""
        elif rec.recording_url:
            url = rec.recording_url
        if not url:
            continue
        recordings.append(
            RecordingResponse(
                id=str(rec.id),
                room_id=str(room.id),
                title=room.title,
                recording_url=url,
                started_at=rec.started_at.isoformat() if rec.started_at else "",
                ended_at=rec.ended_at.isoformat() if rec.ended_at else None,
                duration_seconds=rec.duration_seconds,
                cast_hash=room.cast_hash,
            )
        )

    next_cursor = str(cursor + limit) if has_more else None
    return RecordingListResponse(recordings=recordings, next_cursor=next_cursor)
