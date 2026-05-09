from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CastBookmark(Base):
    __tablename__ = "cast_bookmarks"

    fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="CASCADE"), primary_key=True
    )
    cast_hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index(
            "idx_cast_bookmarks_fid_created",
            "fid",
            "created_at",
            postgresql_ops={"created_at": "DESC"},
        ),
    )
