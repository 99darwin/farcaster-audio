"""Add cast_bookmarks table

Revision ID: 017
Revises: 016
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa


revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cast_bookmarks",
        sa.Column(
            "fid",
            sa.BigInteger(),
            sa.ForeignKey("users.fid", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("cast_hash", sa.String(66), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("fid", "cast_hash"),
    )
    op.create_index(
        "idx_cast_bookmarks_fid_created",
        "cast_bookmarks",
        ["fid", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("idx_cast_bookmarks_fid_created", table_name="cast_bookmarks")
    op.drop_table("cast_bookmarks")
