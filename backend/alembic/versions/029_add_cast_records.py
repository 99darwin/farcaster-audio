"""Add cast_records ledger for casts published via Juke.

Revision ID: 029
Revises: 028
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cast_records",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("cast_hash", sa.String(length=66), nullable=False),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "source IN ('composer', 'voice_note', 'draft', 'scheduled', "
            "'room_announcement')",
            name="ck_cast_records_source",
        ),
    )
    op.create_index("ix_cast_records_fid", "cast_records", ["fid"])
    op.create_index(
        "ix_cast_records_cast_hash", "cast_records", ["cast_hash"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_cast_records_cast_hash", table_name="cast_records")
    op.drop_index("ix_cast_records_fid", table_name="cast_records")
    op.drop_table("cast_records")
