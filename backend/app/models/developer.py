import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class DeveloperApp(Base):
    __tablename__ = "developer_apps"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    owner_fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    website_url: Mapped[str | None] = mapped_column(String(500))
    allowed_origins: Mapped[list[str]] = mapped_column(
        JSON, default=list, nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(20), default="active", server_default="active", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'suspended', 'deleted')",
            name="ck_developer_apps_status",
        ),
        Index("ix_developer_apps_owner_fid", "owner_fid"),
        Index("ix_developer_apps_owner_status", "owner_fid", "status"),
    )


class DeveloperApplication(Base):
    __tablename__ = "developer_applications"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="CASCADE"), nullable=False
    )
    project_name: Mapped[str] = mapped_column(String(120), nullable=False)
    website_url: Mapped[str | None] = mapped_column(String(500))
    use_case: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), default="pending", server_default="pending", nullable=False
    )
    reviewed_by_fid: Mapped[int | None] = mapped_column(BigInteger)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'suspended')",
            name="ck_developer_applications_status",
        ),
        Index("ix_developer_applications_fid", "fid"),
        Index("ix_developer_applications_status", "status"),
    )


class DeveloperApiKey(Base):
    __tablename__ = "developer_api_keys"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developer_apps.id", ondelete="CASCADE"),
        nullable=False,
    )
    key_id: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    public_key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    secret_key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    encrypted_secret_once: Mapped[str | None] = mapped_column(Text)
    reveal_token_hash: Mapped[str | None] = mapped_column(String(64))
    reveal_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rotated_from_key_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("public_key_hash", name="uq_developer_api_keys_public_hash"),
        UniqueConstraint("secret_key_hash", name="uq_developer_api_keys_secret_hash"),
        Index("ix_developer_api_keys_app_id", "app_id"),
        Index("ix_developer_api_keys_key_id", "key_id"),
    )
