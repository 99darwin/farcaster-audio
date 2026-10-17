"""Admin-only recognition-leaderboard cycle-close review flow.

Endpoints:
  GET  /v1/leaderboard/admin/cycle/{cycle}         Full per-category standings for review
  POST /v1/leaderboard/admin/cycle/{cycle}/close   Human-reviewed close: writes awards,
                                                    busts the public cache, optionally
                                                    posts the @jukeaudio recap cast

STATUS-ONLY, like the rest of the leaderboard surface — recognition
language everywhere, never earn/reward/payout/prize (see
juke-recognition-leaderboard-spec.md).

Awards are the source of truth for a cycle being "final" (see
``LeaderboardAward`` docstring) — nightly aggregation never writes them, only
this close endpoint does, after a human has reviewed the standings and
supplied any exclusions.
"""

import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, get_redis
from app.middleware.auth import get_admin_user
from app.models.leaderboard import (
    LEADERBOARD_CATEGORIES,
    LEADERBOARD_CATEGORY_KEYS,
    LeaderboardAward,
    LeaderboardScore,
)
from app.models.user import User
from app.routers.leaderboard import PUBLIC_CACHE_PREFIX, _validate_cycle
from app.schemas.leaderboard import (
    AdminCategoryStandings,
    AdminCycleStandingsResponse,
    AdminStandingEntry,
    CloseCycleAwardItem,
    CloseCycleRequest,
    CloseCycleResponse,
)
from app.services.leaderboard_recap import post_recap_cast
from app.services.leaderboard_service import (
    ScoreRow,
    assign_ranks,
    current_cycle,
    get_excluded_fids,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/leaderboard/admin", tags=["leaderboard-admin"])

# Singular per-person award labels, distinct from the plural category-display
# labels in LEADERBOARD_CATEGORIES (e.g. "Top Hosts" the category vs.
# "Top Host" the badge one person wins). Keys must stay in lockstep with
# LEADERBOARD_CATEGORIES — the assertion below catches drift at import time.
AWARD_LABELS: dict[str, str] = {
    "top_hosts": "Top Host",
    "top_voices": "Top Voice",
    "top_casters": "Top Caster",
    "community": "Community",
}
assert set(AWARD_LABELS) == set(
    LEADERBOARD_CATEGORY_KEYS
), "AWARD_LABELS is out of sync with LEADERBOARD_CATEGORIES"

TOP_N = 3


async def _has_awards(db: AsyncSession, cycle: str) -> bool:
    return (
        await db.execute(
            select(LeaderboardAward.id).where(LeaderboardAward.cycle == cycle).limit(1)
        )
    ).first() is not None


@router.get("/cycle/{cycle}", response_model=AdminCycleStandingsResponse)
async def get_cycle_standings(
    cycle: str,
    _admin_fid: int = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> AdminCycleStandingsResponse:
    """Full per-category standings for human review before close.

    Unlike the public board (top 20, opt-out/agent/brand filtered out
    upstream at scoring time), every stored score row for the cycle is
    returned so an admin can see the whole field, plus each entry's current
    opt-out and is_agent flags — which may have changed *after* the score
    was computed (close re-checks both; showing them here explains why an
    entry will drop out of the awards).
    """
    cycle = _validate_cycle(cycle)
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
                User.leaderboard_opt_out,
                User.is_agent,
            )
            .outerjoin(User, User.fid == LeaderboardScore.fid)
            .where(LeaderboardScore.cycle == cycle)
            .order_by(
                LeaderboardScore.rank.asc().nulls_last(),
                LeaderboardScore.score.desc(),
            )
        )
    ).all()

    by_category: dict[str, list[AdminStandingEntry]] = {}
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
        opt_out,
        is_agent,
    ) in rows:
        if computed_at is None or (
            row_computed_at is not None and row_computed_at > computed_at
        ):
            computed_at = row_computed_at
        by_category.setdefault(category, []).append(
            AdminStandingEntry(
                rank=rank,
                fid=fid,
                username=username,
                display_name=display_name,
                pfp_url=pfp,
                score=score,
                opt_out=bool(opt_out),
                is_agent=bool(is_agent),
            )
        )

    has_awards = await _has_awards(db, cycle)
    categories = [
        AdminCategoryStandings(key=key, label=label, entries=by_category.get(key, []))
        for key, label in LEADERBOARD_CATEGORIES
    ]
    return AdminCycleStandingsResponse(
        cycle=cycle,
        status="final" if has_awards else "open",
        computed_at=computed_at,
        categories=categories,
    )


