"""
Notifications router — proxies Neynar notifications API with quality filtering.
"""

import logging

import httpx
from fastapi import APIRouter, Depends, Query

from app.dependencies import get_current_user
from app.routers.feed import NEYNAR_BASE, _neynar_headers, _raise_upstream_error

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/notifications", tags=["notifications"])

MIN_USER_SCORE = 0.5


@router.get("")
async def get_notifications(
    limit: int = Query(default=25, ge=1, le=50),
    cursor: str | None = Query(default=None, max_length=500, pattern=r"^[a-zA-Z0-9_\-=.%]+$"),
    current_user: int = Depends(get_current_user),
):
    """Proxy Neynar notifications endpoint with quality filtering."""
    params: dict[str, str | int] = {"fid": current_user, "limit": limit}
    if cursor:
        params["cursor"] = cursor

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{NEYNAR_BASE}/farcaster/notifications",
            params=params,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        _raise_upstream_error(resp)

    data = resp.json()

    # Filter out low-quality notifications (spam accounts)
    notifications = data.get("notifications", [])
    filtered = [
        n
        for n in notifications
        if n.get("user", {}).get("experimental", {}).get("neynar_user_score", 1.0)
        > MIN_USER_SCORE
    ]

    return {
        "notifications": filtered,
        "next": data.get("next", {"cursor": None}),
    }
