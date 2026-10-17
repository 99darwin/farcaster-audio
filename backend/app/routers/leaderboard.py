"""Public + authenticated recognition leaderboard API.

Response shapes are a FROZEN contract (web + mobile build against them). Only
non-sensitive user fields are exposed: fid, username, display_name, pfp_url,
score, rank.
"""

import logging

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_redis
from app.middleware.auth import require_first_party_user
from app.models.leaderboard import (
    LEADERBOARD_CATEGORIES,
    LeaderboardAward,
    LeaderboardScore,
)
from app.models.user import User
from app.schemas.leaderboard import (
    AwardItem,
    AwardsResponse,
    LeaderboardCategory,
    LeaderboardEntry,
    LeaderboardResponse,
    MyCategoryStanding,
    MyLeaderboardResponse,
    OptOutRequest,
    OptOutResponse,
)
from app.services.leaderboard_service import (
    current_cycle,
    is_valid_cycle,
    resolve_brand_fid,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/leaderboard", tags=["leaderboard"])

PUBLIC_CACHE_PREFIX = "lb:public:v1:"
PUBLIC_CACHE_TTL_SECONDS = 5 * 60
MAX_ENTRIES_PER_CATEGORY = 20

# Bound the accepted cycle window so the unauthenticated, per-cycle-cached
# endpoint can't be used to bypass the cache (and fill Redis) by iterating
# the ~120k syntactically valid "YYYY-MM" strings. Zero-padded YYYY-MM
# compares correctly as a string. No leaderboard data exists before launch,
# and future cycles beyond the current month have nothing to show.
MIN_CYCLE = "2026-01"


def _all_cycles() -> list[str]:
    """Every cycle the public endpoint can serve: MIN_CYCLE..current month."""
    year, month = (int(p) for p in MIN_CYCLE.split("-"))
    end = current_cycle()
    out: list[str] = []
    while (cycle := f"{year:04d}-{month:02d}") <= end:
        out.append(cycle)
        month += 1
        if month > 12:
            month = 1
            year += 1
    return out


def _validate_cycle(cycle: str | None) -> str:
    """Return a valid cycle, defaulting to the current month.

    422 on garbage or on cycles outside [MIN_CYCLE, current month] — the
    out-of-window rejection bounds the public endpoint's cache keyspace.
    """
    if cycle is None:
        return current_cycle()
    if not is_valid_cycle(cycle) or not (MIN_CYCLE <= cycle <= current_cycle()):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "cycle must be formatted YYYY-MM and fall between "
                f"{MIN_CYCLE} and the current month"
            ),
        )
    return cycle


async def _build_public_response(db: AsyncSession, cycle: str) -> LeaderboardResponse:
    """Assemble the public board from stored scores, hydrating display fields
    from the users table and excluding agents / opted-out users / brand.
    """
    brand_fid = await resolve_brand_fid(db)
    rows = (
        await db.execute(
            select(
                LeaderboardScore.category,
                LeaderboardScore.rank,
                LeaderboardScore.score,
                LeaderboardScore.computed_at,
                LeaderboardScore.fid,
                User.username,
                User.display_name,
                User.pfp_url,
            )
            # Outer join: cast_records fids carry no FK to users, so a scored
            # creator without a local user row must still appear (with null
            # display fields) instead of silently burning a rank slot.
            .outerjoin(User, User.fid == LeaderboardScore.fid)
            .where(
                LeaderboardScore.cycle == cycle,
                or_(
                    User.fid.is_(None),
                    and_(
                        User.is_agent.is_(False),
                        User.leaderboard_opt_out.is_(False),
                    ),
                ),
            )
            .order_by(
                LeaderboardScore.rank.asc().nulls_last(),
                LeaderboardScore.score.desc(),
            )
        )
    ).all()

    by_category: dict[str, list[LeaderboardEntry]] = {}
    computed_at = None
    for (
        category,
        rank,
        score,
        row_computed_at,
        fid,
        username,
        display_name,
        pfp,
    ) in rows:
        if brand_fid is not None and fid == brand_fid:
            continue
        if computed_at is None or (
            row_computed_at is not None and row_computed_at > computed_at
        ):
            computed_at = row_computed_at
        bucket = by_category.setdefault(category, [])
        if len(bucket) >= MAX_ENTRIES_PER_CATEGORY:
            continue
        bucket.append(
            LeaderboardEntry(
                rank=rank if rank is not None else len(bucket) + 1,
                fid=fid,
                username=username,
                display_name=display_name,
                pfp_url=pfp,
                score=score,
            )
        )

    has_awards = (
        await db.execute(
            select(LeaderboardAward.id).where(LeaderboardAward.cycle == cycle).limit(1)
        )
    ).first() is not None

    categories = [
        LeaderboardCategory(key=key, label=label, entries=by_category.get(key, []))
        for key, label in LEADERBOARD_CATEGORIES
    ]
    return LeaderboardResponse(
        cycle=cycle,
        status="final" if has_awards else "provisional",
        computed_at=computed_at,
        categories=categories,
    )


