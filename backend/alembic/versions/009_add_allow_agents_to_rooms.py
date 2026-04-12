"""Add allow_agents column to rooms

Hosts can opt out of agent participation per room.
Defaults to true (agents allowed).

Revision ID: 009
Revises: 008
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("allow_agents", sa.Boolean(), nullable=False, server_default="true"),
    )


def downgrade() -> None:
    op.drop_column("rooms", "allow_agents")
