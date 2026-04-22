"""Add parent_cast_hash to voice_notes

Revision ID: 014
Revises: 013
Create Date: 2026-04-17
"""

from alembic import op
import sqlalchemy as sa

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "voice_notes",
        sa.Column("parent_cast_hash", sa.String(66), nullable=True),
    )
    op.create_index(
        "idx_voice_notes_parent_cast_hash",
        "voice_notes",
        ["parent_cast_hash"],
        postgresql_where=sa.text("parent_cast_hash IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_voice_notes_parent_cast_hash", table_name="voice_notes")
    op.drop_column("voice_notes", "parent_cast_hash")
