"""Add durable scheduled Farcaster casts.

Revision ID: 028
Revises: 027
Create Date: 2026-07-09
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scheduled_casts",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "fid",
            sa.BigInteger(),
            sa.ForeignKey("users.fid", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("parent", sa.String(length=66), nullable=True),
        sa.Column(
            "embeds", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column("quote_fid", sa.BigInteger(), nullable=True),
        sa.Column("quote_hash", sa.String(length=66), nullable=True),
        sa.Column("channel_id", sa.String(length=64), nullable=True),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="pending"
        ),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "idempotency_key",
            UUID(as_uuid=True),
            nullable=False,
            unique=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("published_hash", sa.String(length=66), nullable=True),
        sa.Column("last_error", sa.String(length=256), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'processing', 'retrying', 'published', "
            "'failed', 'cancelled')",
            name="ck_scheduled_casts_status",
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_scheduled_casts_attempts"),
        sa.CheckConstraint(
            "parent IS NULL OR channel_id IS NULL",
            name="ck_scheduled_casts_reply_no_channel",
        ),
        sa.CheckConstraint(
            "(quote_fid IS NULL) = (quote_hash IS NULL)",
            name="ck_scheduled_casts_quote_complete",
        ),
        sa.CheckConstraint(
            "(status = 'processing') = (lease_expires_at IS NOT NULL)",
            name="ck_scheduled_casts_processing_lease",
        ),
    )
    op.create_index(
        "ix_scheduled_casts_due",
        "scheduled_casts",
        ["next_attempt_at", "id"],
        postgresql_where=sa.text("status IN ('pending', 'retrying')"),
    )
    op.create_index(
        "ix_scheduled_casts_stale_lease",
        "scheduled_casts",
        ["lease_expires_at", "id"],
        postgresql_where=sa.text("status = 'processing'"),
    )
    op.create_index(
        "ix_scheduled_casts_fid_active_scheduled",
        "scheduled_casts",
        ["fid", "scheduled_for", "id"],
        postgresql_where=sa.text(
            "status IN ('pending', 'processing', 'retrying')"
        ),
    )
    op.create_index(
        "ix_scheduled_casts_fid_created",
        "scheduled_casts",
        ["fid", "created_at", "id"],
        postgresql_ops={"created_at": "DESC"},
    )


def downgrade() -> None:
    op.drop_index(
        "ix_scheduled_casts_fid_created", table_name="scheduled_casts"
    )
    op.drop_index(
        "ix_scheduled_casts_fid_active_scheduled", table_name="scheduled_casts"
    )
    op.drop_index("ix_scheduled_casts_stale_lease", table_name="scheduled_casts")
    op.drop_index("ix_scheduled_casts_due", table_name="scheduled_casts")
    op.drop_table("scheduled_casts")
