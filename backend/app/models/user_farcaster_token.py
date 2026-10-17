"""A user's custody-minted ``client.farcaster.xyz`` bearer for Direct Casts.

Direct Casts only accept the token from ``PUT /v2/onboarding-state``, which
needs a custody EIP-191 signature (``app_key`` JFS bearers get 401). At
recovery-phrase import (or the "Enable messages" flow) the device signs one
``generateToken`` request; the backend exchanges it and stores only the
resulting token here, never the signature or the phrase.

``encrypted_token`` is a ``signer_crypto`` v1 blob
(``SignerPurpose.FARCASTER_TOKEN``, AAD ``fid:<fid>``) of the JSON
``{"secret": ..., "expires_at_ms": ...}``. ``expires_at`` duplicates the
expiry in the clear so status checks never decrypt. One row per FID; there
is deliberately no FK to ``users`` because the row can be written during
signer registration, before the ``users`` row exists (as ``user_signers``).
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserFarcasterToken(Base):
    __tablename__ = "user_farcaster_tokens"

    fid: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Never logged or returned by any endpoint.
    encrypted_token: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
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
