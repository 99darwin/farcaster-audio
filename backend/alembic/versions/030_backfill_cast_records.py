"""Backfill cast_records from existing per-surface hash columns.

Composer casts predating the ledger were never persisted and cannot be
backfilled from the database (recoverable only via hub signer queries).
Voice notes published from drafts are indistinguishable from direct voice
notes historically, so both backfill as 'voice_note'.

Revision ID: 030
Revises: 029
Create Date: 2026-07-10
"""

from alembic import op

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO cast_records (fid, cast_hash, source, created_at)
        SELECT fid, cast_hash, 'voice_note', created_at
        FROM voice_notes
        WHERE cast_hash IS NOT NULL
        ON CONFLICT (cast_hash) DO NOTHING
        """
    )
    # Demo rooms reuse a placeholder DEMO_CAST_HASH, not a real Juke cast.
    op.execute(
        """
        INSERT INTO cast_records (fid, cast_hash, source, created_at)
        SELECT r.host_fid, r.cast_hash, 'room_announcement', r.created_at
        FROM rooms r
        JOIN users u ON u.fid = r.host_fid
        WHERE r.cast_hash IS NOT NULL
          AND u.signer_uuid IS DISTINCT FROM 'demo-readonly'
        ON CONFLICT (cast_hash) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO cast_records (fid, cast_hash, source, created_at)
        SELECT fid, published_hash, 'scheduled',
               COALESCE(published_at, updated_at, created_at)
        FROM scheduled_casts
        WHERE published_hash IS NOT NULL
        ON CONFLICT (cast_hash) DO NOTHING
        """
    )


def downgrade() -> None:
    # Data-only backfill; rows are indistinguishable from organic writes once
    # inserted, and 029's downgrade drops the table entirely.
    pass
