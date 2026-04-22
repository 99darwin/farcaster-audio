"""
Users router — proxies Neynar user profile and follow/unfollow endpoints.
"""

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app.config import settings
from app.dependencies import get_current_user, get_db, get_spam_service, require_non_demo_user
from app.routers.feed import _neynar_headers, _raise_upstream_error, _get_signer_uuid
from app.services.spam_service import SpamService
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
