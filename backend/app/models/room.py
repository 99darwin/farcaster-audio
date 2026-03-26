import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    host_fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="RESTRICT"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", index=True)
    livekit_room_id: Mapped[str | None] = mapped_column(String(128))
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    max_speakers: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    max_listeners: Mapped[int] = mapped_column(Integer, nullable=False, default=500)
    recording: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    recording_url: Mapped[str | None] = mapped_column(Text)
    cast_hash: Mapped[str | None] = mapped_column(String(66), index=True)
    neynar_webhook_id: Mapped[str | None] = mapped_column(String(64))
    neynar_webhook_secret: Mapped[str | None] = mapped_column(String(256))
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, nullable=False, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        Index("ix_rooms_started_at_desc", "started_at", postgresql_ops={"started_at": "DESC"}),
    )
