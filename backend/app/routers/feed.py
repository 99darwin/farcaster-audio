"""
Feed router — proxies Neynar API calls so the API key stays server-side.

The user's signer_uuid is always looked up from the database, never accepted
from the client, so it never leaves the backend.
"""

from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_current_user, get_db
from app.models.user import User

router = APIRouter(prefix="/v1/feed", tags=["feed"])

NEYNAR_BASE = "https://api.neynar.com/v2"


def _neynar_headers() -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-api-key": settings.NEYNAR_API_KEY,
    }


async def _get_signer_uuid(db: AsyncSession, fid: int) -> str:
    """Look up the user's signer_uuid from the database."""
    result = await db.execute(select(User.signer_uuid).where(User.fid == fid))
    signer_uuid = result.scalar_one_or_none()
    if not signer_uuid:
        raise HTTPException(status_code=400, detail="No signer found for user")
    return signer_uuid


# --- Request schemas ---


class ReactionRequest(BaseModel):
    reaction_type: Literal["like", "recast"]
    target: str = Field(pattern=r"^0x[a-fA-F0-9]+$")


class CastRequest(BaseModel):
    text: str = Field(min_length=1, max_length=320)
    parent: str | None = Field(default=None, pattern=r"^0x[a-fA-F0-9]+$")


# --- Endpoints ---


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


@router.post("/cast")
async def create_cast(
    body: CastRequest,
    current_user: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Post a new cast (or reply) to Farcaster via Neynar."""
    signer_uuid = await _get_signer_uuid(db, current_user)

    payload: dict = {
        "signer_uuid": signer_uuid,
        "text": body.text,
    }
    if body.parent:
        payload["parent"] = body.parent

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{NEYNAR_BASE}/farcaster/cast",
            json=payload,
            headers=_neynar_headers(),
            timeout=15.0,
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to publish cast")

    return resp.json()


@router.delete("/cast/{cast_hash}")
async def delete_cast(
    cast_hash: str,
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
        raise HTTPException(status_code=502, detail="Failed to delete cast")

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
        raise HTTPException(status_code=502, detail="Failed to create reaction")

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
        raise HTTPException(status_code=502, detail="Failed to remove reaction")

    return resp.json()
