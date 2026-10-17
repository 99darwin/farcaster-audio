"""Per-developer-app bot FID registry.

Phase-4 part 2 — Farcaster-native developer surface. A developer app
may own one or more Farcaster identities (bots) used for:

* Creating Farcaster-native dev spaces with the bot as upstream host.
* Joining existing native spaces as an agent (TTS, transcription,
  recaps, etc.).

The bot's custody EOA private key is NEVER persisted in this row.
``custody_key_ref`` is an opaque reference that the service layer
resolves at bearer-mint time. For Phase-4 scaffolding we support the
``env:<ENV_VAR_NAME>`` form — the service reads the actual hex key
from ``os.environ[ENV_VAR_NAME]``. In production this should be
upgraded to a KMS / vault path (``kms:<key-id>``, ``vault:<path>``)
without schema changes — the resolver dispatches on the scheme
prefix.

``custody_address`` is stored only for human-readable display in the
developer dashboard ("which on-chain identity is this?"). It is never
used for signing or auth.

The registry is **per-app** — there is no shared pool across apps the
way ``JUKE_RECORDING_AGENT_FIDS`` is. Two different developer apps
may register the same FID (it would be a misconfiguration, but the
schema does not prevent it because FIDs aren't globally scarce
relative to apps). A unique constraint guards against the same app
double-registering the same FID.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class DeveloperAppBot(Base):
    __tablename__ = "developer_app_bots"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developer_apps.id", ondelete="CASCADE"),
        nullable=False,
    )
    # The Farcaster ID this bot identity is registered under. The
    # backend never verifies that the registering app actually controls
    # this FID — that ownership claim is the developer's responsibility.
    # The router does enforce ``app_id`` ownership on every mutation so
    # an attacker can't register a FID under someone else's app.
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # EVM checksummed 0x-address of the bot's custody EOA. Display-only;
    # never used as a signing input. We keep this denormalized from the
    # ``custody_key_ref`` resolution path so the developer dashboard can
    # render the address without resolving the key reference itself.
    #
    # Nullable since the managed-signer (``auth_mode="app_key"``) flow has
    # no custody EOA — Juke holds an Ed25519 app key instead.
    custody_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    # Opaque reference to the actual custody private key. NEVER the raw
    # key. Phase-4 scaffolding supports ``env:<ENV_VAR_NAME>`` —
    # resolved at mint time by the service layer. Production should
    # dispatch on prefix (``kms:``, ``vault:``, etc.).
    #
    # Nullable: only the legacy ``custody_env`` mode uses this; the
    # managed-signer mode leaves it unset.
    custody_key_ref: Mapped[str | None] = mapped_column(String(256), nullable=True)
    label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # How this bot mints Farcaster JFS bearers:
    #   ``custody_env`` — legacy: resolve ``custody_key_ref`` to a custody
    #     EOA private key from env at mint time (self-hosted secret).
    #   ``app_key`` — managed: Juke generated an Ed25519 app key, stores
    #     the private key AES-256-GCM-encrypted (``signer_private_key_encrypted``)
    #     and mints JFS bearers directly. Requires one-time Warpcast
    #     approval by the bot's FID.
    # ``server_default="custody_env"`` keeps every pre-existing row on the
    # legacy path with no data migration.
    auth_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="custody_env"
    )
    # 0x-prefixed 32-byte Ed25519 public key of the managed signer.
    # Unique where set (partial index) — a public key belongs to exactly
    # one bot row. NULL for legacy custody bots.
    signer_public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    # AES-256-GCM-encrypted Ed25519 private key blob (nonce||ciphertext,
    # base64url). AAD is bound to this row's id so a blob cannot be
    # transplanted onto another bot. NEVER logged, NEVER returned.
    signer_private_key_encrypted: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    # Lifecycle of the managed signer's Warpcast approval:
    #   ``pending_approval`` — registered with Neynar, awaiting the bot
    #     FID owner's one-time approval.
    #   ``approved`` — usable for minting bearers.
    #   ``revoked`` — on-chain removed; terminal, re-register to recover.
    #   ``fid_mismatch`` — Neynar reports the key approved under a FID that
    #     is NOT this bot's fid; refuse to mint (guards against approving
    #     the key with the wrong account).
    signer_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Warpcast deep link the developer presents to the bot FID owner to
    # approve the signer. Nulled once terminal (approved/revoked).
    signer_approval_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    signer_registered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    signer_approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    signer_last_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Soft-delete: ``is_active=False`` rows stay in the table for
    # audit but cannot be used to mint bearers or create rooms. The
    # service-layer check (``DeveloperAppBot.is_active.is_(True)``)
    # mirrors the router-level guard for defense-in-depth.
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Per-app uniqueness: an app cannot double-register the same
        # FID. Different apps registering the same FID is allowed
        # (the constraint is not globally unique on ``fid``).
        UniqueConstraint("app_id", "fid", name="uq_developer_app_bots_app_fid"),
        Index("ix_developer_app_bots_app_id", "app_id"),
        Index("ix_developer_app_bots_app_active", "app_id", "is_active"),
        # Partial unique index: a managed-signer public key maps to exactly
        # one bot row. Partial (WHERE NOT NULL) so the many legacy
        # custody-mode rows with NULL signer_public_key don't collide.
        Index(
            "ix_developer_app_bots_signer_public_key",
            "signer_public_key",
            unique=True,
            postgresql_where=text("signer_public_key IS NOT NULL"),
        ),
    )
