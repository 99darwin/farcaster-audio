from __future__ import annotations

from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.user_block import UserBlock


async def get_blocked_fids(db: AsyncSession, blocker_fid: int) -> set[int]:
    result = await db.execute(
        select(UserBlock.blocked_fid).where(UserBlock.blocker_fid == blocker_fid)
    )
    return set(result.scalars().all())


async def is_blocked(db: AsyncSession, *, blocker_fid: int, blocked_fid: int) -> bool:
    result = await db.execute(
        select(UserBlock.id).where(
            UserBlock.blocker_fid == blocker_fid,
            UserBlock.blocked_fid == blocked_fid,
        )
    )
    return result.scalar_one_or_none() is not None


async def create_block(
    db: AsyncSession,
    *,
    blocker_fid: int,
    blocked_fid: int,
    reason: str | None = None,
) -> None:
    if blocker_fid == blocked_fid:
        raise HTTPException(status_code=400, detail="You cannot block yourself")

    stmt = (
        pg_insert(UserBlock)
        .values(
            blocker_fid=blocker_fid,
            blocked_fid=blocked_fid,
            reason=reason,
        )
        .on_conflict_do_nothing(index_elements=["blocker_fid", "blocked_fid"])
    )
    await db.execute(stmt)
    await db.commit()


async def delete_block(db: AsyncSession, *, blocker_fid: int, blocked_fid: int) -> None:
    if blocker_fid == blocked_fid:
        raise HTTPException(status_code=400, detail="You cannot unblock yourself")

    await db.execute(
        delete(UserBlock).where(
            UserBlock.blocker_fid == blocker_fid,
            UserBlock.blocked_fid == blocked_fid,
        )
    )
    await db.commit()


async def list_blocked_users(db: AsyncSession, blocker_fid: int) -> list[dict]:
    result = await db.execute(
        select(UserBlock, User)
        .join(User, User.fid == UserBlock.blocked_fid, isouter=True)
        .where(UserBlock.blocker_fid == blocker_fid)
        .order_by(UserBlock.created_at.desc())
    )
    users: list[dict] = []
    for block, user in result.all():
        users.append(
            {
                "fid": block.blocked_fid,
                "username": user.username if user else None,
                "display_name": user.display_name if user else None,
                "pfp_url": user.pfp_url if user else None,
                "blocked_at": block.created_at.isoformat(),
            }
        )
    return users


def cast_author_fid(cast: dict) -> int | None:
    fid = cast.get("author", {}).get("fid")
    return fid if isinstance(fid, int) else None


def filter_casts(casts: Iterable[dict], blocked_fids: set[int]) -> list[dict]:
    if not blocked_fids:
        return list(casts)
    return [cast for cast in casts if cast_author_fid(cast) not in blocked_fids]


def filter_cast_tree(cast: dict | None, blocked_fids: set[int]) -> dict | None:
    if not cast:
        return cast
    if cast_author_fid(cast) in blocked_fids:
        return None
    replies = cast.get("direct_replies")
    if isinstance(replies, list):
        cast["direct_replies"] = [
            reply
            for reply in (filter_cast_tree(reply, blocked_fids) for reply in replies)
            if reply is not None
        ]
    return cast


def filter_thread_payload(data: dict, blocked_fids: set[int]) -> dict:
    if not blocked_fids:
        return data
    conversation = data.get("conversation")
    if isinstance(conversation, dict) and isinstance(conversation.get("cast"), dict):
        conversation["cast"] = filter_cast_tree(conversation["cast"], blocked_fids)
    elif isinstance(data.get("cast"), dict):
        data["cast"] = filter_cast_tree(data["cast"], blocked_fids)
    return data
