"""Add webhook secret column and cast_hash index

Revision ID: 003
Revises: 002
Create Date: 2026-03-25
"""

from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rooms", sa.Column("neynar_webhook_secret", sa.String(256), nullable=True))
    op.create_index("ix_rooms_cast_hash", "rooms", ["cast_hash"])


def downgrade() -> None:
    op.drop_index("ix_rooms_cast_hash", table_name="rooms")
    op.drop_column("rooms", "neynar_webhook_secret")
