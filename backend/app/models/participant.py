import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Participant(Base):
    __tablename__ = "participants"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    room_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
    )
    fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="listener")
    is_muted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    hand_raised: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    hand_raised_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("room_id", "fid", name="uq_participants_room_fid"),
        Index("ix_participants_room_id", "room_id"),
        Index(
            "ix_participants_room_id_active",
            "room_id",
            postgresql_where=text("left_at IS NULL"),
        ),
    )
