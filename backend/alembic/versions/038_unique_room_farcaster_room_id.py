"""Make rooms.farcaster_room_id unique.

``POST /v1/rooms/link-farcaster`` dedupes on ``farcaster_room_id`` with a
read-then-insert, so concurrent links (or pre-fix squatting) could leave
several Juke rows pointing at one upstream space. A unique index closes
the race at the database layer.

Existing duplicates are resolved without deleting anything: per
``farcaster_room_id`` one canonical row is kept (live first, then
scheduled, then oldest), and the others have ``farcaster_room_id`` set to
NULL with the original value preserved in
``metadata.farcaster_room_id_duplicate`` for audit.

Revision ID: 038
Revises: 035
Create Date: 2026-10-17
"""

from alembic import op

revision = "038"
down_revision = "035"
branch_labels = None
depends_on = None

INDEX_NAME = "ix_rooms_farcaster_room_id"


def upgrade() -> None:
    op.execute("""
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY farcaster_room_id
                    ORDER BY
                        CASE status
                            WHEN 'active' THEN 0
                            WHEN 'scheduled' THEN 1
                            ELSE 2
                        END,
                        created_at ASC NULLS LAST,
                        id ASC
                ) AS rank
            FROM rooms
            WHERE farcaster_room_id IS NOT NULL
        )
        UPDATE rooms
        SET
            metadata = COALESCE(rooms.metadata, '{}'::jsonb)
                || jsonb_build_object(
                    'farcaster_room_id_duplicate', rooms.farcaster_room_id
                ),
            farcaster_room_id = NULL
        FROM ranked
        WHERE rooms.id = ranked.id AND ranked.rank > 1
        """)
    op.drop_index(INDEX_NAME, table_name="rooms")
    op.create_index(INDEX_NAME, "rooms", ["farcaster_room_id"], unique=True)


def downgrade() -> None:
    # De-duplicated rows are intentionally not re-linked: their original
    # value stays in metadata.farcaster_room_id_duplicate.
    op.drop_index(INDEX_NAME, table_name="rooms")
    op.create_index(INDEX_NAME, "rooms", ["farcaster_room_id"], unique=False)
