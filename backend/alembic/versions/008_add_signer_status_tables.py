"""Add snap_signers and auth_addresses tables

Local source-of-truth for Farcaster signer + auth address status to
eliminate steady-state polling against Neynar's "active signers" API.

Revision ID: 008
Revises: 007
Create Date: 2026-04-09
"""

from alembic import op
import sqlalchemy as sa

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "snap_signers",
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("approval_url", sa.Text(), nullable=True),
        sa.Column(
            "registered_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "last_checked_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("public_key"),
    )
    op.create_index("ix_snap_signers_fid", "snap_signers", ["fid"])

    op.create_table(
        "auth_addresses",
        sa.Column("address", sa.Text(), nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("approval_url", sa.Text(), nullable=True),
        sa.Column(
            "registered_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "last_checked_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("address"),
    )
    op.create_index("ix_auth_addresses_fid", "auth_addresses", ["fid"])


def downgrade() -> None:
    op.drop_index("ix_auth_addresses_fid", table_name="auth_addresses")
    op.drop_table("auth_addresses")
    op.drop_index("ix_snap_signers_fid", table_name="snap_signers")
    op.drop_table("snap_signers")
