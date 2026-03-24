import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Ban(Base):
    __tablename__ = "bans"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=True,
    )
    banned_fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="RESTRICT"), nullable=False
    )
    banned_by_fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="RESTRICT"), nullable=False
    )
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("room_id", "banned_fid", name="uq_bans_room_banned_fid"),
        Index("ix_bans_room_banned_fid", "room_id", "banned_fid"),
        Index("ix_bans_banned_fid", "banned_fid"),
    )
