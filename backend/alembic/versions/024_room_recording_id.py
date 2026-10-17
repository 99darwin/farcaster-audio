"""Add ``rooms.recording_id`` column.

Phase-4 part 1 — Farcaster-native recording agent. The recording-agent
dispatcher mints an opaque ``recording_id`` per spawned Node worker and
the ``stop_recording`` path needs to look it up. We could stash it in
``metadata_`` (JSONB) but a dedicated column gives us:

* a stable index for ops queries ("show me all rooms with active
  agents") without ``jsonb_path_ops``,
* a typed, NOT-NULL guarantee per row (the existence of the value is
  the source of truth that an agent is dispatched).

Nullable since the column is only populated for native-recording
rooms; the existing LiveKit egress path stores its ``egress_id`` in
Redis and is untouched.

Revision ID: 024
Revises: 023
Create Date: 2026-05-30
"""

from alembic import op
import sqlalchemy as sa

revision = "024"
down_revision = "023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("recording_id", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rooms", "recording_id")
