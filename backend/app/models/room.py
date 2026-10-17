import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    host_fid: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.fid", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", index=True
    )
    livekit_room_id: Mapped[str | None] = mapped_column(String(128))
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scheduled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    max_speakers: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    max_listeners: Mapped[int] = mapped_column(Integer, nullable=False, default=500)
    recording: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    recording_url: Mapped[str | None] = mapped_column(Text)
    # Stable S3 object key (e.g. "recordings/{room}/{ts}.ogg"). Populated by
    # the egress webhook going forward; ``recording_url`` stays for legacy
    # rows but client-facing responses always generate a short-lived
    # presigned URL from the key when it's present.
    recording_key: Mapped[str | None] = mapped_column(Text)
    # Phase-4: opaque id for an active recording-agent worker spawned by
    # ``RecordingAgentService``. Populated by ``_start_native_recording``
    # so ``_stop_native_recording`` can finalize the worker. NULL for
    # rooms not currently being recorded by a Juke-owned agent (which
    # is every Juke-hosted room — those use the egress webhook path
    # with the egress_id stored in Redis).
    recording_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    cast_hash: Mapped[str | None] = mapped_column(String(66), index=True)
    # Set when the room was created via `POST /v1/developer/spaces`. Drives
    # per-app `frame-ancestors` on the embed iframe; null for iOS-created
    # rooms which fall back to the permissive default policy.
    created_by_app_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developer_apps.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    allow_agents: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    metadata_: Mapped[dict] = mapped_column(
        "metadata",
        # JSONB on Postgres (production), generic JSON on SQLite (tests).
        # The two are query-compatible for our usage (no jsonb_* operators).
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        server_default="{}",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # Phase-2 Farcaster-native mapping. Populated only when a
    # sync-enabled user spawns their room directly on
    # ``client.farcaster.xyz`` from the Juke client — the bearer never
    # crosses the wire so the Juke backend never proxies the upstream
    # call, but we record this mapping so discovery can show native
    # rooms alongside hosted rooms and future features (recording
    # agent, partner SSO, developer API) can reference the upstream
    # room id.
    #
    # ``farcaster_room_id`` is the Farcaster-issued UUID for the
    # upstream room; ``is_farcaster_native`` discriminates the row
    # from a Juke-hosted LiveKit room. Native rooms have
    # ``livekit_room_id = NULL`` and skip the LiveKit provisioning
    # path in ``RoomService``.
    farcaster_room_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True, unique=True
    )
    is_farcaster_native: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    __table_args__ = (
        Index(
            "ix_rooms_started_at_desc",
            "started_at",
            postgresql_ops={"started_at": "DESC"},
        ),
    )
