"""
Feed router — proxies Neynar API calls so the API key stays server-side.

The user's signer_uuid is always looked up from the database, never accepted
from the client, so it never leaves the backend.
"""

import logging
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_current_user, get_db
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/feed", tags=["feed"])

NEYNAR_BASE = "https://api.neynar.com/v2"


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


def _raise_upstream_error(resp: httpx.Response) -> None:
    """Log the full Neynar response, raise a sanitized error to the client."""
    logger.error("[feed] Neynar %s → %s: %s", resp.request.url.path, resp.status_code, resp.text[:500])
    status = 502 if resp.status_code >= 500 else resp.status_code
    raise HTTPException(status_code=status, detail="Upstream service error")


async def _get_signer_uuid(db: AsyncSession, fid: int) -> str:
    """Look up the user's signer_uuid from the database."""
    result = await db.execute(select(User.signer_uuid).where(User.fid == fid))
    signer_uuid = result.scalar_one_or_none()
    logger.info("[feed] signer_uuid lookup for fid=%s: found=%s", fid, bool(signer_uuid))
    if not signer_uuid:
        raise HTTPException(status_code=400, detail="No signer found for user")
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
    embeds: list[HttpUrl] | None = Field(default=None, max_length=2)
    quote: CastIdEmbed | None = None


# --- Endpoints ---


@router.get("/following")
async def feed_following(
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=500, pattern=r"^[a-zA-Z0-9_\-=.%]+$"),
    current_user: int = Depends(get_current_user),
):
    """Proxy Neynar feed/following endpoint."""
    params: dict[str, str | int] = {"fid": current_user, "limit": limit, "viewer_fid": current_user}
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

    return resp.json()


@router.post("/cast")
async def create_cast(
    body: CastRequest,
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Post a new cast (or reply) to Farcaster via Neynar."""
    if not body.text.strip() and not body.embeds and not body.quote:
        raise HTTPException(status_code=400, detail="Cast must have text, embeds, or a quote")
    signer_uuid = await _get_signer_uuid(db, current_user)

    payload: dict = {
        "signer_uuid": signer_uuid,
        "text": body.text,
    }
    if body.parent:
        payload["parent"] = body.parent
    embeds: list[dict] = []
    if body.embeds:
        embeds.extend({"url": str(url)} for url in body.embeds)
    if body.quote:
        embeds.append({"cast_id": {"fid": body.quote.fid, "hash": body.quote.hash}})
    if embeds:
        payload["embeds"] = embeds

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

    return resp.json()


@router.delete("/cast/{cast_hash}")
async def delete_cast(
    cast_hash: str = Path(..., pattern=r"^0x[a-fA-F0-9]+$"),
    current_user: int = Depends(get_current_user),
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
    current_user: int = Depends(get_current_user),
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
    current_user: int = Depends(get_current_user),
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
