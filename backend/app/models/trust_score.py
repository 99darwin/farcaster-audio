from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, Index, SmallInteger, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TrustScore(Base):
    __tablename__ = "trust_scores"

    fid: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    neynar_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    warpcast_label: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    composite: Mapped[float] = mapped_column(Float, nullable=False)
    is_spam: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_trust_scores_is_spam", "is_spam", postgresql_where=(is_spam == True)),  # noqa: E712
    )
