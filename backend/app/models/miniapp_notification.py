from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MiniAppNotification(Base):
    """Stores Farcaster miniapp notification tokens per user.

    When a user adds the Juke miniapp and enables notifications in Warpcast/Base,
    Farcaster POSTs a notification token + URL we can use to send them push
    notifications via the Farcaster client.
    """

    __tablename__ = "miniapp_notifications"
    __table_args__ = (
        UniqueConstraint("fid", name="uq_miniapp_notifications_fid"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    notification_url: Mapped[str] = mapped_column(Text, nullable=False)
    notification_token: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
