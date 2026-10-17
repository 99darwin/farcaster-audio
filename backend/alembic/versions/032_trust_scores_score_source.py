"""Rename trust_scores.neynar_score -> score and add score source.

Hypersnap has no ``neynar_user_score``; trust is now scored locally. Existing
Neynar scores are preserved in ``score`` and tagged ``source = 'neynar'``.

Revision ID: 032_trust_score_source
Revises: 031
Create Date: 2026-10-16
"""

from alembic import op
import sqlalchemy as sa

revision = "032_trust_score_source"
down_revision = "031"
branch_labels = None
depends_on = None

LEGACY_SOURCE = "neynar"


def upgrade() -> None:
    op.alter_column("trust_scores", "neynar_score", new_column_name="score")
    op.add_column("trust_scores", sa.Column("source", sa.String(32), nullable=True))
    op.execute(
        sa.text(
            "UPDATE trust_scores SET source = :source WHERE score IS NOT NULL"
        ).bindparams(source=LEGACY_SOURCE)
    )


def downgrade() -> None:
    # Only Neynar-sourced scores are meaningful as neynar_score; drop the rest.
    op.execute(
        sa.text(
            "UPDATE trust_scores SET score = NULL "
            "WHERE source IS DISTINCT FROM :source"
        ).bindparams(source=LEGACY_SOURCE)
    )
    op.drop_column("trust_scores", "source")
    op.alter_column("trust_scores", "score", new_column_name="neynar_score")
