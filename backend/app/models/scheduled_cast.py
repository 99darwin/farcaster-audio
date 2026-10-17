import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text as sql_text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ScheduledCast(Base):
    """A durable, user-owned Farcaster cast waiting to be published."""

    __tablename__ = "scheduled_casts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    fid: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.fid", ondelete="CASCADE"),
        nullable=False,
    )
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    parent: Mapped[str | None] = mapped_column(String(66), nullable=True)
    embeds: Mapped[list[str]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=False, default=list
    )
    quote_fid: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    quote_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    channel_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    scheduled_for: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # A per-claim lease makes a crashed worker's job recoverable. The claim's
    # timestamp is also used as a compare-and-set token when recording results.
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    idempotency_key: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, unique=True, default=uuid.uuid4
    )

    published_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'processing', 'retrying', 'published', "
            "'failed', 'cancelled')",
            name="ck_scheduled_casts_status",
        ),
        CheckConstraint("attempts >= 0", name="ck_scheduled_casts_attempts"),
        CheckConstraint(
            "parent IS NULL OR channel_id IS NULL",
            name="ck_scheduled_casts_reply_no_channel",
        ),
        CheckConstraint(
            "(quote_fid IS NULL) = (quote_hash IS NULL)",
            name="ck_scheduled_casts_quote_complete",
        ),
        CheckConstraint(
            "(status = 'processing') = (lease_expires_at IS NOT NULL)",
            name="ck_scheduled_casts_processing_lease",
        ),
        Index(
            "ix_scheduled_casts_due",
            "next_attempt_at",
            "id",
            postgresql_where=sql_text("status IN ('pending', 'retrying')"),
        ),
        Index(
            "ix_scheduled_casts_stale_lease",
            "lease_expires_at",
            "id",
            postgresql_where=sql_text("status = 'processing'"),
        ),
        Index(
            "ix_scheduled_casts_fid_active_scheduled",
            "fid",
            "scheduled_for",
            "id",
            postgresql_where=sql_text(
                "status IN ('pending', 'processing', 'retrying')"
            ),
        ),
        Index(
            "ix_scheduled_casts_fid_created",
            "fid",
            "created_at",
            "id",
            postgresql_ops={"created_at": "DESC"},
        ),
    )