@router.get("", response_model=LeaderboardResponse)
async def get_leaderboard(
    cycle: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> LeaderboardResponse:
    """Public board for a cycle (no auth). Redis-cached 5 minutes."""
    cycle = _validate_cycle(cycle)
    cache_key = f"{PUBLIC_CACHE_PREFIX}{cycle}"
    try:
        cached = await redis.get(cache_key)
    except Exception:  # noqa: BLE001 — cache is best-effort
        cached = None
    if cached:
        try:
            return LeaderboardResponse.model_validate_json(cached)
        except Exception:  # noqa: BLE001 — poisoned cache, rebuild
            pass

    response = await _build_public_response(db, cycle)
    try:
        await redis.set(
            cache_key, response.model_dump_json(), ex=PUBLIC_CACHE_TTL_SECONDS
        )
    except Exception:  # noqa: BLE001
        pass
    return response


@router.get("/me", response_model=MyLeaderboardResponse)
async def get_my_standing(
    cycle: str | None = Query(default=None),
    fid: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MyLeaderboardResponse:
    """The authenticated user's rank + score per category for a cycle."""
    cycle = _validate_cycle(cycle)
    opt_out = bool(
        (
            await db.execute(select(User.leaderboard_opt_out).where(User.fid == fid))
        ).scalar_one_or_none()
    )
    rows = (
        await db.execute(
            select(
                LeaderboardScore.category,
                LeaderboardScore.rank,
                LeaderboardScore.score,
            ).where(LeaderboardScore.fid == fid, LeaderboardScore.cycle == cycle)
        )
    ).all()
    standings = {category: (rank, score) for category, rank, score in rows}
    categories = [
        MyCategoryStanding(
            key=key,
            rank=standings.get(key, (None, 0.0))[0],
            score=standings.get(key, (None, 0.0))[1],
        )
        for key, _ in LEADERBOARD_CATEGORIES
    ]
    return MyLeaderboardResponse(cycle=cycle, opt_out=opt_out, categories=categories)


@router.put("/opt-out", response_model=OptOutResponse)
async def set_opt_out(
    body: OptOutRequest,
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> OptOutResponse:
    """Set the user's leaderboard opt-out flag. Honored immediately.

    First-party JWTs only: a partner-minted token must not be able to toggle
    a user's privacy preference (matches the account-mutation pattern).
    """
    user = (await db.execute(select(User).where(User.fid == fid))).scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    user.leaderboard_opt_out = body.opt_out
    await db.commit()
    # Invalidate every servable cycle's cached board so the change is visible
    # immediately rather than after the 5-minute TTL. The cycle window is
    # bounded (MIN_CYCLE..current month), so this is a small fixed key set.
    try:
        await redis.delete(*(f"{PUBLIC_CACHE_PREFIX}{c}" for c in _all_cycles()))
    except Exception:  # noqa: BLE001
        pass
    return OptOutResponse(opt_out=body.opt_out)


@router.get("/awards/{fid}", response_model=AwardsResponse)
async def get_awards(
    fid: int,
    db: AsyncSession = Depends(get_db),
) -> AwardsResponse:
    """Public list of a user's earned recognition badges.

    Opt-out is honored retroactively: an opted-out user "never appears on any
    public board" includes their historical badges, so we return an empty
    list rather than leaking past rankings.
    """
    opted_out = (
        await db.execute(select(User.leaderboard_opt_out).where(User.fid == fid))
    ).scalar_one_or_none()
    if opted_out:
        return AwardsResponse(fid=fid, awards=[])
    rows = (
        await db.execute(
            select(
                LeaderboardAward.cycle,
                LeaderboardAward.category,
                LeaderboardAward.label,
                LeaderboardAward.rank,
            )
            .where(LeaderboardAward.fid == fid)
            .order_by(LeaderboardAward.cycle.desc(), LeaderboardAward.category.asc())
        )
    ).all()
    awards = [
        AwardItem(cycle=cycle, category=category, label=label, rank=rank)
        for cycle, category, label, rank in rows
    ]
    return AwardsResponse(fid=fid, awards=awards)
