from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

SIGNER_STATUS_NONE = "none"
SIGNER_STATUS_PENDING = "pending"
SIGNER_STATUS_APPROVED = "approved"
SIGNER_STATUS_REVOKED = "revoked"
SIGNER_STATUS_DEMO = "demo"
USER_SIGNER_STATUSES = (
    SIGNER_STATUS_NONE,
    SIGNER_STATUS_PENDING,
    SIGNER_STATUS_APPROVED,
    SIGNER_STATUS_REVOKED,
    SIGNER_STATUS_DEMO,
)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    fid: Mapped[int] = mapped_column(
        BigInteger, unique=True, nullable=False, index=True
    )
    # Legacy Neynar managed-signer UUID or sentinel. Nullable since the
    # Hypersnap cutover and dropped in a follow-up; use ``signer_status``
    # and ``user_signer_service.get_user_signer`` instead.
    signer_uuid: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Write capability: ``approved`` once an on-chain app signer exists
    # (``user_signers``); ``demo`` for the shared demo login; otherwise
    # ``none`` / ``pending`` / ``revoked`` and the session is read-only.
    signer_status: Mapped[str] = mapped_column(
        String(16),
        default=SIGNER_STATUS_NONE,
        server_default=SIGNER_STATUS_NONE,
        nullable=False,
    )
    username: Mapped[str | None] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(256))
    pfp_url: Mapped[str | None] = mapped_column(Text)
    custody_address: Mapped[str | None] = mapped_column(String(42))
    is_admin: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    is_agent: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    developer_access_status: Mapped[str] = mapped_column(
        String(20), default="none", server_default="none", nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    # Farcaster Warpcast handshake / sync opt-in. The bearer secret itself
    # stays in the user's iOS Keychain and never crosses the wire — these
    # columns only record that the user opted in plus the linked fid so the
    # backend can gate UX, analytics, and future cross-cutting features.
    #
    # SECURITY: ``farcaster_fid`` is SELF-ATTESTED by the client. The bearer
    # never reaches the backend, so the server cannot verify that the
    # posting user actually controls this Warpcast FID. Do NOT use this
    # field to attest identity, gate sensitive features, or render
    # trust-conveying UI (badges, "verified" indicators) without an
    # additional verification step (e.g. a Warpcast-signed challenge).
    farcaster_fid: Mapped[int | None] = mapped_column(
        Integer, nullable=True, index=True
    )
    farcaster_sync_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    farcaster_sync_linked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Recognition leaderboard opt-out. When true the user is excluded from all
    # leaderboard scoring and never appears on any public board. Honored at both
    # compute time and read time so an opt-out takes effect immediately.
    leaderboard_opt_out: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "developer_access_status IN ('none', 'pending', 'approved', 'suspended')",
            name="ck_users_developer_access_status",
        ),
        CheckConstraint(
            "signer_status IN ('none', 'pending', 'approved', 'revoked', 'demo')",
            name="ck_users_signer_status",
        ),
    )
