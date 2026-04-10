"""Local source-of-truth for Farcaster snap (Ed25519) signers.

This table replaces steady-state polling of Neynar for signer status.
Approval is a one-way door, so once we observe `approved` we never need
to ask Neynar again. `last_checked_at` bounds the lazy reconcile window
for pending rows.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class SnapSigner(Base):
    __tablename__ = "snap_signers"

    public_key: Mapped[str] = mapped_column(Text, primary_key=True)
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
