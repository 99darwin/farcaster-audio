"""Add trust_scores table for spam filtering

Stores per-FID trust signals (Neynar score, Quotient score, Warpcast label)
and a composite score used to flag spam accounts.

Revision ID: 011
Revises: 010
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "trust_scores",
        sa.Column("fid", sa.BigInteger(), primary_key=True),
        sa.Column("neynar_score", sa.Float(), nullable=True),
        sa.Column("quotient_score", sa.Float(), nullable=True),
        sa.Column("warpcast_label", sa.SmallInteger(), nullable=True),
        sa.Column("composite", sa.Float(), nullable=False),
        sa.Column("is_spam", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_trust_scores_is_spam",
        "trust_scores",
        ["is_spam"],
        postgresql_where=sa.text("is_spam = true"),
    )


def downgrade() -> None:
    op.drop_index("ix_trust_scores_is_spam", table_name="trust_scores")
    op.drop_table("trust_scores")
