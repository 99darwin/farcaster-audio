import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class DeveloperWebhook(Base):
    __tablename__ = "developer_webhooks"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developer_apps.id", ondelete="CASCADE"),
        nullable=False,
    )
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    # HMAC-SHA256 signing secret. Returned to the developer once at creation
    # and used by us to sign every outbound delivery, so it must remain
    # decryptable server-side. Stored AES-GCM encrypted
    # (``signer_crypto`` purpose ``developer_webhook_secret``, AAD = ``id``);
    # rows created before migration 039 hold plaintext ``whsec_…`` until the
    # startup backfill re-encrypts them. Rotate by deleting + re-creating.
    # Read it only via ``dev_webhook_service.decrypt_secret``.
    secret: Mapped[str] = mapped_column(Text, nullable=False)
    events: Mapped[list[str]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        server_default="[]",
    )
    last_delivery_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Coarsened category string (e.g. ``http_5xx``, ``timeout``,
    # ``blocked_ip``) — never an exception trace or response body, to keep
    # this field from becoming an internal-network reconnaissance oracle.
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Resets to 0 on any successful delivery. Crossing
    # ``MAX_CONSECUTIVE_FAILURES`` flips ``disabled_at`` and stops further
    # dispatch attempts until the developer recreates the subscription.
    consecutive_failures: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0", default=0
    )
    disabled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_developer_webhooks_app_id", "app_id"),
        UniqueConstraint("app_id", "url", name="uq_developer_webhooks_app_url"),
    )
