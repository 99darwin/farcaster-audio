"""Recording row — one per finalized recording segment.

The original schema stored a single recording_url + recording_key on
the rooms table, which made a space's "last" recording overwrite any
prior one in the same row. This model promotes recordings to a
first-class table so a space can hold multiple segments (e.g. host
stops + restarts recording mid-session, or splits a long space).

The rooms.recording_url / recording_key columns stay populated for
backward compat with older clients — they always point at the most
recent segment for a given room.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # FK to rooms. Deleting the room cascades — recordings without a
    # parent room have nowhere to live in the UI.
    room_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # ``native`` for the Farcaster-native recording-agent path,
    # ``egress`` for the LiveKit Juke-native egress path. Same storage
    # backend but different write paths upstream.
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    # Raw URL persisted at write time. The recordings router prefers
    # the presigned form of ``s3_key`` for playback; this is mostly a
    # fallback for legacy rows that don't carry a key.
    recording_url: Mapped[str | None] = mapped_column(Text)
    # S3 object key — the source of truth for presigned playback URLs.
    s3_key: Mapped[str | None] = mapped_column(Text)
    # Wall-clock segment bounds. ``started_at`` is when the recording
    # worker emitted ``started``; ``ended_at`` is when ``finalized``
    # came back. For backfilled rows (pre-migration recordings), both
    # default to the parent room's started_at / ended_at.
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Convenience cache — computed at insert time from ``ended_at -
    # started_at`` so the recordings list doesn't have to recompute on
    # every read.
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    # Final encoded file size in bytes (from the worker's ``finalized``
    # event). Optional — older paths may not surface it.
    byte_size: Mapped[int | None] = mapped_column(BigInteger)
    # Recording-agent worker recording id (for native), or upstream
    # egress id (for egress). Useful for ops correlation.
    upstream_recording_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # Discovery feed sorts on started_at DESC; same for per-user.
        Index(
            "ix_recordings_started_at_desc",
            "started_at",
            postgresql_ops={"started_at": "DESC"},
        ),
        # Per-room list (player detail page, debugging).
        Index("ix_recordings_room_started_at", "room_id", "started_at"),
    )
