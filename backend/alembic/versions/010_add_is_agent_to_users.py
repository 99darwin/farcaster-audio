"""Add is_agent column to users

Distinguishes temporary agent User records from real human users.
Defaults to false.

Revision ID: 010
Revises: 009
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_agent", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("users", "is_agent")
