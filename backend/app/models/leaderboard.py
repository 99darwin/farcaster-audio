import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# The four recognition categories. Kept here as the single source of truth so
# models, service, and API all agree on the allowed set + display labels.
LEADERBOARD_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("top_hosts", "Top Hosts"),
    ("top_voices", "Top Voices"),
    ("top_casters", "Top Casters"),
    ("community", "Community"),
)
LEADERBOARD_CATEGORY_KEYS: tuple[str, ...] = tuple(k for k, _ in LEADERBOARD_CATEGORIES)
_CATEGORY_CHECK = "category IN ('top_hosts', 'top_voices', 'top_casters', 'community')"


class LeaderboardScore(Base):
    """One computed category score for a user in a monthly cycle.

    Recomputed nightly (delete-then-insert per cycle). ``breakdown`` records
    the score inputs — including the distinct engager fids per cast — so a
    future Neynar user-quality-score floor can be switched on without a
    schema change or a re-hydration.
    """

    __tablename__ = "leaderboard_scores"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    # Calendar month, UTC, formatted "YYYY-MM".
    cycle: Mapped[str] = mapped_column(String(7), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    rank: Mapped[int | None] = mapped_column(Integer, nullable=True)
    breakdown: Mapped[dict] = mapped_column(
        # JSONB on Postgres (production), generic JSON on SQLite (tests).
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        server_default="{}",
    )
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "fid", "cycle", "category", name="uq_leaderboard_scores_fid_cycle_category"
        ),
        CheckConstraint(_CATEGORY_CHECK, name="ck_leaderboard_scores_category"),
        Index("ix_leaderboard_scores_cycle_category", "cycle", "category"),
    )


class LeaderboardAward(Base):
    """A persistent recognition badge, written only at cycle close.

    Awards are the source of truth for a cycle being "final". Nightly
    aggregation never writes awards — a later human-reviewed cycle-close job
    does. Profiles read badges from here.
    """

    __tablename__ = "leaderboard_awards"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    cycle: Mapped[str] = mapped_column(String(7), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "fid", "cycle", "category", name="uq_leaderboard_awards_fid_cycle_category"
        ),
        CheckConstraint(_CATEGORY_CHECK, name="ck_leaderboard_awards_category"),
    )
