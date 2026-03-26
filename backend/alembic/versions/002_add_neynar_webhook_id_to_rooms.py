"""Add neynar webhook fields to rooms

Revision ID: 002
Revises: 001
Create Date: 2026-03-25
"""

from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rooms", sa.Column("neynar_webhook_id", sa.String(64), nullable=True))
    op.add_column("rooms", sa.Column("neynar_webhook_secret", sa.String(256), nullable=True))
    op.create_index("ix_rooms_cast_hash", "rooms", ["cast_hash"])


def downgrade() -> None:
    op.drop_index("ix_rooms_cast_hash", table_name="rooms")
    op.drop_column("rooms", "neynar_webhook_secret")
    op.drop_column("rooms", "neynar_webhook_id")
