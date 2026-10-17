from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Literal

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.auth import UserResponse
from app.schemas.common import CAST_HASH_PATTERN

if TYPE_CHECKING:
    from app.schemas.participant import ParticipantResponse


# Farcaster issues lowercase RFC-4122 UUIDs (v4 or v7) for its room
# identifiers. Matches the canonical 8-4-4-4-12 layout — accepting any
# hex digit (no version-bit narrowing) so we don't break if Farcaster
# rolls a future UUIDv8 / etc.
FARCASTER_ROOM_ID_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


class RsvpUserResponse(BaseModel):
    fid: int
    display_name: str
    pfp_url: str | None = None


class RsvpSummary(BaseModel):
    count: int
    users: list[RsvpUserResponse] = []
    is_going: bool = False


class RsvpResponse(BaseModel):
    status: str


class RoomCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    announce_cast: bool = False
    scheduled_at: str | None = None  # ISO 8601 datetime string
    allow_agents: bool = True


class RoomResponse(BaseModel):
    id: str
    title: str
    host_fid: int
    host: UserResponse
    status: str
    started_at: str
    ended_at: str | None = None
    scheduled_at: str | None = None
    speaker_count: int = 0
    listener_count: int = 0
    recording: bool = False
    cast_hash: str | None = None
    allow_agents: bool = True
    rsvp_summary: RsvpSummary | None = None
    # Phase-2 Farcaster-native mapping. ``farcaster_room_id`` is the
    # upstream UUID from ``client.farcaster.xyz`` when this row was
    # registered via ``POST /v1/rooms/link-farcaster``; ``None`` for
    # Juke-hosted LiveKit rooms. ``is_farcaster_native`` is the
    # discriminator clients should branch on when deciding whether to
    # call Juke's join/leave/recording endpoints (those return 4xx on
    # native rooms — clients must dispatch to the Farcaster client
    # instead).
    farcaster_room_id: str | None = None
    is_farcaster_native: bool = False
    # Developer-API native-space attribution. ``host_mode`` is one of
    # ``"bot"`` | ``"user_fid"`` for developer-created Farcaster-native
    # rooms (mirrors ``metadata_.host_mode``); ``farcaster_host_fid`` is
    # the upstream Farcaster host FID. Both are ``None`` for Juke-hosted
    # rooms and for consumer/iOS native rooms — additive + optional so no
    # existing response path breaks.
    host_mode: str | None = None
    farcaster_host_fid: int | None = None


