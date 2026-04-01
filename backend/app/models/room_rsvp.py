import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class RoomRsvp(Base):
    __tablename__ = "room_rsvps"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    room_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False
    )
    fid: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.fid"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("room_id", "fid", name="uq_room_rsvps_room_fid"),
        Index("ix_room_rsvps_room_id", "room_id"),
    )
