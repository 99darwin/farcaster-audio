"""Shape the following feed like X's Following timeline.

Hypersnap's ``/feed/following`` returns every cast by every followed account,
replies included, so a page is dominated by one-off replies to strangers. X
instead shows original posts, plus a reply only when it continues a
conversation with someone the viewer follows — rendered under its parent, once
per conversation. :func:`fetch_following_page` applies those rules and tops a
page back up from upstream when they filter much of it away.
"""

from __future__ import annotations

from typing import Iterable

from app.clients import hypersnap
from app.services.block_service import filter_casts
from app.services.farcaster_hydration import normalize_cast_hashes

# Bounds upstream calls per request when filtering thins out a page.
MAX_UPSTREAM_PAGES = 3
# Top-up pages request this multiple of the remaining shortfall.
TOP_UP_FACTOR = 2


def _parent_hash(cast: dict) -> str | None:
    parent_hash = cast.get("parent_hash")
    return parent_hash.lower() if isinstance(parent_hash, str) else None


def _parent_author_fid(cast: dict) -> object:
    return (cast.get("parent_author") or {}).get("fid")


def shape_conversations(
    casts: Iterable[dict], *, visible_parent_fids: set[int] | None
) -> list[dict]:
    """Keep root casts and at most one visible reply per conversation.

    ``casts`` are newest first. A reply is visible when its parent's author is
    in ``visible_parent_fids`` (``None`` keeps every reply); only the newest
    reply to a given parent is kept. A root cast that a kept reply answers is
    dropped, since the client renders it above that reply.
    """
    kept: list[dict] = []
    answered: set[str] = set()
    for cast in casts:
        parent_hash = _parent_hash(cast)
        if parent_hash is None:
            kept.append(cast)
            continue
        if parent_hash in answered:
            continue
        if (
            visible_parent_fids is not None
            and _parent_author_fid(cast) not in visible_parent_fids
        ):
            continue
        answered.add(parent_hash)
        kept.append(cast)
    return [
        cast
        for cast in kept
        if _parent_hash(cast) is not None
        or str(cast.get("hash", "")).lower() not in answered
    ]


async def fetch_following_page(
    *,
    viewer_fid: int,
    limit: int,
    cursor: str | None,
    following_fids: Iterable[int],
    blocked_fids: set[int],
) -> dict:
    """Fetch one shaped page of the viewer's following feed.

    Reads further upstream pages (up to ``MAX_UPSTREAM_PAGES``) until ``limit``
    casts survive shaping. Hashes are normalized; viewer hydration is left to
    the caller. A failure after the first page returns what was gathered, with
    the cursor pointing at the page that failed.
    """
    following = set(following_fids) - blocked_fids
    # An empty follow list means the lookup failed (or there is nothing to
    # filter): show replies rather than hide them all.
    visible_parent_fids = (following | {viewer_fid}) if following else None

    raw_casts: list[dict] = []
    seen_hashes: set[str] = set()
    shaped: list[dict] = []
    next_cursor = cursor
    page_limit = limit
    for page_index in range(MAX_UPSTREAM_PAGES):
        params = {"fid": viewer_fid, "limit": page_limit, "cursor": next_cursor}
        try:
            page = await hypersnap.get("/feed/following", params)
        except hypersnap.HypersnapError as exc:
            if page_index == 0:
                hypersnap.raise_for_upstream(exc, context="feed")
            break
        normalize_cast_hashes(page)
        for cast in filter_casts(page.get("casts") or [], blocked_fids):
            cast_hash = str(cast.get("hash", "")).lower()
            if cast_hash in seen_hashes:
                continue
            seen_hashes.add(cast_hash)
            raw_casts.append(cast)
        page_cursor = next_cursor
        next_cursor = (page.get("next") or {}).get("cursor")
        shaped = shape_conversations(raw_casts, visible_parent_fids=visible_parent_fids)
        if len(shaped) >= limit or not next_cursor or next_cursor == page_cursor:
            break
        # Top up only the shortfall (with headroom for filtering) so a response
        # stays within ~2x ``limit`` casts.
        page_limit = min(limit, TOP_UP_FACTOR * (limit - len(shaped)))
    return {"casts": shaped, "next": {"cursor": next_cursor}}