@router.post("/cycle/{cycle}/close", response_model=CloseCycleResponse)
async def close_cycle(
    cycle: str,
    body: CloseCycleRequest,
    admin_fid: int = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
) -> CloseCycleResponse:
    """Human-reviewed cycle close.

    Writes the top 3 per category (after exclusions, ranks recomputed over
    the remaining entries; ties can push a category above 3 winners), busts
    the public cache for the cycle so ``status`` flips to "final"
    immediately, and — if requested — posts the @jukeaudio recap cast.

    Idempotent by design: a cycle with awards already written 409s rather
    than re-closing, since there's no force flag.
    """
    cycle = _validate_cycle(cycle)
    if cycle >= current_cycle():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "Only cycles strictly before the current month can be "
                "closed — you close a month after it ends"
            ),
        )
    if await _has_awards(db, cycle):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cycle {cycle} has already been closed",
        )

    rows = (
        await db.execute(
            select(
                LeaderboardScore.fid,
                LeaderboardScore.category,
                LeaderboardScore.score,
            ).where(LeaderboardScore.cycle == cycle)
        )
    ).all()

    # Excluded = the human's explicit list UNION everyone the scoring engine
    # excludes as of *now* (opted-out users, is_agent users, and the brand
    # fid — via the same ``get_excluded_fids`` the nightly pass uses). The
    # stored scores may predate a later opt-out or agent flag (scoring runs
    # nightly; those flags take effect immediately), so close must re-check
    # them rather than trust the score snapshot — awards are permanent.
    manual_exclusions = set(body.exclusions or [])
    excluded = manual_exclusions | await get_excluded_fids(db)

    by_category: dict[str, list[ScoreRow]] = {}
    for fid, category, score in rows:
        if fid in excluded:
            continue
        by_category.setdefault(category, []).append(ScoreRow(fid, category, score))

    now = datetime.now(tz=timezone.utc)
    award_rows: list[LeaderboardAward] = []
    for key, _display_label in LEADERBOARD_CATEGORIES:
        category_rows = by_category.get(key, [])
        assign_ranks(category_rows)
        label = AWARD_LABELS[key]
        for row in category_rows:
            if row.rank is not None and row.rank <= TOP_N:
                award_rows.append(
                    LeaderboardAward(
                        fid=row.fid,
                        cycle=cycle,
                        category=key,
                        rank=row.rank,
                        label=label,
                        created_at=now,
                    )
                )

    # Awards are the only "this cycle is final" marker (``_has_awards``), so
    # a close that writes zero rows would silently not take: status would
    # stay "open" and a re-close would 200 instead of 409. Refuse instead —
    # an empty cycle (no scores, or every candidate excluded) has nothing to
    # recognize and nothing to announce.
    if not award_rows:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Cycle {cycle} has no qualifying entries to recognize "
                "(no scores, or every candidate is excluded) — nothing to close"
            ),
        )

    for award in award_rows:
        db.add(award)
    # The 409 check above is a TOCTOU-prone read: two concurrent admin close
    # requests for the same cycle can both pass it before either commits.
    # ``uq_leaderboard_awards_fid_cycle_category`` is the real guard — a
    # losing concurrent writer hits it here and gets a clean 409 instead of
    # an unhandled 500 or (worse) silently duplicated awards.
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cycle {cycle} has already been closed",
        )

    try:
        await redis.delete(f"{PUBLIC_CACHE_PREFIX}{cycle}")
    except Exception:  # noqa: BLE001 — cache bust is best-effort
        logger.warning(
            "[leaderboard-admin] failed to bust public cache for cycle=%s", cycle
        )

    logger.info(
        "[leaderboard-admin] closed cycle=%s admin_fid=%s awards=%d excluded=%d",
        cycle,
        admin_fid,
        len(award_rows),
        len(excluded),
    )

    announce_cast_hash: str | None = None
    if body.announce:
        announce_cast_hash = await post_recap_cast(
            db,
            [
                {
                    "fid": award.fid,
                    "category": award.category,
                    "label": award.label,
                    "rank": award.rank,
                }
                for award in award_rows
            ],
            cycle=cycle,
        )

    return CloseCycleResponse(
        cycle=cycle,
        awards=[
            CloseCycleAwardItem(
                fid=award.fid,
                category=award.category,
                label=award.label,
                rank=award.rank,
            )
            for award in award_rows
        ],
        announce_cast_hash=announce_cast_hash,
    )
