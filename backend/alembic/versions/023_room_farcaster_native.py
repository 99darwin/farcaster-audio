"""Add Farcaster-native room mapping columns to rooms.

Phase-2 of the Farcaster-native spaces work. When a sync-enabled user
spawns their room directly on ``client.farcaster.xyz`` from the Juke
client, the Juke backend never proxies the upstream call (the
Warpcast bearer stays on-device in the iOS Keychain). The backend
still records a mapping so:

* Juke discovery can show native rooms alongside hosted rooms.
* Future features (recording agent, partner SSO, developer API)
  can reference the upstream room id.
* Cross-device users can resume a native room they're hosting.

Columns:

* ``farcaster_room_id``     — Farcaster-issued UUID for the upstream
  room. Nullable + indexed for join/discovery lookups.
* ``is_farcaster_native``   — boolean discriminator. ``False`` for
  every existing row (Juke-hosted LiveKit rooms); set to ``True``
  by the ``/v1/rooms/link-farcaster`` endpoint.

Revision ID: 023
Revises: 022
Create Date: 2026-05-30
"""

from alembic import op
import sqlalchemy as sa


revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("farcaster_room_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "rooms",
        sa.Column(
            "is_farcaster_native",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_rooms_farcaster_room_id",
        "rooms",
        ["farcaster_room_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_rooms_farcaster_room_id", table_name="rooms")
    op.drop_column("rooms", "is_farcaster_native")
    op.drop_column("rooms", "farcaster_room_id")
