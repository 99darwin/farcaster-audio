import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class VoiceNote(Base):
    __tablename__ = "voice_notes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    fid: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.fid", ondelete="RESTRICT"), nullable=False
    )
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    audio_url: Mapped[str] = mapped_column(Text, nullable=False)
    audio_size: Mapped[int] = mapped_column(Integer, nullable=False)
    waveform_peaks: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_lang: Mapped[str | None] = mapped_column(String(10), nullable=True)
    transcript_words: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    cast_hash: Mapped[str | None] = mapped_column(String(66), nullable=True, index=True)
    cast_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    caption: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint("duration_ms > 0 AND duration_ms <= 60000", name="ck_voice_notes_duration"),
        Index(
            "idx_voice_notes_fid_created",
            "fid",
            "created_at",
            postgresql_ops={"created_at": "DESC"},
            postgresql_where="deleted_at IS NULL",
        ),
        Index(
            "idx_voice_notes_cast_hash",
            "cast_hash",
            postgresql_where="cast_hash IS NOT NULL",
        ),
    )


class VoiceNotePlay(Base):
    __tablename__ = "voice_note_plays"

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(), primary_key=True
    )
    voice_note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("voice_notes.id", ondelete="CASCADE"),
        nullable=False,
    )
    listener_fid: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    listened_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("idx_voice_note_plays_vnid", "voice_note_id"),
    )


class VoiceNoteReaction(Base):
    __tablename__ = "voice_note_reactions"

    voice_note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("voice_notes.id", ondelete="CASCADE"),
        primary_key=True,
    )
    fid: Mapped[int] = mapped_column(BigInteger, nullable=False, primary_key=True)
    reaction_type: Mapped[str] = mapped_column(
        String(10), nullable=False, primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "reaction_type IN ('like', 'recast')",
            name="ck_voice_note_reactions_type",
        ),
    )
