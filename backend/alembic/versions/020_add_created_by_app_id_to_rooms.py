"""Add created_by_app_id to rooms

Links rooms created via the developer API (`POST /v1/developer/spaces`) to
the developer app whose key minted them. Used to drive per-app dynamic
`frame-ancestors` on the embed iframe (`landing/middleware.ts`) so the
browser-level allowlist matches the backend Origin-header enforcement.

Nullable: existing rooms and rooms created via the iOS app have no
owning developer app. ON DELETE SET NULL: deleting an app unlinks its
rooms (rather than deleting them or blocking the delete) — the rooms
fall back to the permissive default policy and stay usable.

Revision ID: 020
Revises: 019
Create Date: 2026-05-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column(
            "created_by_app_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_rooms_created_by_app_id",
        "rooms",
        "developer_apps",
        ["created_by_app_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_rooms_created_by_app_id",
        "rooms",
        ["created_by_app_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_rooms_created_by_app_id", table_name="rooms")
    op.drop_constraint("fk_rooms_created_by_app_id", "rooms", type_="foreignkey")
    op.drop_column("rooms", "created_by_app_id")
