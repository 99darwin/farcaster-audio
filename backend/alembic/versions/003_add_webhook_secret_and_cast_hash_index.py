"""Add webhook secret column and cast_hash index

Revision ID: 003
Revises: 002
Create Date: 2026-03-25

This migration is a no-op. Both ``neynar_webhook_secret`` and the
``ix_rooms_cast_hash`` index were already added by migration 002. The
duplicate here was introduced by a merge mistake; making 003 a no-op
keeps the revision chain intact for environments that have already
stamped past it (production) while allowing fresh databases to migrate
through ``alembic upgrade head`` without a DuplicateColumnError.
"""

from alembic import op  # noqa: F401  (kept for documentation parity)
import sqlalchemy as sa  # noqa: F401

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
