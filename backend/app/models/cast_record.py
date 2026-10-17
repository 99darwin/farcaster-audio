import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CastRecord(Base):
    """Protocol-level attribution of a cast published via Juke.

    One row per user-authored cast that left through a Juke surface
    (composer, voice note, draft, scheduled cast, room announcement).
    Feeds a future creator leaderboard.
    """

    __tablename__ = "cast_records"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    cast_hash: Mapped[str] = mapped_column(
        String(66), nullable=False, unique=True, index=True
    )
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "source IN ('composer', 'voice_note', 'draft', 'scheduled', "
            "'room_announcement')",
            name="ck_cast_records_source",
        ),
    )
