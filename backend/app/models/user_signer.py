"""A user's Juke-held Ed25519 app signer, added on-chain via ``addFor``.

The private key is stored only as an AES-GCM blob from
``signer_crypto.encrypt_private_key`` (``SignerPurpose.USER``, AAD bound to
the row id). Lifecycle::

    pending -> submitted -> confirming -> approved -> revoked
          \\-> failed

The row id is the ``prepare_id`` of ``/v1/auth/signer/*``.
``pending``: keypair generated, ``addFor`` not yet sent. ``submitted``:
the signer and device auth address adds are being relayed. ``confirming``:
both mined, the signer is not yet listed by Hypersnap. ``approved``:
Hypersnap lists the key. ``failed``: a relay step failed
(``failure_reason``). ``revoked``: removed on-chain or superseded.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

USER_SIGNER_PENDING = "pending"
USER_SIGNER_SUBMITTED = "submitted"
USER_SIGNER_CONFIRMING = "confirming"
USER_SIGNER_APPROVED = "approved"
USER_SIGNER_FAILED = "failed"
USER_SIGNER_REVOKED = "revoked"


class UserSigner(Base):
    __tablename__ = "user_signers"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'submitted', 'confirming', 'approved', "
            "'failed', 'revoked')",
            name="ck_user_signers_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    public_key: Mapped[str] = mapped_column(String(66), nullable=False, unique=True)
    # ``signer_crypto`` v1 blob; never logged or returned by any endpoint.
    encrypted_private_key: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=USER_SIGNER_PENDING
    )
    add_tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    # Device auth address (lowercase) added alongside the signer, and its tx.
    auth_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    auth_address_tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    # Legacy: set when ``GET /signer/status`` handed out a one-time login.
    # No longer written; kept to avoid a schema migration.
    login_issued_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Machine-readable reason for ``failed`` (never contains secrets).
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
