"""Local source-of-truth for Farcaster auth addresses (secp256k1).

Mirrors `snap_signers`, but keyed by the 0x-prefixed Ethereum address
used as a Farcaster auth address. Same lifecycle: pending -> approved
(one-way) or pending -> revoked.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AuthAddress(Base):
    __tablename__ = "auth_addresses"

    address: Mapped[str] = mapped_column(Text, primary_key=True)
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    approval_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    registered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
