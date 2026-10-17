"""Drop per-room Neynar webhook columns.

Room replies now arrive through one global Hypersnap webhook whose
``parent_hashes`` filter is synced from live rooms' ``cast_hash`` values, so
rooms no longer own a webhook id or signing secret.

Revision ID: 033
Revises: 032_trust_score_source
Create Date: 2026-10-16
"""

from alembic import op
import sqlalchemy as sa

revision = "033"
down_revision = "032_trust_score_source"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("rooms", "neynar_webhook_secret")
    op.drop_column("rooms", "neynar_webhook_id")


def downgrade() -> None:
    op.add_column("rooms", sa.Column("neynar_webhook_id", sa.String(64), nullable=True))
    op.add_column(
        "rooms", sa.Column("neynar_webhook_secret", sa.String(256), nullable=True)
    )
