import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ComposeDraft(Base):
    __tablename__ = "compose_drafts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="CASCADE"), nullable=False
    )
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    channel_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parent_cast_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    parent_cast: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    quote_cast: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    media_embeds: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    voice_metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    post_to_farcaster: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "parent_cast_hash IS NULL OR channel_id IS NULL",
            name="ck_compose_drafts_reply_no_channel",
        ),
        Index(
            "idx_compose_drafts_fid_updated",
            "fid",
            "updated_at",
            postgresql_ops={"updated_at": "DESC"},
        ),
    )
