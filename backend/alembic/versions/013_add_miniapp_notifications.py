"""Add miniapp_notifications table for Farcaster miniapp push tokens

Revision ID: 013
Revises: 012
Create Date: 2026-04-13
"""

from alembic import op
import sqlalchemy as sa

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "miniapp_notifications",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("notification_url", sa.Text(), nullable=False),
        sa.Column("notification_token", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("fid", name="uq_miniapp_notifications_fid"),
    )
    op.create_index("ix_miniapp_notifications_fid", "miniapp_notifications", ["fid"])


def downgrade() -> None:
    op.drop_index("ix_miniapp_notifications_fid")
    op.drop_table("miniapp_notifications")
