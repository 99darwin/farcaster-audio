"""
Notifications router — proxies Neynar notifications API with quality filtering.
"""

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import settings
from app.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/notifications", tags=["notifications"])

NEYNAR_BASE = "https://api.neynar.com/v2"
MIN_USER_SCORE = 0.5


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


def _user_score(user: dict) -> float:
    return user.get("experimental", {}).get("neynar_user_score", 1.0)


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
        logger.error(
            "[notifications] Neynar %s → %s: %s",
            resp.request.url.path,
            resp.status_code,
            resp.text[:500],
        )
        status = 502 if resp.status_code >= 500 else resp.status_code
        raise HTTPException(status_code=status, detail="Upstream service error")

    data = resp.json()

    # Filter out low-quality actors from notifications
    notifications = data.get("notifications", [])
    filtered = []
    for n in notifications:
        ntype = n.get("type")
        if ntype in ("likes", "recasts"):
            # Strip low-score reactors; drop notification if none remain
            good = [
                r for r in n.get("reactions", [])
                if _user_score(r.get("user", {})) > MIN_USER_SCORE
            ]
            if not good:
                continue
            n = {**n, "reactions": good, "count": len(good)}
        elif ntype == "follows":
            good = [
                f for f in n.get("follows", [])
                if _user_score(f.get("user", {})) > MIN_USER_SCORE
            ]
            if not good:
                continue
            n = {**n, "follows": good, "count": len(good)}
        elif ntype in ("reply", "mention"):
            author = n.get("cast", {}).get("author", {})
            if _user_score(author) <= MIN_USER_SCORE:
                continue
        filtered.append(n)

    return {
        "notifications": filtered,
        "next": data.get("next", {"cursor": None}),
    }
