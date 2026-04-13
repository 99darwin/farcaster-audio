"""Add voice_notes, voice_note_plays, and voice_note_reactions tables

Revision ID: 012
Revises: 011
Create Date: 2026-04-13
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "voice_notes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("fid", sa.BigInteger(), sa.ForeignKey("users.fid", ondelete="RESTRICT"), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("audio_url", sa.Text(), nullable=False),
        sa.Column("audio_size", sa.Integer(), nullable=False),
        sa.Column("waveform_peaks", JSONB(), nullable=True),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("transcript_lang", sa.String(10), nullable=True),
        sa.Column("transcript_words", JSONB(), nullable=True),
        sa.Column("cast_hash", sa.String(66), nullable=True),
        sa.Column("cast_url", sa.Text(), nullable=True),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("duration_ms > 0 AND duration_ms <= 60000", name="ck_voice_notes_duration"),
    )
    op.create_index(
        "idx_voice_notes_fid_created",
        "voice_notes",
        ["fid", sa.text("created_at DESC")],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index(
        "idx_voice_notes_cast_hash",
        "voice_notes",
        ["cast_hash"],
        postgresql_where=sa.text("cast_hash IS NOT NULL"),
    )

    op.create_table(
        "voice_note_plays",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("voice_note_id", UUID(as_uuid=True), sa.ForeignKey("voice_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("listener_fid", sa.BigInteger(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("listened_ms", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("completed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
    )
    op.create_index("idx_voice_note_plays_vnid", "voice_note_plays", ["voice_note_id"])

    op.create_table(
        "voice_note_reactions",
        sa.Column("voice_note_id", UUID(as_uuid=True), sa.ForeignKey("voice_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("reaction_type", sa.String(10), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("voice_note_id", "fid", "reaction_type"),
        sa.CheckConstraint("reaction_type IN ('like', 'recast')", name="ck_voice_note_reactions_type"),
    )


def downgrade() -> None:
    op.drop_table("voice_note_reactions")
    op.drop_index("idx_voice_note_plays_vnid", table_name="voice_note_plays")
    op.drop_table("voice_note_plays")
    op.drop_index("idx_voice_notes_cast_hash", table_name="voice_notes")
    op.drop_index("idx_voice_notes_fid_created", table_name="voice_notes")
    op.drop_table("voice_notes")
