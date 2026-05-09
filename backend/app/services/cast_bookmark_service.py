from collections.abc import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cast_bookmark import CastBookmark


def _iter_cast_dicts(value: object) -> Iterator[dict]:
    if isinstance(value, dict):
        is_cast = (
            isinstance(value.get("hash"), str)
            and value.get("hash", "").startswith("0x")
            and any(key in value for key in ("author", "reactions", "timestamp", "text"))
        )
        if is_cast:
            yield value
        for child in value.values():
            yield from _iter_cast_dicts(child)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_cast_dicts(item)


async def annotate_bookmarked_casts(
    db: AsyncSession,
    fid: int,
    payload: dict | list,
) -> dict | list:
    """Set viewer_context.bookmarked on every cast-shaped dict in a Neynar payload."""
    casts = list(_iter_cast_dicts(payload))
    hashes = {cast["hash"] for cast in casts}
    if not hashes:
        return payload

    result = await db.execute(
        select(CastBookmark.cast_hash).where(
            CastBookmark.fid == fid,
            CastBookmark.cast_hash.in_(hashes),
        )
    )
    bookmarked = set(result.scalars().all())

    for cast in casts:
        viewer_context = dict(cast.get("viewer_context") or {})
        viewer_context["bookmarked"] = cast["hash"] in bookmarked
        cast["viewer_context"] = viewer_context

    return payload
