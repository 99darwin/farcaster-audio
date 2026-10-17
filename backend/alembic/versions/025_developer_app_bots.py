"""Add ``developer_app_bots`` registry.

Phase-4 part 2 — Farcaster-native developer surface.

Each row registers a Farcaster identity (a bot FID) the developer app
controls. The bot's actual custody EOA private key is NEVER stored
here; ``custody_key_ref`` is an opaque reference resolved at
bearer-mint time. Phase-4 scaffolding supports the
``env:<ENV_VAR_NAME>`` form for resolution; production should be
upgraded to KMS / vault refs without schema changes (the resolver
dispatches on the scheme prefix).

``custody_address`` is stored only for human-readable display in the
developer dashboard. It is never used for signing or auth.

Uniqueness is per-app (``app_id``, ``fid``). A single FID may appear
under multiple apps (the schema does not assume FIDs are globally
exclusive to one developer app).

Revision ID: 025
Revises: 024
Create Date: 2026-05-30
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "025"
down_revision = "024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "developer_app_bots",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("app_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("custody_address", sa.String(length=42), nullable=False),
        sa.Column("custody_key_ref", sa.String(length=256), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["app_id"], ["developer_apps.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("app_id", "fid", name="uq_developer_app_bots_app_fid"),
    )
    op.create_index("ix_developer_app_bots_app_id", "developer_app_bots", ["app_id"])
    op.create_index(
        "ix_developer_app_bots_app_active",
        "developer_app_bots",
        ["app_id", "is_active"],
    )


def downgrade() -> None:
    op.drop_index("ix_developer_app_bots_app_active", table_name="developer_app_bots")
    op.drop_index("ix_developer_app_bots_app_id", table_name="developer_app_bots")
    op.drop_table("developer_app_bots")
