from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserBlock(Base):
    __tablename__ = "user_blocks"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    blocker_fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="CASCADE"), nullable=False
    )
    blocked_fid: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("blocker_fid", "blocked_fid", name="uq_user_blocks_pair"),
        Index("ix_user_blocks_blocker_fid", "blocker_fid"),
        Index("ix_user_blocks_blocked_fid", "blocked_fid"),
    )
