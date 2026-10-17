"""Add Farcaster sync opt-in columns to users.

Adds three columns used by the Warpcast handshake (worker B1/B2/B3):

* ``farcaster_fid``           — the Warpcast FID the user opted in with.
* ``farcaster_sync_enabled``  — boolean flag, default false.
* ``farcaster_sync_linked_at``— UTC timestamp of the most recent link.

The bearer secret obtained via the Warpcast handshake stays in the
device Keychain — it is **never** transmitted to the backend or
stored in this table. These columns exist only to record opt-in
state for UX gating and analytics.

Revision ID: 022
Revises: 021
Create Date: 2026-05-30
"""

from alembic import op
import sqlalchemy as sa


revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("farcaster_fid", sa.Integer(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "farcaster_sync_enabled",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "farcaster_sync_linked_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_users_farcaster_fid",
        "users",
        ["farcaster_fid"],
    )


def downgrade() -> None:
    op.drop_index("ix_users_farcaster_fid", table_name="users")
    op.drop_column("users", "farcaster_sync_linked_at")
    op.drop_column("users", "farcaster_sync_enabled")
    op.drop_column("users", "farcaster_fid")
