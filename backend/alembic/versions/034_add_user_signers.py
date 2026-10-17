"""Hypersnap signers: user_signers table, users.signer_status.

* ``user_signers`` holds each user's Juke-held Ed25519 app signer (encrypted
  private key) added on-chain with ``KeyGateway.addFor``.
* ``auth_addresses.add_tx_hash`` records the ``addFor`` tx of an auth
  address.
* ``users.signer_status`` replaces the ``signer_uuid`` sentinels
  (``demo-readonly``, ``siwf-auth``, ``miniapp-quickauth``) as the write
  capability flag; ``users.signer_uuid`` becomes nullable.

Existing Neynar managed-signer users are backfilled as ``none``: their
signer UUIDs are useless once Neynar is gone, so they re-link via
``/v1/auth/signer/prepare`` + ``/register``.

Revision ID: 034
Revises: 033
Create Date: 2026-10-16
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "034"
down_revision = "033"
branch_labels = None
depends_on = None

_USER_SIGNER_STATUS_CHECK = (
    "status IN ('pending', 'submitted', 'confirming', 'approved', "
    "'failed', 'revoked')"
)
_USERS_SIGNER_STATUS_CHECK = (
    "signer_status IN ('none', 'pending', 'approved', 'revoked', 'demo')"
)


def upgrade() -> None:
    op.create_table(
        "user_signers",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("public_key", sa.String(length=66), nullable=False),
        sa.Column("encrypted_private_key", sa.Text(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="pending"
        ),
        sa.Column("add_tx_hash", sa.String(length=66), nullable=True),
        sa.Column("auth_address", sa.String(length=42), nullable=True),
        sa.Column("auth_address_tx_hash", sa.String(length=66), nullable=True),
        sa.Column("login_issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("public_key", name="uq_user_signers_public_key"),
        sa.CheckConstraint(_USER_SIGNER_STATUS_CHECK, name="ck_user_signers_status"),
    )
    op.create_index("ix_user_signers_fid", "user_signers", ["fid"])
    op.create_index("ix_user_signers_fid_status", "user_signers", ["fid", "status"])

    op.add_column(
        "auth_addresses",
        sa.Column("add_tx_hash", sa.String(length=66), nullable=True),
    )

    op.add_column(
        "users",
        sa.Column(
            "signer_status",
            sa.String(length=16),
            nullable=False,
            server_default="none",
        ),
    )
    op.execute(
        "UPDATE users SET signer_status = 'demo' WHERE signer_uuid = 'demo-readonly'"
    )
    op.create_check_constraint(
        "ck_users_signer_status", "users", _USERS_SIGNER_STATUS_CHECK
    )
    op.alter_column(
        "users",
        "signer_uuid",
        existing_type=sa.String(length=128),
        nullable=True,
    )


def downgrade() -> None:
    op.execute(
        "UPDATE users SET signer_uuid = CASE "
        "WHEN signer_status = 'demo' THEN 'demo-readonly' "
        "ELSE 'siwf-auth' END "
        "WHERE signer_uuid IS NULL"
    )
    op.alter_column(
        "users",
        "signer_uuid",
        existing_type=sa.String(length=128),
        nullable=False,
    )
    op.drop_constraint("ck_users_signer_status", "users", type_="check")
    op.drop_column("users", "signer_status")
    op.drop_column("auth_addresses", "add_tx_hash")
    op.drop_index("ix_user_signers_fid_status", table_name="user_signers")
    op.drop_index("ix_user_signers_fid", table_name="user_signers")
    op.drop_table("user_signers")
