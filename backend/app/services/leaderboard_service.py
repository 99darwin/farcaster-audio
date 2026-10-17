"""Recognition leaderboard scoring engine + nightly aggregation.

STATUS-ONLY. No money, ever (see juke-recognition-leaderboard-spec.md).

Scoring is monthly (calendar month, UTC), concave, and distinct-engager based
so ten people once beats one person ten times. Four categories:

- ``top_hosts``   : per hosted room (ended, >=10 min live) -> sqrt(distinct
                    non-host participants). Summed. Local DB only.
- ``top_voices``  : per voice note published in-cycle -> 1 + sqrt(distinct
                    reactors+repliers). Hypersnap-hydrated.
- ``top_casters`` : per cast_records row in-cycle (all sources EXCEPT
                    voice_note, which scores under top_voices) -> 1 +
                    sqrt(distinct engagers). Hypersnap-hydrated.
- ``community``   : LOCAL DB ONLY (no upstream cost). Points for speaking in
                    rooms hosted by OTHERS plus a smaller amount per distinct
                    room joined.

Excluded from every board: ``users.is_agent``, ``users.leaderboard_opt_out``,
and the @jukeaudio brand account. Self-engagement is excluded from engager
counts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.clients import hypersnap
from app.config import settings
from app.models.cast_record import CastRecord
from app.models.leaderboard import LEADERBOARD_CATEGORY_KEYS, LeaderboardScore
from app.models.participant import Participant
from app.models.room import Room
from app.models.user import User
from app.models.voice_note import VoiceNote

logger = logging.getLogger(__name__)

CYCLE_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

# --- Scoring parameters (directional, evolvable — see spec §2) ---
MIN_ROOM_DURATION_SECONDS = 10 * 60  # "min 10 min live" for a hosted room.
# Community weights. Distinct-room based, so a single room can't be farmed.
# Speaking in someone else's room is the higher-signal contribution; simply
# showing up (any role) earns a smaller amount.
COMMUNITY_SPEAKER_ROOM_POINTS = 3.0
COMMUNITY_JOINED_ROOM_POINTS = 1.0
SPEAKER_ROLES = ("speaker", "co_host")

# --- Hypersnap engagement hydration ---
ENGAGERS_CACHE_PREFIX = "lb:engagers:v1:"
ENGAGERS_CACHE_TTL_SECONDS = 6 * 60 * 60  # Stable historical data — 6h is safe.
ENGAGEMENT_REACTION_TYPES = ("likes", "recasts")
REACTION_PAGE_LIMIT = 100
MAX_REACTION_PAGES = 3  # Per reaction type; bounds cost at ~90-user scale.
CONVERSATION_REPLY_LIMIT = 50
HYDRATION_CONCURRENCY = 4  # Rate-limit friendly.

# --- Nightly loop ---
AGGREGATION_INTERVAL_SECONDS = 6 * 60 * 60  # Recompute the live cycle 4x/day.
AGGREGATION_LOCK_KEY = "lb:agg:lock"
# The lock is deliberately held for its full TTL (never released early) so
# workers with staggered start times don't each rerun the same pass.
# INVARIANT: interval_seconds must stay >= this TTL, or passes silently
# no-op; a mid-pass crash blocks the next pass for at most this long.
AGGREGATION_LOCK_TTL_SECONDS = 30 * 60


def utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def current_cycle(now: datetime | None = None) -> str:
    now = now or utcnow()
    return f"{now.year:04d}-{now.month:02d}"


def is_valid_cycle(cycle: str) -> bool:
    return bool(CYCLE_RE.match(cycle))


def cycle_bounds(cycle: str) -> tuple[datetime, datetime]:
    """Return [start, end) UTC datetimes for a "YYYY-MM" cycle."""
    if not is_valid_cycle(cycle):
        raise ValueError(f"Invalid cycle: {cycle!r}")
    year, month = (int(p) for p in cycle.split("-"))
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return start, end


@dataclass
class ScoreRow:
    fid: int
    category: str
    score: float
    breakdown: dict = field(default_factory=dict)
    rank: int | None = None


# ---------------------------------------------------------------------------
# Hypersnap engagement hydration
# ---------------------------------------------------------------------------


class HypersnapEngagementFetcher:
    """Fetches the set of distinct engager fids (reactors + repliers) for a
    cast hash, cached in Redis so nightly runs don't refetch stable data.

    Best-effort: any Hypersnap/Redis failure yields an empty set so scoring
    degrades to the base ``1`` per item rather than crashing the run. A
    failed lookup is not cached, so the next pass retries it.
    """

    def __init__(self, redis) -> None:
        self._redis = redis

    async def distinct_engagers(self, cast_hash: str) -> set[int]:
        if not cast_hash:
            return set()
        cached = await self._read_cache(cast_hash)
        if cached is not None:
            return cached
        engagers: set[int] = set()
        try:
            for reaction_type in ENGAGEMENT_REACTION_TYPES:
                engagers |= await self._fetch_reactors(cast_hash, reaction_type)
            engagers |= await self._fetch_repliers(cast_hash)
        except hypersnap.HypersnapError as exc:
            logger.warning(
                "[leaderboard] engager hydration failed for %s: %s status=%s",
                cast_hash[:12],
                type(exc).__name__,
                exc.status_code,
            )
            return set()
        await self._write_cache(cast_hash, engagers)
        return engagers

    async def _read_cache(self, cast_hash: str) -> set[int] | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(f"{ENGAGERS_CACHE_PREFIX}{cast_hash}")
        except Exception:  # noqa: BLE001
            return None
        if raw is None:
            return None
        try:
            data = json.loads(raw if isinstance(raw, str) else raw.decode())
            return {int(f) for f in data}
        except (ValueError, TypeError):
            return None

    async def _write_cache(self, cast_hash: str, engagers: set[int]) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.set(
                f"{ENGAGERS_CACHE_PREFIX}{cast_hash}",
                json.dumps(sorted(engagers)),
                ex=ENGAGERS_CACHE_TTL_SECONDS,
            )
        except Exception:  # noqa: BLE001
            pass

    async def _fetch_reactors(self, cast_hash: str, reaction_type: str) -> set[int]:
        """Distinct reactor fids of one type (``likes`` or ``recasts``).

        Hypersnap's ``types=all`` returns likes only, so each type is queried
        separately.
        """
        out: set[int] = set()
        async for page in hypersnap.paginate(
            "/reaction/cast",
            {"hash": cast_hash, "types": reaction_type, "limit": REACTION_PAGE_LIMIT},
            max_pages=MAX_REACTION_PAGES,
        ):
            for reaction in page.get("reactions") or []:
                fid = (reaction.get("user") or {}).get("fid")
                if isinstance(fid, int):
                    out.add(fid)
        return out

    async def _fetch_repliers(self, cast_hash: str) -> set[int]:
        try:
            data = await hypersnap.get(
                "/cast/conversation",
                {
                    "identifier": cast_hash,
                    "type": "hash",
                    "reply_depth": 1,
                    "limit": CONVERSATION_REPLY_LIMIT,
                },
            )
        except hypersnap.HypersnapNotFound:
            return set()
        cast = (data.get("conversation") or {}).get("cast") or {}
        out: set[int] = set()
        for reply in cast.get("direct_replies") or []:
            fid = (reply.get("author") or {}).get("fid")
            if isinstance(fid, int):
                out.add(fid)
        return out


async def _hydrate_engagers(
    fetcher: HypersnapEngagementFetcher, hashes: set[str]
) -> dict[str, set[int]]:
    """Hydrate every distinct cast hash once, with bounded concurrency."""
    result: dict[str, set[int]] = {}
    sem = asyncio.Semaphore(HYDRATION_CONCURRENCY)

    async def _one(h: str) -> None:
        async with sem:
            result[h] = await fetcher.distinct_engagers(h)

    await asyncio.gather(*(_one(h) for h in hashes))
    return result


# ---------------------------------------------------------------------------
# Exclusions
# ---------------------------------------------------------------------------


async def resolve_brand_fid(db: AsyncSession) -> int | None:
    """Resolve the @jukeaudio brand fid to exclude from all boards.

    Prefers the explicit ``BRAND_FID`` setting; otherwise looks up the user
    row owning ``JUKEAUDIO_SIGNER_UUID``. Returns None if unresolvable.
    """
    if settings.BRAND_FID:
        return settings.BRAND_FID
    signer = (settings.JUKEAUDIO_SIGNER_UUID or "").strip()
    if not signer:
        return None
    return (
        await db.execute(select(User.fid).where(User.signer_uuid == signer))
    ).scalar_one_or_none()


async def get_excluded_fids(db: AsyncSession) -> set[int]:
    """FIDs excluded from all boards: agents, opted-out users, brand."""
    rows = (
        (
            await db.execute(
                select(User.fid).where(
                    (User.is_agent.is_(True)) | (User.leaderboard_opt_out.is_(True))
                )
            )
        )
        .scalars()
        .all()
    )
    excluded = set(rows)
    brand = await resolve_brand_fid(db)
    if brand is not None:
        excluded.add(brand)
    return excluded


# ---------------------------------------------------------------------------
# Per-category scoring
# ---------------------------------------------------------------------------


async def _score_top_hosts(
    db: AsyncSession, start: datetime, end: datetime, excluded: set[int]
) -> list[ScoreRow]:
    rooms = (
        (
            await db.execute(
                select(Room).where(
                    Room.started_at >= start,
                    Room.started_at < end,
                    Room.ended_at.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )
    qualifying = [
        r
        for r in rooms
        if r.host_fid not in excluded
        and r.ended_at is not None
        and (r.ended_at - r.started_at).total_seconds() >= MIN_ROOM_DURATION_SECONDS
    ]
    if not qualifying:
        return []
    room_ids = [r.id for r in qualifying]
    participants = (
        await db.execute(
            select(Participant.room_id, Participant.fid).where(
                Participant.room_id.in_(room_ids)
            )
        )
    ).all()
    listeners_by_room: dict = {}
    for room_id, fid in participants:
        listeners_by_room.setdefault(room_id, set()).add(fid)

    by_fid: dict[int, ScoreRow] = {}
    for room in qualifying:
        distinct = listeners_by_room.get(room.id, set()) - {room.host_fid}
        n = len(distinct)
        row = by_fid.setdefault(
            room.host_fid,
            ScoreRow(room.host_fid, "top_hosts", 0.0, {"rooms": []}),
        )
        row.score += math.sqrt(n)
        row.breakdown["rooms"].append(
            {"room_id": str(room.id), "distinct_listeners": n}
        )
    return list(by_fid.values())


async def _score_from_hashes(
    category: str,
    items: list[tuple[int, str]],
    engager_map: dict[str, set[int]],
) -> list[ScoreRow]:
    """Score categories whose points are ``1 + sqrt(distinct engagers)`` per
    published cast. ``items`` is a list of ``(author_fid, cast_hash)``.
    Self-engagement is excluded from the engager set.
    """
    by_fid: dict[int, ScoreRow] = {}
    for author_fid, cast_hash in items:
        engagers = engager_map.get(cast_hash, set()) - {author_fid}
        n = len(engagers)
        row = by_fid.setdefault(
            author_fid, ScoreRow(author_fid, category, 0.0, {"items": []})
        )
        row.score += 1.0 + math.sqrt(n)
        row.breakdown["items"].append(
            {"cast_hash": cast_hash, "engagers": sorted(engagers)}
        )
    return list(by_fid.values())


async def _score_community(
    db: AsyncSession, start: datetime, end: datetime, excluded: set[int]
) -> list[ScoreRow]:
    # Join participants with their room's host_fid so we can tell "spoke in
    # someone else's room" from "hosted my own". Cycle membership keyed on
    # join time.
    rows = (
        await db.execute(
            select(
                Participant.fid,
                Participant.room_id,
                Participant.role,
                Room.host_fid,
            )
            .join(Room, Room.id == Participant.room_id)
            .where(Participant.joined_at >= start, Participant.joined_at < end)
        )
    ).all()
    joined_rooms: dict[int, set] = {}
    speaker_rooms: dict[int, set] = {}
    for fid, room_id, role, host_fid in rows:
        if fid in excluded:
            continue
        # Community rewards showing up for OTHER people's rooms. A host's
        # presence in their own room is already rewarded under top_hosts —
        # no join or speaker credit for it here (no double-dipping).
        if host_fid == fid:
            continue
        joined_rooms.setdefault(fid, set()).add(room_id)
        if role in SPEAKER_ROLES:
            speaker_rooms.setdefault(fid, set()).add(room_id)

    out: list[ScoreRow] = []
    for fid, joined in joined_rooms.items():
        n_speaker = len(speaker_rooms.get(fid, set()))
        n_joined = len(joined)
        score = (
            COMMUNITY_SPEAKER_ROOM_POINTS * n_speaker
            + COMMUNITY_JOINED_ROOM_POINTS * n_joined
        )
        if score <= 0:
            continue
        out.append(
            ScoreRow(
                fid,
                "community",
                score,
                {"speaker_rooms": n_speaker, "joined_rooms": n_joined},
            )
        )
    return out


# ---------------------------------------------------------------------------
# Ranking + orchestration
# ---------------------------------------------------------------------------


def assign_ranks(rows: list[ScoreRow]) -> None:
    """Assign ranks per category; ties share a rank (1, 2, 2, 4)."""
    by_category: dict[str, list[ScoreRow]] = {}
    for row in rows:
        by_category.setdefault(row.category, []).append(row)
    for category_rows in by_category.values():
        category_rows.sort(key=lambda r: r.score, reverse=True)
        prev_score: float | None = None
        prev_rank = 0
        for i, row in enumerate(category_rows, start=1):
            if prev_score is not None and math.isclose(row.score, prev_score):
                row.rank = prev_rank
            else:
                row.rank = i
                prev_rank = i
                prev_score = row.score


async def compute_cycle_scores(
    db: AsyncSession,
    fetcher: HypersnapEngagementFetcher,
    *,
    cycle: str,
) -> list[ScoreRow]:
    """Compute all category scores for a cycle. Rows with score <= 0 are
    dropped; ranks are assigned per category before returning.
    """
    start, end = cycle_bounds(cycle)
    excluded = await get_excluded_fids(db)

    host_rows = await _score_top_hosts(db, start, end, excluded)
    community_rows = await _score_community(db, start, end, excluded)

    # Gather cast hashes for the Hypersnap-hydrated categories.
    voice_notes = (
        await db.execute(
            select(VoiceNote.fid, VoiceNote.cast_hash).where(
                VoiceNote.created_at >= start,
                VoiceNote.created_at < end,
                VoiceNote.cast_hash.is_not(None),
                VoiceNote.deleted_at.is_(None),
            )
        )
    ).all()
    caster_records = (
        await db.execute(
            select(CastRecord.fid, CastRecord.cast_hash).where(
                CastRecord.created_at >= start,
                CastRecord.created_at < end,
                CastRecord.source != "voice_note",
            )
        )
    ).all()

    voice_items = [(fid, h) for fid, h in voice_notes if fid not in excluded and h]
    caster_items = [(fid, h) for fid, h in caster_records if fid not in excluded and h]

    all_hashes = {h for _, h in voice_items} | {h for _, h in caster_items}
    engager_map = await _hydrate_engagers(fetcher, all_hashes)

    voice_rows = await _score_from_hashes("top_voices", voice_items, engager_map)
    caster_rows = await _score_from_hashes("top_casters", caster_items, engager_map)

    rows = [
        r
        for r in (*host_rows, *voice_rows, *caster_rows, *community_rows)
        if r.score > 0
    ]
    assign_ranks(rows)
    return rows


async def store_cycle_scores(
    db: AsyncSession, cycle: str, rows: list[ScoreRow]
) -> None:
    """Replace all stored scores for a cycle with a freshly computed set.

    Delete-then-insert (in one transaction) so users who dropped to a zero
    score are removed rather than left stale.
    """
    now = utcnow()
    await db.execute(delete(LeaderboardScore).where(LeaderboardScore.cycle == cycle))
    for row in rows:
        if row.category not in LEADERBOARD_CATEGORY_KEYS:
            continue
        db.add(
            LeaderboardScore(
                fid=row.fid,
                cycle=cycle,
                category=row.category,
                score=row.score,
                rank=row.rank,
                breakdown=row.breakdown,
                computed_at=now,
            )
        )
    await db.commit()


async def recompute_cycle(
    session_maker: async_sessionmaker[AsyncSession],
    redis,
    *,
    cycle: str | None = None,
    fetcher: HypersnapEngagementFetcher | None = None,
) -> int:
    """Recompute + persist scores for a cycle (default: current month).

    Also the manual trigger path for tests/ops. Returns the number of score
    rows written.
    """
    cycle = cycle or current_cycle()
    if not is_valid_cycle(cycle):
        raise ValueError(f"Invalid cycle: {cycle!r}")
    fetcher = fetcher or HypersnapEngagementFetcher(redis)
    async with session_maker() as db:
        rows = await compute_cycle_scores(db, fetcher, cycle=cycle)
        await store_cycle_scores(db, cycle, rows)
    logger.info("[leaderboard] recomputed cycle=%s rows=%d", cycle, len(rows))
    return len(rows)


# ---------------------------------------------------------------------------
# Nightly aggregation loop (mirrors ScheduledCastPublisher lifecycle)
# ---------------------------------------------------------------------------


class LeaderboardAggregator:
    """Periodically recomputes the current cycle's scores.

    Every app worker runs this loop, but a Redis ``SET NX EX`` lock ensures
    only one worker performs a given pass so Hypersnap isn't hit N times.
    """

    def __init__(
        self,
        session_maker: async_sessionmaker[AsyncSession],
        redis,
        *,
        interval_seconds: float = AGGREGATION_INTERVAL_SECONDS,
    ) -> None:
        self._session_maker = session_maker
        self._redis = redis
        self._interval_seconds = interval_seconds
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(
            self._run_forever(), name="leaderboard-aggregator"
        )

    async def stop(self) -> None:
        self._stop_event.set()
        task = self._task
        if task is None:
            return
        if not task.done():
            task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        self._task = None

    async def _run_forever(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.run_once()
            except Exception as exc:  # noqa: BLE001 - keep the worker alive
                logger.error(
                    "[leaderboard] aggregation pass failed: %s", type(exc).__name__
                )
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self._interval_seconds
                )
            except asyncio.TimeoutError:
                continue

    async def _try_acquire_lock(self) -> bool:
        try:
            acquired = await self._redis.set(
                AGGREGATION_LOCK_KEY, "1", nx=True, ex=AGGREGATION_LOCK_TTL_SECONDS
            )
            return bool(acquired)
        except Exception:  # noqa: BLE001 — if the lock is unavailable, skip.
            return False

    async def run_once(self) -> int:
        if not await self._try_acquire_lock():
            logger.debug("[leaderboard] another worker holds the aggregation lock")
            return 0
        return await recompute_cycle(self._session_maker, self._redis)
