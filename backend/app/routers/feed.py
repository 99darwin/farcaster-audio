"""
Feed router — proxies Neynar API calls so the API key stays server-side.
"""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import settings
from app.dependencies import get_current_user

router = APIRouter(prefix="/v1/feed", tags=["feed"])

NEYNAR_BASE = "https://api.neynar.com/v2"


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


@router.get("/following")
async def feed_following(
    fid: int = Query(...),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(default=None),
    _current_user: int = Depends(get_current_user),
):
    """Proxy Neynar feed/following endpoint."""
    params: dict[str, str | int] = {"fid": fid, "limit": limit}
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
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    return resp.json()


@router.post("/reaction")
async def create_reaction(
    body: dict,
    current_user: int = Depends(get_current_user),
):
    """Proxy Neynar reaction creation (like/recast)."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{NEYNAR_BASE}/farcaster/reaction",
            json=body,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    return resp.json()


@router.delete("/reaction")
async def delete_reaction(
    body: dict,
    current_user: int = Depends(get_current_user),
):
    """Proxy Neynar reaction deletion (unlike/unrecast)."""
    async with httpx.AsyncClient() as client:
        resp = await client.request(
            "DELETE",
            f"{NEYNAR_BASE}/farcaster/reaction",
            json=body,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    return resp.json()
