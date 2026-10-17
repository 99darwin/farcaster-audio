"""Add ``recordings`` table — promote recordings to first-class rows.

The original schema stored ``recording_url`` + ``recording_key`` as
single columns on ``rooms``, which meant a host who stopped and
restarted recording in the same space silently overwrote the first
take. Surfaced in live testing: tester ran two recordings in one
space session, only the second showed in the library and the first's
S3 object was orphaned.

This migration:
  * creates a ``recordings`` table — one row per finalized segment,
    FK to ``rooms``, includes the S3 key + URL + bounds.
  * backfills existing recordings from ``rooms.recording_url`` /
    ``rooms.recording_key`` into the new table so the recordings list
    keeps working immediately after deploy.
  * leaves ``rooms.recording_url`` / ``rooms.recording_key`` in place.
    The write paths keep updating them too (always pointing at the
    most recent segment) so older iOS clients that read from there
    keep functioning during rollout.

Revision ID: 026
Revises: 025
Create Date: 2026-06-11
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recordings",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "room_id",
            UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("recording_url", sa.Text(), nullable=True),
        sa.Column("s3_key", sa.Text(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("byte_size", sa.BigInteger(), nullable=True),
        sa.Column(
            "upstream_recording_id", sa.String(length=64), nullable=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_recordings_started_at_desc",
        "recordings",
        ["started_at"],
        postgresql_ops={"started_at": "DESC"},
    )
    op.create_index(
        "ix_recordings_room_started_at",
        "recordings",
        ["room_id", "started_at"],
    )

    # Backfill: every existing room with a recording_url becomes a
    # recordings row. Source defaults to ``egress`` for backfilled
    # rows since that's the historic write path; native rows
    # post-deploy use ``native``. Bounds default to the room's start/
    # end so durations show correctly in the UI.
    op.execute(
        """
        INSERT INTO recordings (
            id, room_id, source, recording_url, s3_key,
            started_at, ended_at, duration_seconds, created_at
        )
        SELECT
            gen_random_uuid(),
            id,
            'egress',
            recording_url,
            recording_key,
            started_at,
            ended_at,
            CASE
                WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
                THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::int)
                ELSE NULL
            END,
            COALESCE(ended_at, started_at, now())
        FROM rooms
        WHERE recording_url IS NOT NULL AND recording_url != ''
        """
    )


def downgrade() -> None:
    op.drop_index("ix_recordings_room_started_at", table_name="recordings")
    op.drop_index("ix_recordings_started_at_desc", table_name="recordings")
    op.drop_table("recordings")