class CreateNativeRoomRequest(BaseModel):
    """Create a Farcaster-native audio room.

    Two backend dispatch paths, picked by the presence of
    ``user_jfs_bearer``:

    1. **User-FID path (preferred).** Caller supplies a JFS Bearer
       signed by their on-device Ed25519 app key (audience
       ``https://client.farcaster.xyz``). The backend forwards it to
       ``POST /v1/audio-rooms`` so the upstream room is hosted by the
       caller's FID directly. No title prefix; no stage-invite dance.
    2. **Service-FID path (legacy fallback).** No bearer supplied —
       the backend mints with Juke's service-FID bearer and prefixes
       the upstream title with ``@username:`` so Warpcast still
       attributes the room to the caller. Kept for users who haven't
       approved the app key yet.

    Locked down with ``extra='forbid'`` so a future regression cannot
    accidentally accept fields that should never reach the upstream
    create (e.g. an FID override).
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=500)
    scheduled_at: datetime | None = None
    channel_key: str | None = Field(default=None, max_length=128)
    # JFS Bearer (header.payload.signature, base64url-encoded) signed by
    # the caller's Ed25519 app key. When present, the backend uses it as
    # the upstream Authorization instead of the service-FID bearer. The
    # caller's FID is encoded in the JFS header — router cross-checks it
    # against the Juke JWT FID so a partner can't pivot to host as
    # another user.
    user_jfs_bearer: str | None = Field(
        default=None,
        min_length=16,
        max_length=4096,
        description=(
            "User-signed JFS Bearer for client.farcaster.xyz "
            "(header.payload.signature)."
        ),
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str | None) -> str | None:
        """Enforce the base64url-three-segment shape on the bearer.

        Defense in depth against HTTP header injection: the bearer flows
        verbatim into an upstream ``Authorization: Bearer ...`` header.
        Restricting to ``[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+``
        rules out control characters (CRLF) and anything else that could
        attempt header smuggling, before the value reaches the httpx
        client. httpx rejects control chars too but we don't want to
        depend on that being our only layer.
        """
        if v is None:
            return v
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class LinkFarcasterRoomRequest(BaseModel):
    """Register a Farcaster-native room with Juke.

    Called by the iOS client immediately after a sync-enabled user
    creates their room on ``client.farcaster.xyz``. The Warpcast bearer
    that authorized the upstream create never crosses the wire — the
    backend trusts the caller (authenticated via a first-party Juke
    JWT, gated on ``farcaster_sync_enabled``) to provide the upstream
    room UUID.
    """

    model_config = ConfigDict(extra="forbid")

    farcaster_room_id: str = Field(
        ...,
        pattern=FARCASTER_ROOM_ID_PATTERN,
        description="Upstream Farcaster room UUID (lowercase, RFC-4122).",
    )
    title: str = Field(..., min_length=1, max_length=256)
    scheduled_at: datetime | None = None
    description: str | None = Field(default=None, max_length=2_000)


class NativeJoinRequest(BaseModel):
    """Trade a user-signed JFS bearer for upstream LiveKit join creds.

    The caller signs the bearer with their on-device Ed25519 app key
    (audience ``https://client.farcaster.xyz``) and the backend proxies
    it to ``POST /v1/audio-room/join``. The returned ``ws_url`` + ``token``
    point at Farcaster's LiveKit project — Juke's LiveKit credentials are
    not used and not exposed.

    Locked down with ``extra='forbid'`` so a future regression cannot
    accidentally accept fields that should never reach upstream.
    """

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str = Field(
        ...,
        min_length=16,
        max_length=4096,
        description=(
            "User-signed JFS Bearer for client.farcaster.xyz "
            "(header.payload.signature)."
        ),
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class NativeJoinResponse(BaseModel):
    """Upstream LiveKit signaling URL + access token for the caller.

    ``ws_url`` is the LiveKit server WebSocket URL (e.g.
    ``wss://farcaster-xxx.livekit.cloud``) — distinct from Juke's own
    ``LIVEKIT_WS_URL``. The client connects directly; no Juke LiveKit
    quota is consumed.
    """

    ws_url: str
    token: str
    # The caller's authoritative role in the upstream room, so clients can
    # render host/co-host/speaker controls without guessing from host_fid.
    # ``host`` is derived from the Juke row; co_host/speaker/listener come from
    # the upstream participant list (best-effort). Defaults to ``listener``.
    role: Literal["host", "co_host", "speaker", "listener"] = "listener"


class EndNativeRoomRequest(BaseModel):
    """End a Farcaster-native room.

    Body shape depends on which bearer minted the upstream room
    (recorded on the Juke row as ``metadata_.host_mode``):

    * ``user_fid`` rooms — the upstream room is hosted by the caller's
      own FID, so only the caller's JFS bearer can authorize the
      upstream ``audio-room/end`` call. The service-FID bearer 403s.
      Caller MUST supply a fresh ``user_jfs_bearer``.
    * ``service_fid`` rooms (legacy fallback) — the upstream room is
      hosted by Juke's service FID, so the service bearer is the only
      one that can end it. ``user_jfs_bearer`` is ignored on this path.

    Locked down with ``extra='forbid'`` so a future regression cannot
    accidentally accept fields that should never reach upstream.
    """

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str | None = Field(
        default=None,
        min_length=16,
        max_length=4096,
        description=(
            "User-signed JFS Bearer for client.farcaster.xyz "
            "(header.payload.signature). Required for user_fid host "
            "mode; unused for service_fid."
        ),
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class StartNativeRoomRequest(BaseModel):
    """Go live on a *scheduled* Farcaster-native room.

    Same body shape and host-mode posture as
    :py:class:`EndNativeRoomRequest`: the upstream
    ``audio-room/start-scheduled`` call is host-only, so a ``user_fid``
    room (the default create path) needs the caller's freshly-signed JFS
    bearer, while a legacy ``service_fid`` room starts via the cached
    service bearer and ignores ``user_jfs_bearer``.

    Locked down with ``extra='forbid'`` so a future regression cannot
    accidentally accept fields that should never reach upstream.
    """

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str | None = Field(
        default=None,
        min_length=16,
        max_length=4096,
        description=(
            "User-signed JFS Bearer for client.farcaster.xyz "
            "(header.payload.signature). Required for user_fid host "
            "mode; unused for service_fid."
        ),
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class NativeRaiseHandRequest(BaseModel):
    """Listener-initiated stage hand-raise (or lower) on a Farcaster-native
    room. Caller signs a JFS bearer with their on-device app key; the
    backend proxies to ``POST /v1/audio-room/raise-hand``. The signer's
    FID is the one Farcaster credits — caller cannot raise someone
    else's hand."""

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str = Field(
        ...,
        min_length=16,
        max_length=4096,
        description="Listener's signed JFS bearer.",
    )
    raised: bool = Field(
        default=True,
        description="True to raise the hand; false to lower.",
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class NativeHeartbeatRequest(BaseModel):
    """Report the caller as an active speaker on a Farcaster-native room so
    the space isn't auto-ended for host inactivity. Sent every ~30s while the
    caller is publishing audio (mic or piped external audio). Caller signs a
    JFS bearer with their on-device app key; the backend credits only the
    signer's own FID (never a client-supplied list) and proxies to
    ``POST /v1/audio-room/heartbeat``."""

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str = Field(
        ...,
        min_length=16,
        max_length=4096,
        description="Caller's signed JFS bearer.",
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class NativeAcceptSpeakerRequest(BaseModel):
    """Host-initiated promotion of ``target_fid`` to speaker on a
    Farcaster-native room. The bearer must be the HOST's own JFS
    bearer — only the upstream host FID can accept-speaker. Router
    cross-checks the JFS-claimed fid against ``Room.host_fid``."""

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str = Field(
        ...,
        min_length=16,
        max_length=4096,
        description="Host's signed JFS bearer.",
    )
    target_fid: int = Field(..., gt=0, description="FID to promote.")

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class NativeStageInviteResponseRequest(BaseModel):
    """Invitee-initiated accept or decline of a pending stage invite.

    The caller (the invited user) signs a JFS bearer; the router
    cross-checks the JFS fid against the JWT fid before proxying to
    upstream. Used for both accept and decline — they share the same
    body shape and same auth posture.
    """

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str = Field(
        ...,
        min_length=16,
        max_length=4096,
        description="Invitee's signed JFS bearer.",
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class NativeRemoveSpeakerRequest(BaseModel):
    """Host-initiated demotion of ``target_fid`` back to listener.
    Same auth posture as ``NativeAcceptSpeakerRequest``."""

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str = Field(
        ...,
        min_length=16,
        max_length=4096,
        description="Host's signed JFS bearer.",
    )
    target_fid: int = Field(..., gt=0, description="FID to demote.")

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_jfs_shape(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", v):
            raise ValueError("must be base64url-encoded header.payload.signature")
        return v


class MirrorNativeRoomRequest(BaseModel):
    """Upsert a Juke ``Room`` mirror of an upstream-discovered Farcaster
    space so the in-app player can render and join it.

    Used when the discovery rail surfaces a Farcaster-native space that
    Juke never created (i.e. it isn't in the Juke DB). Posting this
    creates a stub ``Room`` row with ``is_farcaster_native=True`` and
    ``livekit_room_id=NULL`` keyed on ``farcaster_room_id`` — repeat
    calls return the existing row.

    The host's ``User`` row is upserted so the ``Room.host_fid`` FK is
    satisfied without requiring the host to be signed in to Juke.

    NOTE: ``host_fid``/``host_*`` are ADVISORY only. On first mirror the
    server resolves the authoritative host (and title/state) from the
    upstream Farcaster space by ``farcaster_room_id`` and ignores these
    client-supplied values — they must not be trusted for attribution.
    """

    model_config = ConfigDict(extra="forbid")

    farcaster_room_id: str = Field(..., min_length=8, max_length=64)
    title: str = Field("", max_length=256)
    state: str = Field("live", min_length=1, max_length=32)
    host_fid: int = Field(..., gt=0)
    host_username: str | None = Field(None, max_length=64)
    host_display_name: str | None = Field(None, max_length=256)
    host_pfp_url: str | None = Field(None, max_length=2048)
    started_at: datetime | None = None
    scheduled_at: datetime | None = None
    # Upstream root cast for the space's FIP-2 conversation. When set,
    # we persist it as ``Room.cast_hash`` so Juke's existing chat surface
    # (which threads replies to a root cast) lights up for native rooms
    # without any further wiring — Juke and Farcaster-native rooms both
    # anchor their chat to a root cast via FIP-2.
    root_cast_hash: str | None = Field(
        None,
        max_length=66,
        pattern=CAST_HASH_PATTERN,
        description="0x-prefixed hex hash of the upstream root cast.",
    )


class RoomCreateResponse(BaseModel):
    room: RoomResponse
    livekit_token: str | None = None
    livekit_ws_url: str | None = None
    expires_at: str | None = None


class RoomGoLiveResponse(BaseModel):
    room: RoomResponse
    livekit_token: str
    livekit_ws_url: str
    expires_at: str | None = None


class RoomListResponse(BaseModel):
    rooms: list[RoomResponse]
    next_cursor: str | None = None


class RoomDetailResponse(BaseModel):
    room: RoomResponse
    participants: list[ParticipantResponse]
    hand_queue: list[int] = []


class RoomEmbedPolicyResponse(BaseModel):
    """Public per-room iframe policy consumed by `landing/middleware.ts`.

    `allowed_origins` is the owning app's allowlist when the room was
    created via `POST /v1/developer/spaces`; null when the room has no
    owning app (iOS-created rooms, deleted apps). Middleware emits a
    matching `frame-ancestors` directive, or falls back to permissive
    when null.
    """

    allowed_origins: list[str] | None = None


class RecordingResponse(BaseModel):
    """A single recorded segment on a user's profile.

    Multiple recordings can share a ``room_id`` (host stopped + restarted
    recording in the same space). ``id`` is the recording-segment UUID.
    Older clients that don't read ``id`` fall through to ``room_id`` for
    routing — the most recent segment is what they'll play, matching
    pre-migration behavior.
    """

    id: str | None = None
    room_id: str
    title: str
    recording_url: str
    started_at: str
    ended_at: str | None = None
    duration_seconds: int | None = None
    cast_hash: str | None = None


class RecordingListResponse(BaseModel):
    recordings: list[RecordingResponse]
    next_cursor: str | None = None


class RecordingFeedHost(BaseModel):
    fid: int
    username: str
    display_name: str
    pfp_url: str | None = None


class RecordingFeedItem(BaseModel):
    recording: RecordingResponse
    host: RecordingFeedHost


class RecordingFeedResponse(BaseModel):
    items: list[RecordingFeedItem]
    next_cursor: str | None = None
