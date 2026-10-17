"""Extend ``developer_app_bots`` with managed Ed25519 signer columns.

Phase-4 part 2 — self-serve Farcaster-native bot signers.

Legacy bots authenticate with a custody EOA key resolved from
``custody_key_ref`` (env-held secret) — impossible for external
partners since the key must live in Juke's own environment. This
migration adds a *managed-signer* path: Juke generates an Ed25519 app
key per bot, stores the private key AES-256-GCM-encrypted, registers
it with Neynar, and the bot FID owner approves it once via Warpcast.
After that, pure API-key calls mint JFS bearers server-side.

Changes:
* ``custody_address`` / ``custody_key_ref`` become nullable — the
  managed-signer path has no custody EOA.
* ``auth_mode`` (server_default ``custody_env``) keeps every existing
  row on the legacy path with no data backfill.
* ``signer_*`` columns hold the managed key material + approval
  lifecycle. ``signer_public_key`` gets a partial unique index (only
  where set) so legacy NULL rows don't collide.

Revision ID: 027
Revises: 026
Create Date: 2026-07-06
"""

from alembic import op
import sqlalchemy as sa

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Custody fields no longer required — managed-signer bots have none.
    op.alter_column(
        "developer_app_bots",
        "custody_address",
        existing_type=sa.String(length=42),
        nullable=True,
    )
    op.alter_column(
        "developer_app_bots",
        "custody_key_ref",
        existing_type=sa.String(length=256),
        nullable=True,
    )

    op.add_column(
        "developer_app_bots",
        sa.Column(
            "auth_mode",
            sa.String(length=16),
            server_default="custody_env",
            nullable=False,
        ),
    )
    op.add_column(
        "developer_app_bots",
        sa.Column("signer_public_key", sa.Text(), nullable=True),
    )
    op.add_column(
        "developer_app_bots",
        sa.Column("signer_private_key_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "developer_app_bots",
        sa.Column("signer_status", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "developer_app_bots",
        sa.Column("signer_approval_url", sa.Text(), nullable=True),
    )
    op.add_column(
        "developer_app_bots",
        sa.Column("signer_registered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "developer_app_bots",
        sa.Column("signer_approved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "developer_app_bots",
        sa.Column("signer_last_checked_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Partial unique index: managed-signer public keys are globally unique
    # to one bot row, but the WHERE clause exempts the legacy NULL rows.
    op.create_index(
        "ix_developer_app_bots_signer_public_key",
        "developer_app_bots",
        ["signer_public_key"],
        unique=True,
        postgresql_where=sa.text("signer_public_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_developer_app_bots_signer_public_key",
        table_name="developer_app_bots",
    )
    op.drop_column("developer_app_bots", "signer_last_checked_at")
    op.drop_column("developer_app_bots", "signer_approved_at")
    op.drop_column("developer_app_bots", "signer_registered_at")
    op.drop_column("developer_app_bots", "signer_approval_url")
    op.drop_column("developer_app_bots", "signer_status")
    op.drop_column("developer_app_bots", "signer_private_key_encrypted")
    op.drop_column("developer_app_bots", "signer_public_key")
    op.drop_column("developer_app_bots", "auth_mode")

    # Restore NOT NULL on the custody columns. Managed-signer rows created
    # under revision 027 would have NULLs here; the downgrade cannot
    # invent custody keys for them, so any such rows must be removed before
    # downgrading. We do NOT delete data implicitly — the alter will fail
    # loudly if NULLs remain, which is the correct signal to an operator.
    op.alter_column(
        "developer_app_bots",
        "custody_key_ref",
        existing_type=sa.String(length=256),
        nullable=False,
    )
    op.alter_column(
        "developer_app_bots",
        "custody_address",
        existing_type=sa.String(length=42),
        nullable=False,
    )
