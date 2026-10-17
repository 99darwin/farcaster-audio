from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    Index,
    SmallInteger,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TrustScore(Base):
    __tablename__ = "trust_scores"

    fid: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Per-FID trust score in [0, 1]; ``source`` says where it came from
    # ("heuristic" = local Hypersnap scoring, "neynar" = legacy Neynar score).
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    warpcast_label: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    composite: Mapped[float] = mapped_column(Float, nullable=False)
    is_spam: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        Index(
            "ix_trust_scores_is_spam",
            "is_spam",
            postgresql_where=(is_spam == True),  # noqa: E712
        ),
    )
