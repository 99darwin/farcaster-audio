"""Add room_rsvps table

Revision ID: 007
Revises: 006
Create Date: 2026-04-01
"""

from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "room_rsvps",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.Uuid(), nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["fid"], ["users.fid"]),
        sa.UniqueConstraint("room_id", "fid", name="uq_room_rsvps_room_fid"),
    )
    op.create_index("ix_room_rsvps_room_id", "room_rsvps", ["room_id"])


def downgrade() -> None:
    op.drop_table("room_rsvps")
