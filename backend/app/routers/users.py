"""
Users router — proxies Neynar user profile and follow/unfollow endpoints.
"""

import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import select

from app.config import settings
from app.dependencies import get_current_user, get_db, get_spam_service, require_non_demo_user
from app.models.room import Room
from app.routers.feed import _neynar_headers, _raise_upstream_error, _get_signer_uuid
from app.schemas.room import RecordingListResponse, RecordingResponse
from app.services.spam_service import SpamService
from app.services.storage_service import StorageService
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/users", tags=["users"])

NEYNAR_BASE = "https://api.neynar.com/v2"


@router.get("/search")
async def search_users(
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(default=5, ge=1, le=10),
    _current_user: int = Depends(get_current_user),
    spam_service: SpamService = Depends(get_spam_service),
):
    """Search for users by username prefix via Neynar."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/user/search",
            params={"q": q, "limit": limit, "viewer_fid": _current_user},
            headers=_neynar_headers(),
            timeout=10.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    users = data.get("result", {}).get("users", [])
    # Pass neynar_user_score through so annotate_users can use it for fresh FIDs
    user_list = [
        {
            "fid": u.get("fid"),
            "username": u.get("username"),
            "display_name": u.get("display_name"),
            "pfp_url": u.get("pfp_url"),
            "experimental": u.get("experimental"),
        }
        for u in users
    ]
    await spam_service.annotate_users(user_list)
    # Strip internal experimental data before returning to client
    for u in user_list:
        u.pop("experimental", None)
    return {"users": user_list}


@router.get("/by-username/{username}")
async def get_user_by_username(
    username: str = Path(..., min_length=1, max_length=64),
    _current_user: int = Depends(get_current_user),
):
    """Look up a user by username via Neynar."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/user/by_username",
            params={"username": username, "viewer_fid": _current_user},
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


@router.get("/{fid}")
async def get_user(
    fid: int = Path(..., ge=1),
    _current_user: int = Depends(get_current_user),
):
    """Fetch a user profile by FID via Neynar, with viewer context."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/user/bulk",
            params={"fids": str(fid), "viewer_fid": _current_user},
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()
    users = data.get("users", [])
    if not users:
        raise HTTPException(status_code=404, detail="User not found")

    return {"user": users[0]}


@router.get("/{fid}/casts")
async def get_user_casts(
    fid: int = Path(..., ge=1),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(default=None),
    _current_user: int = Depends(get_current_user),
):
    """Fetch a user's casts via Neynar."""
    params: dict[str, str | int] = {
        "fid": fid,
        "limit": limit,
        "viewer_fid": _current_user,
    }
    if cursor:
        params["cursor"] = cursor

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/feed/user/casts",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


@router.post("/{fid}/follow")
async def follow_user(
    fid: int = Path(..., ge=1),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Follow a user via Neynar."""
    signer_uuid = await _get_signer_uuid(db, current_user)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{NEYNAR_BASE}/farcaster/user/follow",
            json={
                "signer_uuid": signer_uuid,
                "target_fids": [fid],
            },
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


@router.delete("/{fid}/follow")
async def unfollow_user(
    fid: int = Path(..., ge=1),
    current_user: int = Depends(require_non_demo_user),
    db: AsyncSession = Depends(get_db),
):
    """Unfollow a user via Neynar."""
    signer_uuid = await _get_signer_uuid(db, current_user)

    async with httpx.AsyncClient() as client:
        resp = await client.request(
            "DELETE",
            f"{NEYNAR_BASE}/farcaster/user/follow",
            json={
                "signer_uuid": signer_uuid,
                "target_fids": [fid],
            },
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    return resp.json()


# ---------------------------------------------------------------------------
# Recordings
# ---------------------------------------------------------------------------

RECORDING_RETENTION_DAYS = 30


@router.get("/{fid}/recordings", response_model=RecordingListResponse)
async def list_user_recordings(
    fid: int = Path(..., ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    cursor: int = Query(default=0, ge=0),
    _current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RecordingListResponse:
    """Return recorded spaces hosted by ``fid`` within the retention window.

    Only rooms whose ``recording_url`` has been populated (i.e. the egress
    webhook has fired) and whose ``ended_at`` falls within the last
    ``RECORDING_RETENTION_DAYS`` are included. Older rows are filtered here
    as a safety net; the retention cleanup job removes them outright.
    """
    cutoff = datetime.now(tz=timezone.utc) - timedelta(
        days=RECORDING_RETENTION_DAYS
    )

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
    query = (
        select(Room)
        .where(
            Room.host_fid == fid,
            Room.recording_url.is_not(None),
            Room.recording_url != "",
            Room.status != "deleted",
            Room.started_at >= cutoff,
        )
        .order_by(Room.started_at.desc())
        .offset(cursor)
        .limit(limit + 1)
    )
    result = await db.execute(query)
    rows = list(result.scalars().all())

    has_more = len(rows) > limit
    page = rows[:limit]

    # For rows with a stored key, mint a short-lived (15 min) presigned GET
    # so leaked URLs can't be replayed and the bucket can stay private. For
    # legacy rows that only have ``recording_url`` we fall through to it —
    # those URLs were already public-readable, so the short-lived presign
    # would be a regression, not an improvement.
    storage: StorageService | None = None

    def _get_storage() -> StorageService:
        nonlocal storage
        if storage is None:
            storage = StorageService()
        return storage

    PRESIGN_TTL_SECONDS = 15 * 60

    recordings: list[RecordingResponse] = []
    for room in page:
        duration_seconds: int | None = None
        if room.ended_at and room.started_at:
            duration_seconds = max(
                0, int((room.ended_at - room.started_at).total_seconds())
            )

        # Prefer presigned URL from stored key. If presigning fails, log and
        # return an empty string so clients see "no URL yet" rather than a
        # broken link.
        url = ""
        if room.recording_key:
            try:
                url = _get_storage().generate_presigned_get_url(
                    room.recording_key, expires_in=PRESIGN_TTL_SECONDS
                )
            except Exception:
                logger.exception(
                    "Failed to presign recording for room=%s key=%s",
                    room.id,
                    room.recording_key,
                )
                url = ""
        elif room.recording_url:
            # Legacy row — no key stored. Fall back to the persisted URL.
            url = room.recording_url

        recordings.append(
            RecordingResponse(
                room_id=str(room.id),
                title=room.title,
                recording_url=url,
                started_at=room.started_at.isoformat()
                if room.started_at
                else "",
                ended_at=room.ended_at.isoformat() if room.ended_at else None,
                duration_seconds=duration_seconds,
            )
        )

    next_cursor = str(cursor + limit) if has_more else None
    return RecordingListResponse(recordings=recordings, next_cursor=next_cursor)
