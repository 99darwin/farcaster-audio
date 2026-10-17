"""Add recognition leaderboard tables + user opt-out flag.

Status-only monthly leaderboard: ``leaderboard_scores`` (recomputed nightly)
and ``leaderboard_awards`` (written only at human-reviewed cycle close).

Revision ID: 031
Revises: 030
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None

_CATEGORY_CHECK = "category IN ('top_hosts', 'top_voices', 'top_casters', 'community')"


def upgrade() -> None:
    op.create_table(
        "leaderboard_scores",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("cycle", sa.String(length=7), nullable=False),
        sa.Column("category", sa.String(length=20), nullable=False),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("rank", sa.Integer(), nullable=True),
        sa.Column("breakdown", JSONB(), nullable=False, server_default="{}"),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "fid", "cycle", "category", name="uq_leaderboard_scores_fid_cycle_category"
        ),
        sa.CheckConstraint(_CATEGORY_CHECK, name="ck_leaderboard_scores_category"),
    )
    op.create_index("ix_leaderboard_scores_fid", "leaderboard_scores", ["fid"])
    op.create_index("ix_leaderboard_scores_cycle", "leaderboard_scores", ["cycle"])
    op.create_index(
        "ix_leaderboard_scores_cycle_category",
        "leaderboard_scores",
        ["cycle", "category"],
    )

    op.create_table(
        "leaderboard_awards",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("cycle", sa.String(length=7), nullable=False),
        sa.Column("category", sa.String(length=20), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "fid", "cycle", "category", name="uq_leaderboard_awards_fid_cycle_category"
        ),
        sa.CheckConstraint(_CATEGORY_CHECK, name="ck_leaderboard_awards_category"),
    )
    op.create_index("ix_leaderboard_awards_fid", "leaderboard_awards", ["fid"])
    op.create_index("ix_leaderboard_awards_cycle", "leaderboard_awards", ["cycle"])

    op.add_column(
        "users",
        sa.Column(
            "leaderboard_opt_out",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "leaderboard_opt_out")
    op.drop_index("ix_leaderboard_awards_cycle", table_name="leaderboard_awards")
    op.drop_index("ix_leaderboard_awards_fid", table_name="leaderboard_awards")
    op.drop_table("leaderboard_awards")
    op.drop_index(
        "ix_leaderboard_scores_cycle_category", table_name="leaderboard_scores"
    )
    op.drop_index("ix_leaderboard_scores_cycle", table_name="leaderboard_scores")
    op.drop_index("ix_leaderboard_scores_fid", table_name="leaderboard_scores")
    op.drop_table("leaderboard_scores")
