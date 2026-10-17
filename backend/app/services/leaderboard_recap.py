"""Monthly recognition-leaderboard recap cast, posted from @jukeaudio.

STATUS-ONLY. Congratulates category winners by @-mention after a human-
reviewed cycle close (see ``app.routers.leaderboard_admin``). Signed with the
@jukeaudio system signer and submitted to Hypersnap, like
``RoomService._create_system_chat_cast`` — but unlike that helper, a failure
here must NEVER fail the close: awards are already committed by the time
this runs, so every error is caught and logged, never raised.

Deliberately not recorded in ``cast_records`` (the "casted via Juke" ledger)
-- brand-account casts are excluded from that ledger by design, matching
``_create_system_chat_cast``, which also skips it.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.leaderboard import LEADERBOARD_CATEGORIES
from app.models.user import User
from app.services import farcaster_writes

logger = logging.getLogger(__name__)

# Farcaster's default cast length limit is measured in bytes, not characters.
CAST_BYTE_LIMIT = 1024
LEADERBOARD_URL = "https://juke.audio/leaderboard"
CAST_HEADER = "Juke recognition — this month's standings:"

_CATEGORY_ORDER = [key for key, _ in LEADERBOARD_CATEGORIES]


def _byte_len(text: str) -> int:
    return len(text.encode("utf-8"))


def _render_line(label: str, usernames: list[str]) -> str:
    return f"{label}: {', '.join(f'@{u}' for u in usernames)}"


def _compose_text(winners_by_category: list[tuple[str, list[str]]]) -> str:
    """Compose the cast body: one line per category, "Label: @a, @b".

    Truncates gracefully, "categories over mentions" per spec: first drop
    whole trailing category lines; only if a single category line still
    can't fit (e.g. a large rank tie blew up its mention list) trim
    trailing mentions from it — a partial winner list beats an empty cast.
    Mentions are never cut mid-handle.
    """
    entries = [
        (label, list(usernames))
        for label, usernames in winners_by_category
        if usernames
    ]

    def _fits(lines: list[str]) -> bool:
        return _byte_len(CAST_HEADER + "\n" + "\n".join(lines)) <= CAST_BYTE_LIMIT

    while entries:
        lines = [_render_line(label, usernames) for label, usernames in entries]
        if _fits(lines):
            return CAST_HEADER + "\n" + "\n".join(lines)
        if len(entries) > 1:
            entries.pop()
            continue
        # Down to one category and still over budget: drop trailing
        # (lowest-ranked) mentions until it fits or nothing is left.
        label, usernames = entries[0]
        if len(usernames) > 1:
            entries[0] = (label, usernames[:-1])
        else:
            entries.pop()
    return CAST_HEADER


async def _resolve_usernames(db: AsyncSession, fids: list[int]) -> dict[int, str]:
    if not fids:
        return {}
    rows = (
        await db.execute(select(User.fid, User.username).where(User.fid.in_(fids)))
    ).all()
    return {fid: username for fid, username in rows if username}


def _group_by_category(
    awards: list[dict], usernames: dict[int, str]
) -> list[tuple[str, list[str]]]:
    """Group awards into (label, [username, ...]) per category, in the
    canonical LEADERBOARD_CATEGORIES order, sorted by rank within a
    category. FIDs with no resolvable username are skipped (can't @-mention
    someone with no handle).
    """
    by_category: dict[str, list[tuple[int, int]]] = {}
    label_by_category: dict[str, str] = {}
    for award in awards:
        category = award["category"]
        by_category.setdefault(category, []).append((award["rank"], award["fid"]))
        label_by_category[category] = award["label"]
    for rows in by_category.values():
        rows.sort(key=lambda r: (r[0], r[1]))

    out: list[tuple[str, list[str]]] = []
    for key in _CATEGORY_ORDER:
        if key not in by_category:
            continue
        mentionable = [
            usernames[fid] for _rank, fid in by_category[key] if fid in usernames
        ]
        if not mentionable:
            continue
        out.append((label_by_category[key], mentionable))
    return out


async def post_recap_cast(
    db: AsyncSession,
    awards: list[dict],
    *,
    cycle: str,
) -> str | None:
    """Best-effort: post the @jukeaudio recap cast for a closed cycle.

    ``awards`` is a list of ``{"fid", "category", "label", "rank"}`` dicts
    (the awards just written at cycle close). Returns the cast hash on
    success, or ``None`` on any failure — this function never raises, since
    the awards it announces are already committed.
    """
    if not awards:
        logger.warning("[leaderboard-recap] no awards to announce for cycle=%s", cycle)
        return None
    if not farcaster_writes.is_system_signer_configured():
        logger.warning(
            "[leaderboard-recap] system signer not configured; skipping "
            "recap cast for cycle=%s",
            cycle,
        )
        return None

    usernames = await _resolve_usernames(db, sorted({a["fid"] for a in awards}))
    winners_by_category = _group_by_category(awards, usernames)
    if not winners_by_category:
        logger.warning(
            "[leaderboard-recap] no mentionable winners (no usernames) for " "cycle=%s",
            cycle,
        )
        return None

    text = _compose_text(winners_by_category)
    # Winners' FIDs are already known, so mentions resolve with no lookups.
    resolver = farcaster_writes.known_mentions_resolver(
        {username: fid for fid, username in usernames.items()}
    )
    try:
        signer = farcaster_writes.load_system_signer()
        return await farcaster_writes.publish_cast(
            signer,
            text=text,
            embed_urls=[LEADERBOARD_URL],
            resolve_username=resolver,
        )
    except Exception as exc:  # noqa: BLE001 — announce must never fail close
        logger.warning(
            "[leaderboard-recap] failed to post recap cast for cycle=%s: %s",
            cycle,
            type(exc).__name__,
        )
        return None
