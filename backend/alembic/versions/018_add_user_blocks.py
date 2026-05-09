"""Add user_blocks table

Revision ID: 018
Revises: 017
Create Date: 2026-05-09
"""

from alembic import op
import sqlalchemy as sa


revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_blocks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("blocker_fid", sa.BigInteger(), nullable=False),
        sa.Column("blocked_fid", sa.BigInteger(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["blocker_fid"], ["users.fid"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("blocker_fid", "blocked_fid", name="uq_user_blocks_pair"),
    )
    op.create_index(
        "ix_user_blocks_blocker_fid", "user_blocks", ["blocker_fid"]
    )
    op.create_index(
        "ix_user_blocks_blocked_fid", "user_blocks", ["blocked_fid"]
    )


def downgrade() -> None:
    op.drop_index("ix_user_blocks_blocked_fid", table_name="user_blocks")
    op.drop_index("ix_user_blocks_blocker_fid", table_name="user_blocks")
    op.drop_table("user_blocks")
