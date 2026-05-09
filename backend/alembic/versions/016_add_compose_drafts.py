"""Add compose drafts

Revision ID: 016
Revises: 015
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "compose_drafts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("channel_id", sa.String(length=64), nullable=True),
        sa.Column("parent_cast_hash", sa.String(length=66), nullable=True),
        sa.Column(
            "parent_cast",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("quote_cast", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "media_embeds",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "voice_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "post_to_farcaster",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "parent_cast_hash IS NULL OR channel_id IS NULL",
            name="ck_compose_drafts_reply_no_channel",
        ),
        sa.ForeignKeyConstraint(["fid"], ["users.fid"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_compose_drafts_fid_updated",
        "compose_drafts",
        ["fid", "updated_at"],
        postgresql_ops={"updated_at": "DESC"},
    )


def downgrade() -> None:
    op.drop_index("idx_compose_drafts_fid_updated", table_name="compose_drafts")
    op.drop_table("compose_drafts")
