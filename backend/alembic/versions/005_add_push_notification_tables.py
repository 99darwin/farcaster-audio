"""Add device_tokens and notification_preferences tables

Revision ID: 005
Revises: 004
Create Date: 2026-03-31
"""

from alembic import op
import sqlalchemy as sa

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_tokens",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("expo_push_token", sa.Text(), nullable=False),
        sa.Column("device_id", sa.String(256), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["fid"], ["users.fid"], ondelete="CASCADE"),
        sa.UniqueConstraint("fid", "expo_push_token", name="uq_device_tokens_fid_token"),
    )
    op.create_index("ix_device_tokens_fid", "device_tokens", ["fid"])
    op.create_index(
        "ix_device_tokens_fid_active",
        "device_tokens",
        ["fid"],
        postgresql_where=sa.text("is_active = true"),
    )

    op.create_table(
        "notification_preferences",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False, unique=True),
        # Farcaster social
        sa.Column("follows_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("likes_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("replies_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("recasts_enabled", sa.Boolean(), nullable=False, server_default="true"),
        # Space events
        sa.Column("space_started_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("space_invited_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("hand_raised_enabled", sa.Boolean(), nullable=False, server_default="true"),
        # Future
        sa.Column("miniapp_enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["fid"], ["users.fid"], ondelete="CASCADE"),
    )
    op.create_index("ix_notification_preferences_fid", "notification_preferences", ["fid"], unique=True)


def downgrade() -> None:
    op.drop_table("notification_preferences")
    op.drop_table("device_tokens")
