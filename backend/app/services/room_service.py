"""
RoomService — core orchestrator for all room lifecycle operations.

Coordinates:
  - Postgres (SQLAlchemy async) for durable state
  - Redis (RedisService) for hot/live state and pub/sub
  - LiveKit (LiveKitService) for real-time media

Error contract:
  - 400 Bad Request  — invalid input / conflicting state
  - 403 Forbidden    — permission denied
  - 404 Not Found    — resource not found
  - 409 Conflict     — duplicate action (already banned, already in room, etc.)
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException
from sqlalchemy import delete, func as sa_func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import DEMO_SIGNER_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.ban import Ban
from app.models.participant import Participant
from app.models.recording import Recording
from app.models.room import Room
from app.models.room_rsvp import RoomRsvp
from app.models.user import User
from app.services.block_service import get_blocked_fids, is_blocked
from app.services.dev_webhook_service import dispatch as dispatch_dev_webhook
from app.schemas.auth import UserResponse
from app.schemas.farcaster_spaces import AudioRoom, FarcasterSpacesConfigError
from app.schemas.participant import (
    BanResponse,
    JoinResponse,
    ParticipantResponse,
    PromoteResponse,
    RaiseHandResponse,
    TokenRefreshResponse,
)
from app.schemas.room import (
    RoomCreateResponse,
    RoomDetailResponse,
    RoomGoLiveResponse,
    RoomListResponse,
    RoomResponse,
    RsvpResponse,
    RsvpSummary,
    RsvpUserResponse,
)
from app.services import farcaster_writes, permission_service
from app.services.cast_ledger import record_cast
from app.services.hypersnap_webhook_service import schedule_room_reply_sync
from app.services.livekit_service import PARTICIPANT_TOKEN_TTL, LiveKitService
from app.services.push_service import PushService
from app.services.recording_agent_service import (
    RecordingAgentError,
    RecordingAgentService,
)
from app.services.redis_service import RedisService

# Imported lazily by ``RoomService`` to keep the test stubs that
# construct ``RoomService`` without the new services functional.
from app.services.farcaster_spaces_service import FarcasterSpacesService

logger = logging.getLogger(__name__)

JUKE_HOME_URL = "https://juke.audio"
SPACE_URL_TEMPLATE = "https://juke.audio/space/{room_id}"

ANONYMOUS_LISTENER_TTL_SECONDS = 20 * 60
ANONYMOUS_LISTENER_TOKEN_TTL_SECONDS = 15 * 60
# Revocation markers must outlive any join token issued before the
# kick/ban/demote (token TTL) plus clock skew between us and LiveKit.
LIVEKIT_REVOCATION_TTL_SECONDS = int(PARTICIPANT_TOKEN_TTL.total_seconds()) + 5 * 60

# Sentinel FID for system-initiated actions (not a real Farcaster FID).
# Used when the reconciler / webhooks force-stop a recording with no
# human actor.
SYSTEM_ACTOR_FID = 0


# ---------------------------------------------------------------------------
# Internal helpers (module-level, no self dependency)
# ---------------------------------------------------------------------------


def _room_id_str(room_id: uuid.UUID) -> str:
    return str(room_id)


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _livekit_expires_at() -> str:
    return (_utcnow() + PARTICIPANT_TOKEN_TTL).isoformat()


def _anonymous_livekit_expires_at() -> str:
    expires_at = _utcnow() + timedelta(seconds=ANONYMOUS_LISTENER_TOKEN_TTL_SECONDS)
    return expires_at.isoformat()


def _room_discovery_event(room_id: str, reason: str, status: str) -> dict[str, str]:
    return {
        "type": "rooms_changed",
        "reason": reason,
        "room_id": room_id,
        "status": status,
    }


# ---------------------------------------------------------------------------
# RoomService
# ---------------------------------------------------------------------------


class RoomService:
    def __init__(
        self,
        db: AsyncSession,
        redis: RedisService,
        livekit: LiveKitService,
        *,
        farcaster_spaces: FarcasterSpacesService | None = None,
        recording_agent: RecordingAgentService | None = None,
    ):
        self.db = db
        self.redis = redis
        self.livekit = livekit
        # Optional Phase-4 collaborators. Old call sites (and the
        # source-level guard tests) still construct ``RoomService``
        # without these — code paths that depend on them check for
        # ``None`` and raise a 503.
        self.farcaster_spaces = farcaster_spaces
        self.recording_agent = recording_agent
        self._push: PushService | None = None

    @property
    def push(self) -> PushService:
        if self._push is None:
            self._push = PushService(self.db, self.redis.redis)
        return self._push

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    async def create_room(
        self,
        fid: int,
        title: str,
        announce_cast: bool = False,
        scheduled_at: datetime | None = None,
        allow_agents: bool = True,
        created_by_app_id: uuid.UUID | None = None,
    ) -> RoomCreateResponse:
        """
        Create a new audio room (immediate or scheduled).

        If ``scheduled_at`` is provided the room is persisted with
        status="scheduled" and no LiveKit/Redis resources are allocated until
        the host explicitly goes live via ``start_scheduled_room``.
        """
        host = await self._get_user(fid)

        is_scheduled = scheduled_at is not None

        # Enforce per-user cap on scheduled rooms
        if is_scheduled:
            count_result = await self.db.execute(
                select(sa_func.count())
                .select_from(Room)
                .where(Room.host_fid == fid, Room.status == "scheduled")
            )
            scheduled_count = count_result.scalar() or 0
            if scheduled_count >= 10:
                raise HTTPException(
                    status_code=400,
                    detail="You can have at most 10 scheduled rooms at a time",
                )

        room = Room(
            title=title,
            host_fid=fid,
            status="scheduled" if is_scheduled else "active",
            scheduled_at=scheduled_at,
            started_at=None if is_scheduled else _utcnow(),
            allow_agents=allow_agents,
            created_by_app_id=created_by_app_id,
        )
        self.db.add(room)
        await self.db.flush()

        room_id = _room_id_str(room.id)

        # --- Scheduled rooms: persist and return early (no LiveKit/Redis) ---
        if is_scheduled:
            await self.db.commit()
            await self.db.refresh(room)

            # Optionally announce on Farcaster
            if announce_cast:
                scheduled_label = scheduled_at.strftime("%b %d at %I:%M %p UTC")  # type: ignore[union-attr]
                cast_hash = await self._announce_room_scheduled(
                    room_id, title, host, scheduled_label
                )
                if cast_hash:
                    await self.db.execute(
                        update(Room)
                        .where(Room.id == room.id)
                        .values(cast_hash=cast_hash)
                    )
                    await self.db.commit()
                    await self.db.refresh(room)

            room_response = await self._build_room_response(room, host, 0, 0)
            await self.redis.publish_room_discovery_event(
                _room_discovery_event(room_id, "room_scheduled", "scheduled")
            )
            logger.info(
                "Scheduled room %s created by fid=%s for %s", room_id, fid, scheduled_at
            )
            return RoomCreateResponse(
                room=room_response, livekit_token=None, livekit_ws_url=None
            )

        # --- Immediate rooms: full LiveKit/Redis setup ---

        # Create the LiveKit room (best-effort; roll back if it fails)
        try:
            await self.livekit.create_room(room_id=room_id, title=title)
        except Exception as exc:
            logger.exception("LiveKit room creation failed for room %s", room_id)
            await self.db.rollback()
            raise HTTPException(
                status_code=502, detail="Failed to create media room"
            ) from exc

        room.livekit_room_id = room_id
        await self.db.commit()
        await self.db.refresh(room)

        # Seed Redis state
        started_ts = (
            room.started_at.timestamp() if room.started_at else _utcnow().timestamp()
        )
        await self.redis.set_room_state(
            room_id,
            {
                "id": room_id,
                "title": title,
                "host_fid": fid,
                "status": "active",
                "started_at": started_ts,
            },
        )
        await self.redis.add_active_room(room_id, started_ts)

        # Add host as first participant
        host_participant_data = {
            "fid": fid,
            "role": "host",
            "is_muted": False,
            "hand_raised": False,
            "display_name": host.display_name or host.username or str(fid),
            "pfp_url": host.pfp_url,
        }
        await self.redis.set_participant(room_id, fid, host_participant_data)
        await self.redis.set_user_active_room(fid, room_id)

        # Persist host participant row in DB
        participant = Participant(
            room_id=room.id,
            fid=fid,
            role="host",
            is_muted=False,
        )
        self.db.add(participant)
        await self.db.commit()

        # Post announcement cast (fire-and-forget; must not block room creation)
        # In dev/demo mode, use a pre-configured cast hash for testing the chat UI
        is_demo_user = host.signer_uuid == DEMO_SIGNER_UUID
        if settings.DEMO_CAST_HASH and is_demo_user:
            await self.db.execute(
                update(Room)
                .where(Room.id == room.id)
                .values(cast_hash=settings.DEMO_CAST_HASH)
            )
            await self.db.commit()
            await self.db.refresh(room)
            self._sync_room_reply_webhook()
        elif announce_cast:
            cast_hash = await self._announce_room(room_id, title, host)
            if cast_hash:
                await self.db.execute(
                    update(Room).where(Room.id == room.id).values(cast_hash=cast_hash)
                )
                await self.db.commit()
                await self.db.refresh(room)
                self._sync_room_reply_webhook()

        # Generate LiveKit token for host
        token = self.livekit.generate_token(
            room_id=room_id,
            fid=fid,
            display_name=host_participant_data["display_name"],
            role="host",
            pfp_url=host.pfp_url,
        )

        speaker_count = await self.redis.get_speaker_count(room_id)
        listener_count = await self.redis.get_listener_count(room_id)

        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        await self.redis.publish_room_discovery_event(
            _room_discovery_event(room_id, "room_started", "active")
        )
        await dispatch_dev_webhook(
            self.db,
            app_id=room.created_by_app_id,
            event_type="room.started",
            data={
                "room_id": room_id,
                "title": title,
                "host_fid": fid,
                "started_at": room.started_at.isoformat() if room.started_at else None,
                "scheduled_at": None,
            },
        )
        logger.info("Room %s created by fid=%s", room_id, fid)
        return RoomCreateResponse(
            room=room_response,
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
            expires_at=_livekit_expires_at(),
        )

    async def _fetch_upstream_room_or_raise(self, farcaster_room_id: str) -> AudioRoom:
        """Fetch the authoritative upstream Farcaster space or raise 5xx/404."""
        if self.farcaster_spaces is None:
            raise HTTPException(
                status_code=503, detail="Farcaster spaces are unavailable."
            )
        try:
            upstream = await self.farcaster_spaces.get_room(farcaster_room_id)
        except FarcasterSpacesConfigError as exc:
            raise HTTPException(
                status_code=503, detail="Farcaster spaces are unavailable."
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "upstream get_room failed during native link: %s",
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=502, detail="Couldn't verify the Farcaster space."
            ) from exc
        if upstream is None:
            raise HTTPException(
                status_code=404, detail="Upstream Farcaster space not found."
            )
        return upstream

    async def _get_native_room_by_farcaster_id(
        self, farcaster_room_id: str
    ) -> Room | None:
        result = await self.db.execute(
            select(Room).where(Room.farcaster_room_id == farcaster_room_id)
        )
        return result.scalar_one_or_none()

    async def _claim_existing_native_room(self, row: Room, host: User) -> RoomResponse:
        """Return an already-linked row to its verified upstream host.

        Callers must have verified ``host.fid`` is the upstream host. If a
        different Juke user claimed the row first (possible before the
        upstream host check existed), re-attribute it.
        """
        if row.host_fid != host.fid:
            logger.warning(
                "Re-attributing native room %s to verified upstream host",
                row.id,
            )
            row.host_fid = host.fid
            row.metadata_ = {
                **(row.metadata_ or {}),
                "farcaster_host_fid": host.fid,
            }
            await self.db.commit()
            await self.db.refresh(row)
        # Existing native rows have no live LiveKit state; skip the Redis
        # round-trip and return zero counts directly.
        return await self._build_room_response(row, host, 0, 0)

    async def link_farcaster_room(
        self,
        fid: int,
        farcaster_room_id: str,
        title: str,
        scheduled_at: datetime | None = None,
        description: str | None = None,
    ) -> RoomResponse:
        """Register a Farcaster-native room with Juke.

        The upstream room was created by the user directly against
        ``client.farcaster.xyz`` (the Warpcast bearer never crosses the
        wire). We persist a Juke ``Room`` row pointing at the upstream
        UUID so discovery and future cross-cutting features can
        reference it.

        ``host_fid`` is the **Juke** session FID (``fid``), which must
        equal the upstream host FID; it is also stashed in
        ``metadata_["farcaster_host_fid"]`` for non-host readers
        (developer API, recording agent).

        No LiveKit resources are allocated. No announcement cast is
        posted (the upstream Farcaster client owns that surface).

        SECURITY: the upstream room is fetched and its host must be the
        caller's verified fid. Title / schedule come from upstream, not
        the request body, so a caller can't claim (or retitle) a space
        they don't host. A duplicate ``farcaster_room_id`` returns the
        existing row — re-attributed to the verified host if an earlier
        (pre-fix) claimant planted it.
        """
        host = await self._get_user(fid)

        # The router already gates on ``user.farcaster_sync_enabled``,
        # but re-check here so a future internal caller can't skip
        # that guard.
        if not host.farcaster_sync_enabled or host.farcaster_fid is None:
            raise HTTPException(
                status_code=403,
                detail="Farcaster sync not enabled",
            )

        upstream = await self._fetch_upstream_room_or_raise(farcaster_room_id)
        if upstream.host.fid != fid:
            raise HTTPException(
                status_code=403,
                detail="You are not the host of this Farcaster space",
            )
        if upstream.state == "ended":
            raise HTTPException(
                status_code=409,
                detail="This Farcaster space has already ended",
            )

        title = upstream.title or title
        description = upstream.description or description
        if upstream.state == "scheduled":
            scheduled_at = upstream.scheduled_at or scheduled_at
            if scheduled_at is not None and scheduled_at.tzinfo is None:
                scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        else:
            scheduled_at = None

        existing_row = await self._get_native_room_by_farcaster_id(farcaster_room_id)
        if existing_row is not None:
            return await self._claim_existing_native_room(existing_row, host)

        room = Room(
            title=title,
            host_fid=fid,
            status="scheduled" if scheduled_at is not None else "active",
            scheduled_at=scheduled_at,
            started_at=None if scheduled_at is not None else _utcnow(),
            livekit_room_id=None,
            # Native rooms can't host agents — there's no Juke LiveKit
            # room for them to dial into.
            allow_agents=False,
            # Native rooms can record via the Phase-4 recording-agent
            # dispatcher (see ``_start_native_recording``); we start
            # the row at ``recording=False`` and let the host opt in.
            recording=False,
            is_farcaster_native=True,
            farcaster_room_id=farcaster_room_id,
            metadata_=self._build_native_metadata(
                farcaster_host_fid=upstream.host.fid,
                description=description,
            ),
        )
        self.db.add(room)
        try:
            await self.db.commit()
        except IntegrityError:
            # Lost a race on the unique ``farcaster_room_id`` index.
            await self.db.rollback()
            existing_row = await self._get_native_room_by_farcaster_id(
                farcaster_room_id
            )
            if existing_row is None:
                raise
            # rollback() expires every loaded instance; reload ``host`` so
            # building the response doesn't lazy-load under asyncio.
            host = await self._get_user(fid)
            return await self._claim_existing_native_room(existing_row, host)
        await self.db.refresh(room)

        # Discovery clients (mobile, partner SDKs) subscribe to the
        # global discovery stream; publish the same event a hosted
        # room would so native rooms surface alongside them.
        reason = "room_scheduled" if scheduled_at is not None else "room_started"
        await self.redis.publish_room_discovery_event(
            _room_discovery_event(_room_id_str(room.id), reason, room.status)
        )

        # Debug-level on purpose: the upstream UUID is high-cardinality
        # and emitting it on every link request would dominate the log
        # signal without buying anything operational.
        logger.debug(
            "Linked Farcaster-native room for fid=%s (status=%s)",
            fid,
            room.status,
        )

        return await self._build_room_response(room, host, 0, 0)

    @staticmethod
    def _build_native_metadata(
        *, farcaster_host_fid: int, description: str | None
    ) -> dict:
        """Build the ``metadata_`` payload for a native room row.

        Always records the upstream Warpcast FID so non-host readers
        (developer API, recording agent) don't need to join back to
        ``users.farcaster_fid`` of the Juke ``host_fid``.
        """
        meta: dict = {"farcaster_host_fid": farcaster_host_fid}
        if description:
            meta["description"] = description
        return meta

    async def start_scheduled_room(self, room_id: str, fid: int) -> RoomGoLiveResponse:
        """
        Transition a scheduled room to active. Only the host may call this.

        Creates LiveKit room, seeds Redis, registers host as first participant,
        and returns a LiveKit token so the host can connect.
        """
        room = await self._get_room_or_404(room_id)

        if room.is_farcaster_native:
            # Native rooms have no Juke LiveKit room to allocate — going
            # live means flipping the upstream Farcaster room via
            # ``POST /v1/rooms/{id}/native-start``. Reject here so an old
            # client can't drive this path into creating an orphaned Juke
            # LiveKit room + token the host would never actually use.
            raise HTTPException(
                status_code=400,
                detail=(
                    "Farcaster-native rooms go live via "
                    "POST /v1/rooms/{id}/native-start"
                ),
            )

        if room.host_fid != fid:
            raise HTTPException(
                status_code=403, detail="Only the host can start a scheduled room"
            )

        host = await self._get_user(fid)

        # Atomic transition: claim the room before allocating LiveKit resources
        # (prevents orphaned LiveKit rooms on concurrent double-start)
        now = _utcnow()
        result = await self.db.execute(
            update(Room)
            .where(Room.id == room.id, Room.status == "scheduled")
            .values(status="active", started_at=now, livekit_room_id=room_id)
        )
        if result.rowcount == 0:
            raise HTTPException(
                status_code=400, detail="Room is not in scheduled state"
            )
        await self.db.commit()
        await self.db.refresh(room)

        # Create LiveKit room (roll back DB transition on failure)
        try:
            await self.livekit.create_room(room_id=room_id, title=room.title)
        except Exception as exc:
            logger.exception(
                "LiveKit room creation failed for scheduled room %s", room_id
            )
            await self.db.execute(
                update(Room)
                .where(Room.id == room.id)
                .values(status="scheduled", started_at=None, livekit_room_id=None)
            )
            await self.db.commit()
            raise HTTPException(
                status_code=502, detail="Failed to create media room"
            ) from exc

        # Seed Redis state
        started_ts = now.timestamp()
        await self.redis.set_room_state(
            room_id,
            {
                "id": room_id,
                "title": room.title,
                "host_fid": fid,
                "status": "active",
                "started_at": started_ts,
            },
        )
        await self.redis.add_active_room(room_id, started_ts)

        # Add host as first participant
        host_participant_data = {
            "fid": fid,
            "role": "host",
            "is_muted": False,
            "hand_raised": False,
            "display_name": host.display_name or host.username or str(fid),
            "pfp_url": host.pfp_url,
        }
        await self.redis.set_participant(room_id, fid, host_participant_data)
        await self.redis.set_user_active_room(fid, room_id)

        participant = Participant(room_id=room.id, fid=fid, role="host", is_muted=False)
        self.db.add(participant)
        await self.db.commit()

        token = self.livekit.generate_token(
            room_id=room_id,
            fid=fid,
            display_name=host_participant_data["display_name"],
            role="host",
            pfp_url=host.pfp_url,
        )

        room_response = await self._build_room_response(room, host, 1, 0)

        # Notify RSVP'd users
        try:
            await self.push.notify_space_started_rsvps(
                room_id=str(room.id),
                room_uuid=room.id,
                title=room.title,
                host_fid=fid,
            )
        except Exception:
            logger.exception("Failed to send RSVP go-live pushes for room %s", room_id)
            pass  # don't block go-live

        # A scheduled room's announcement cast predates go-live.
        if room.cast_hash:
            self._sync_room_reply_webhook()
        await self.redis.publish_room_discovery_event(
            _room_discovery_event(room_id, "room_started", "active")
        )
        await dispatch_dev_webhook(
            self.db,
            app_id=room.created_by_app_id,
            event_type="room.started",
            data={
                "room_id": room_id,
                "title": room.title,
                "host_fid": fid,
                "started_at": now.isoformat(),
                "scheduled_at": (
                    room.scheduled_at.isoformat() if room.scheduled_at else None
                ),
            },
        )
        logger.info("Scheduled room %s started by fid=%s", room_id, fid)
        return RoomGoLiveResponse(
            room=room_response,
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
            expires_at=_livekit_expires_at(),
        )

    async def get_room(
        self, room_id: str, current_fid: int | None = None
    ) -> RoomDetailResponse:
        """
        Fetch room details including live participant list and hand queue from Redis.
        Scheduled rooms return empty participants (no Redis state yet).
        """
        room = await self._get_room_or_404(room_id)
        host = await self._get_user(room.host_fid)

        # Scheduled rooms have no Redis state — return empty lists.
        # Auto-expire if the scheduled time has passed by more than 1 hour.
        if room.status == "scheduled":
            if room.scheduled_at and room.scheduled_at < _utcnow() - timedelta(hours=1):
                await self.db.execute(
                    update(Room)
                    .where(Room.id == room.id, Room.status == "scheduled")
                    .values(status="cancelled", ended_at=_utcnow())
                )
                await self.db.commit()
                await self.db.refresh(room)
            rsvp_summary = await self._get_rsvp_summary(room.id, current_fid)
            room_response = await self._build_room_response(
                room, host, 0, 0, rsvp_summary=rsvp_summary
            )
            return RoomDetailResponse(
                room=room_response, participants=[], hand_queue=[]
            )

        participants_data = await self.redis.get_all_participants(room_id)
        hand_queue = await self.redis.get_hand_queue(room_id)

        speaker_count, listener_count = await self._count_participants(
            room_id, participants_data
        )

        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        participants = self._build_participant_responses(participants_data)

        return RoomDetailResponse(
            room=room_response,
            participants=participants,
            hand_queue=hand_queue,
        )

    async def ensure_chat_target(self, room_id: str, fid: int) -> RoomResponse:
        """
        Ensure an active room has a Farcaster cast hash that can act as the
        FIP-2 chat target. If the host did not announce the room, create a
        fallback cast from the configured @jukeaudio signer.
        """
        room = await self._get_room_or_404(room_id)

        if room.status != "active":
            raise HTTPException(
                status_code=400,
                detail="Chat is only available for active rooms",
            )

        await self._get_participant_or_403(room_id, fid)

        host = await self._get_user(room.host_fid)
        if room.cast_hash:
            speaker_count, listener_count = await self._get_live_counts(room_id)
            return await self._build_room_response(
                room, host, speaker_count, listener_count
            )

        if not farcaster_writes.is_system_signer_configured():
            raise HTTPException(
                status_code=503,
                detail="System chat signer is not configured",
            )

        # Lock before the external submit so concurrent clients don't
        # create duplicate fallback casts for the same room.
        locked_result = await self.db.execute(
            select(Room).where(Room.id == room.id).with_for_update()
        )
        room = locked_result.scalar_one()
        if room.status != "active":
            raise HTTPException(
                status_code=400,
                detail="Chat is only available for active rooms",
            )
        if room.cast_hash:
            await self.db.commit()
            speaker_count, listener_count = await self._get_live_counts(room_id)
            return await self._build_room_response(
                room, host, speaker_count, listener_count
            )

        cast_hash = await self._create_system_chat_cast(room_id, room.title, host)

        room.cast_hash = cast_hash
        await self.db.commit()
        await self.db.refresh(room)
        self._sync_room_reply_webhook()

        speaker_count, listener_count = await self._get_live_counts(room_id)
        return await self._build_room_response(
            room, host, speaker_count, listener_count
        )

    async def list_scheduled_rooms(
        self,
        limit: int = 20,
        cursor: int = 0,
        current_fid: int | None = None,
    ) -> RoomListResponse:
        """Return upcoming scheduled rooms ordered by scheduled_at ASC."""
        now = _utcnow()
        blocked_fids = (
            await get_blocked_fids(self.db, current_fid) if current_fid else set()
        )
        query = (
            select(Room)
            .where(Room.status == "scheduled", Room.scheduled_at >= now)
            .order_by(Room.scheduled_at.asc())
            .offset(cursor)
            .limit(limit + 1)
        )
        if blocked_fids:
            query = query.where(Room.host_fid.not_in(blocked_fids))
        result = await self.db.execute(query)
        rows = list(result.scalars().all())

        has_more = len(rows) > limit
        page = rows[:limit]

        # Batch-fetch RSVP counts for all rooms on this page
        count_map: dict[uuid.UUID, int] = {}
        hosts_by_fid: dict[int, User] = {}
        if page:
            room_ids = [r.id for r in page]
            counts = await self.db.execute(
                select(RoomRsvp.room_id, sa_func.count(RoomRsvp.id))
                .where(RoomRsvp.room_id.in_(room_ids))
                .group_by(RoomRsvp.room_id)
            )
            count_map = dict(counts.all())
            host_fids = list({room.host_fid for room in page})
            host_rows = await self.db.execute(
                select(User).where(User.fid.in_(host_fids))
            )
            hosts_by_fid = {user.fid: user for user in host_rows.scalars().all()}

        rooms: list[RoomResponse] = []
        for room in page:
            host = hosts_by_fid.get(room.host_fid)
            if host is None:
                raise HTTPException(
                    status_code=404, detail=f"User with fid={room.host_fid} not found"
                )
            rsvp_count = count_map.get(room.id, 0)
            rsvp_summary = RsvpSummary(count=rsvp_count)
            rooms.append(
                await self._build_room_response(
                    room, host, 0, 0, rsvp_summary=rsvp_summary
                )
            )

        next_cursor = str(cursor + limit) if has_more else None
        return RoomListResponse(rooms=rooms, next_cursor=next_cursor)

    async def list_active_rooms(
        self,
        limit: int = 20,
        cursor: int = 0,
        current_fid: int | None = None,
    ) -> RoomListResponse:
        """
        Return paginated active rooms sorted by recency (newest first).

        `cursor` is a zero-based offset into the Redis sorted set.
        """
        room_id_strs = await self.redis.get_active_rooms(limit=limit + 1, offset=cursor)

        has_more = len(room_id_strs) > limit
        page_ids = room_id_strs[:limit]

        blocked_fids = (
            await get_blocked_fids(self.db, current_fid) if current_fid else set()
        )

        # Batch-fetch rooms from Postgres
        uuids = []
        for rid in page_ids:
            try:
                uuids.append(uuid.UUID(rid))
            except ValueError:
                logger.warning(
                    "Skipping malformed room_id in active_rooms set: %s", rid
                )

        result = await self.db.execute(select(Room).where(Room.id.in_(uuids)))
        rooms_by_id: dict[str, Room] = {
            _room_id_str(r.id): r for r in result.scalars().all()
        }
        ordered_rooms = [
            rooms_by_id[rid]
            for rid in page_ids
            if rid in rooms_by_id and rooms_by_id[rid].host_fid not in blocked_fids
        ]
        host_fids = list({room.host_fid for room in ordered_rooms})
        host_rows = await self.db.execute(select(User).where(User.fid.in_(host_fids)))
        hosts_by_fid: dict[int, User] = {
            user.fid: user for user in host_rows.scalars().all()
        }
        count_map = await self.redis.get_room_participant_counts(page_ids)

        # Preserve Redis ordering
        rooms = []
        for rid in page_ids:
            room = rooms_by_id.get(rid)
            if room is None:
                # Stale entry — clean up asynchronously (fire-and-forget is fine here)
                logger.warning("Room %s in Redis active set but missing from DB", rid)
                continue
            if room.host_fid in blocked_fids:
                continue
            host = hosts_by_fid.get(room.host_fid)
            if host is None:
                raise HTTPException(
                    status_code=404, detail=f"User with fid={room.host_fid} not found"
                )
            speaker_count, listener_count = count_map.get(rid, (0, 0))
            listener_count += await self._get_anonymous_listener_count(rid)
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            rooms.append(room_response)

        next_cursor = str(cursor + limit) if has_more else None

        # Union in DB-authoritative native active rooms. A native ``Room``
        # row can be genuinely ``status='active'`` yet absent from the Redis
        # active set because ``create_native_room``'s ``redis.add_active_room``
        # is best-effort — a miss is swallowed and would otherwise make the
        # room invisible to ``/v1/rooms?status=active``. The DB is the source
        # of truth for native actives, so surface any the Redis page missed.
        #
        # Pagination contract: we only merge on the FIRST page (cursor == 0),
        # appending DB-only natives (newest ``started_at`` first) AFTER the
        # Redis-ordered rooms and only up to ``limit``. Subsequent pages keep
        # paging off the Redis set, so ``next_cursor`` is unchanged. A DB-only
        # native that doesn't fit the first page's remaining slots won't
        # appear until the next reconciler pass / create re-adds it to Redis —
        # acceptable for the discovery rail and self-healing.
        if cursor == 0 and len(rooms) < limit:
            await self._append_db_native_actives(
                rooms=rooms,
                seen_ids=set(page_ids),
                blocked_fids=blocked_fids,
                limit=limit,
            )

        return RoomListResponse(rooms=rooms, next_cursor=next_cursor)

    async def _append_db_native_actives(
        self,
        *,
        rooms: list[RoomResponse],
        seen_ids: set[str],
        blocked_fids: set[int],
        limit: int,
    ) -> None:
        """Append DB-authoritative native active rooms not already present.

        Mutates ``rooms`` in place. Fetches native rooms flagged
        ``is_farcaster_native AND status='active'``, skips any already in
        ``seen_ids`` or hosted by a blocked FID, and builds responses using
        the same participant-count + host-lookup logic as the Redis path.
        Fills only up to ``limit`` total rooms.
        """
        remaining = limit - len(rooms)
        if remaining <= 0:
            return

        # Bound the read at the SQL layer — never materialize the full
        # native-active table. We may discard up to ``len(seen_ids)`` rows
        # already present in the Redis page, so fetch that many extra
        # beyond ``remaining`` to still be able to fill the page.
        fetch_cap = remaining + len(seen_ids)
        result = await self.db.execute(
            select(Room)
            .where(
                Room.is_farcaster_native.is_(True),
                Room.status == "active",
            )
            .order_by(Room.started_at.desc())
            .limit(fetch_cap)
        )
        extra_rooms: list[Room] = []
        for room in result.scalars().all():
            rid = _room_id_str(room.id)
            if rid in seen_ids or room.host_fid in blocked_fids:
                continue
            extra_rooms.append(room)
            if len(extra_rooms) >= remaining:
                break

        if not extra_rooms:
            return

        extra_host_fids = list({room.host_fid for room in extra_rooms})
        host_rows = await self.db.execute(
            select(User).where(User.fid.in_(extra_host_fids))
        )
        hosts_by_fid: dict[int, User] = {
            user.fid: user for user in host_rows.scalars().all()
        }
        extra_ids = [_room_id_str(room.id) for room in extra_rooms]
        count_map = await self.redis.get_room_participant_counts(extra_ids)

        for room in extra_rooms:
            rid = _room_id_str(room.id)
            host = hosts_by_fid.get(room.host_fid)
            if host is None:
                raise HTTPException(
                    status_code=404, detail=f"User with fid={room.host_fid} not found"
                )
            speaker_count, listener_count = count_map.get(rid, (0, 0))
            listener_count += await self._get_anonymous_listener_count(rid)
            rooms.append(
                await self._build_room_response(
                    room, host, speaker_count, listener_count
                )
            )

    async def register_rsvp(self, room_id: str, fid: int) -> RsvpResponse:
        """RSVP to a scheduled room. Idempotent (uses INSERT ON CONFLICT DO NOTHING)."""
        room = await self._get_room_or_404(room_id)
        if room.status != "scheduled":
            raise HTTPException(
                status_code=400, detail="RSVPs are only available for scheduled rooms"
            )
        if await is_blocked(self.db, blocker_fid=room.host_fid, blocked_fid=fid):
            raise HTTPException(status_code=403, detail="You cannot RSVP to this room")

        stmt = (
            pg_insert(RoomRsvp)
            .values(room_id=room.id, fid=fid)
            .on_conflict_do_nothing(constraint="uq_room_rsvps_room_fid")
        )
        await self.db.execute(stmt)
        await self.db.commit()
        await self.redis.publish_room_discovery_event(
            _room_discovery_event(room_id, "rsvp_updated", "scheduled")
        )
        return RsvpResponse(status="going")

    async def unregister_rsvp(self, room_id: str, fid: int) -> RsvpResponse:
        """Remove an RSVP from a scheduled room."""
        room = await self._get_room_or_404(room_id)
        if room.status != "scheduled":
            raise HTTPException(
                status_code=400, detail="RSVPs can only be removed from scheduled rooms"
            )
        await self.db.execute(
            delete(RoomRsvp).where(RoomRsvp.room_id == room.id, RoomRsvp.fid == fid)
        )
        await self.db.commit()
        await self.redis.publish_room_discovery_event(
            _room_discovery_event(room_id, "rsvp_updated", "scheduled")
        )
        return RsvpResponse(status="removed")

    # -----------------------------------------------------------------------
    # Recording
    # -----------------------------------------------------------------------

    # Recording rate-limit & duration-cap knobs. Tuned for hostile-host
    # scenarios (spammy toggling, eating egress budget / S3 spend).
    _RECORDING_RATE_LIMIT_PER_HOUR = 10
    _RECORDING_RATE_LIMIT_WINDOW_SEC = 3600
    _RECORDING_DAILY_CAP_SECONDS = 6 * 60 * 60  # 6 hours per room per UTC day

    async def _enforce_recording_rate_limit(self, fid: int) -> None:
        """Cap how many start/stop toggles a single fid can run in an hour.

        Sliding hourly bucket via ``INCR`` + ``EXPIRE``. The bucket resets
        on the hour (wall-clock, not last-write) which is imprecise but
        deliberate — exact accuracy isn't the point; stopping a runaway
        host from burning our egress budget is.
        """
        key = f"recording:ratelimit:fid:{fid}"
        count = await self.redis.redis.incr(key)
        if count == 1:
            await self.redis.redis.expire(key, self._RECORDING_RATE_LIMIT_WINDOW_SEC)
        if count > self._RECORDING_RATE_LIMIT_PER_HOUR:
            raise HTTPException(
                status_code=429,
                detail="Recording rate limit exceeded (max "
                f"{self._RECORDING_RATE_LIMIT_PER_HOUR} ops/hour)",
            )

    def _recording_duration_key(self, room_id: str) -> str:
        day = _utcnow().strftime("%Y%m%d")
        return f"recording:duration:room:{room_id}:{day}"

    async def _assert_recording_duration_under_cap(self, room_id: str) -> None:
        """Reject a new recording if today's accumulated duration is maxed.

        Counter is updated on stop (see ``_stop_egress_for_room``) so this
        is eventually-consistent — still enough to stop runaway spend from
        compounding across many short sessions in a single day.
        """
        key = self._recording_duration_key(room_id)
        current_raw = await self.redis.redis.get(key)
        current = int(current_raw) if current_raw else 0
        if current >= self._RECORDING_DAILY_CAP_SECONDS:
            raise HTTPException(
                status_code=429,
                detail="Daily recording cap reached for this room",
            )

    async def start_recording(self, room_id: str, fid: int) -> dict:
        """Start a room-composite egress to S3. Host/co-host only.

        Stores the resulting ``egress_id`` in Redis keyed by room so
        ``stop_recording`` can later find it. Sets ``rooms.recording = True``
        and publishes a ``recording_started`` event; the
        ``recording_url`` is only populated once the LiveKit ``egress_ended``
        webhook fires.

        Guards:
          * Per-fid hourly rate limit (prevents spammy toggling).
          * Per-room daily duration cap (prevents runaway S3 spend).
          * Redis ``SET NX`` on the egress_id key (prevents concurrent
            starts from two host devices).
          * DB row lock via ``SELECT ... FOR UPDATE`` before flipping
            ``recording`` (prevents duplicate egress rows).
        """
        # Cheap checks first so we don't hit LiveKit for a request we'll reject.
        room = await self._get_room_or_404(room_id)

        # Phase 4 part 1: native-room recording dispatches a Juke-owned
        # recording-agent FID into the upstream Farcaster LiveKit room.
        # The agent joins as a passive listener and writes mixed audio
        # to S3. The non-native (Juke-hosted) path continues to use
        # LiveKit room-composite egress below.
        if room.is_farcaster_native:
            return await self._start_native_recording(room, fid)

        if room.status != "active":
            raise HTTPException(status_code=400, detail="Room is not active")

        actor_role = await self._get_actor_role(room_id, fid)
        if actor_role not in ("host", "co_host"):
            raise HTTPException(
                status_code=403,
                detail="Only hosts and co-hosts can start recording",
            )

        await self._enforce_recording_rate_limit(fid)
        await self._assert_recording_duration_under_cap(room_id)

        # Lock the room row for the flip-and-publish block so two concurrent
        # start_recording calls serialize through Postgres. The Redis SET NX
        # below is still the primary race guard (it catches the case where
        # a prior egress is mid-flight but rooms.recording hasn't been
        # updated yet), but the row lock keeps DB state consistent too.
        locked = await self.db.execute(
            select(Room).where(Room.id == room.id).with_for_update()
        )
        room = locked.scalar_one()

        if room.recording:
            raise HTTPException(
                status_code=409,
                detail="Recording is already in progress",
            )

        try:
            egress_id = await self.livekit.start_room_composite_egress(room_id)
        except Exception as exc:
            logger.exception("LiveKit start egress failed for room %s", room_id)
            await self.db.rollback()
            raise HTTPException(
                status_code=502,
                detail="Failed to start recording via media server",
            ) from exc

        # Redis TTL: 6h — long enough to outlast any reasonable room while
        # preventing orphaned keys.
        # SET NX so a second concurrent caller can't overwrite a live
        # egress_id mid-race (e.g. two host devices hitting start together).
        key = f"room:{room_id}:egress_id"
        stored = await self.redis.redis.set(
            key,
            egress_id,
            ex=6 * 60 * 60,
            nx=True,
        )
        if not stored:
            # Someone else claimed the slot before we did. Stop the egress
            # we just started (otherwise it'd run orphaned) and surface 409.
            logger.warning(
                "Concurrent start_recording race for room %s — aborting our "
                "egress (id=%s...)",
                room_id,
                egress_id[:8] if egress_id else "?",
            )
            try:
                await self.livekit.stop_egress(egress_id)
            except Exception:
                logger.exception(
                    "Failed to stop racing egress %s for room %s",
                    egress_id,
                    room_id,
                )
            await self.db.rollback()
            raise HTTPException(
                status_code=409,
                detail="Recording is already in progress",
            )

        await self.db.execute(
            update(Room).where(Room.id == room.id).values(recording=True)
        )
        # Track the start time for duration accounting at stop.
        await self.redis.redis.set(
            f"room:{room_id}:egress_started_at",
            int(_utcnow().timestamp()),
            ex=6 * 60 * 60,
        )
        await self.db.commit()

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "recording_started",
                "room_id": room_id,
                "by_fid": fid,
            },
        )

        # Broadcast to all connected participants via LiveKit data channel so
        # every client can render the "REC" indicator in real time (consent UX).
        await self._broadcast_recording_state(room_id, True)

        logger.info(
            "Recording started for room %s by fid=%s (egress_id=%s...)",
            room_id,
            fid,
            egress_id[:8] if egress_id else "?",
        )
        return {"egress_id": egress_id, "status": "recording"}

    async def stop_recording(self, room_id: str, fid: int) -> dict:
        """Stop the active egress. Host/co-host only.

        Leaves ``rooms.recording = True`` until the LiveKit ``egress_ended``
        webhook fires with the final file URL, at which point the webhook
        flips ``recording`` back to False and populates ``recording_url``.
        """
        room = await self._get_room_or_404(room_id)

        # Phase 4 part 1: native-room recording uses an out-of-process
        # recording agent rather than the LiveKit egress path. The
        # Juke-hosted (non-native) branch below is unchanged.
        if room.is_farcaster_native:
            return await self._stop_native_recording(room, fid)

        actor_role = await self._get_actor_role(room_id, fid)
        if actor_role not in ("host", "co_host"):
            raise HTTPException(
                status_code=403,
                detail="Only hosts and co-hosts can stop recording",
            )

        if not room.recording:
            raise HTTPException(
                status_code=409,
                detail="Recording is not active",
            )

        await self._enforce_recording_rate_limit(fid)

        await self._stop_egress_for_room(room_id, fid, publish_event=True)
        return {"status": "stopping"}

    # ------------------------------------------------------------------
    # Phase 4 part 1 — native-room recording via out-of-process agent
    # ------------------------------------------------------------------

    def _assert_native_recording_host(self, room: Room, fid: int) -> None:
        """Authorize a native-room recording request.

        We can't reuse :py:meth:`_get_actor_role` here — it reads from
        the Redis participant cache populated by Juke's ``/join``, but
        native rooms never go through that endpoint (participants live
        on Farcaster's LiveKit project). So the cache is empty and the
        check always 403s with "not an active participant", even for
        the host.

        Native co-hosts also live upstream and aren't visible to Juke,
        so the only role we can verify is host == ``room.host_fid``.
        That's the host the create flow recorded; for mirrored rooms
        it's the upstream host. Co-host recording on native rooms is a
        deliberate non-feature until upstream exposes a participant
        list we can authoritatively check against.
        """
        if room.host_fid != fid:
            raise HTTPException(
                status_code=403,
                detail="Only the host can record this space",
            )

    async def _start_native_recording(self, room: Room, fid: int) -> dict:
        """Dispatch a Juke recording-agent FID into the upstream
        Farcaster-native LiveKit room.

        Flow:
          1. Reserve an agent FID from
             ``FarcasterSpacesService.pick_available_recording_agent``.
          2. Mint a join token via the agent's bearer + upstream
             ``POST /v1/audio-room/join``.
          3. Hand signaling-url + token to
             ``RecordingAgentService.start_recording`` (spawns Node
             worker).
          4. Persist ``recording_id`` + ``recording_agent_fid`` on the
             room row (in ``metadata_``) and flip ``recording = True``.

        Failures release the reserved agent before raising so a single
        bad mint can't permanently sideline the agent pool.

        Permission contract mirrors the egress path: host + co-host
        only. Recording rate-limits also apply equally.
        """
        if self.farcaster_spaces is None or self.recording_agent is None:
            raise HTTPException(
                status_code=503,
                detail="Recording-agent infrastructure not configured",
            )

        if room.status != "active":
            raise HTTPException(status_code=400, detail="Room is not active")

        room_id = _room_id_str(room.id)
        self._assert_native_recording_host(room, fid)

        await self._enforce_recording_rate_limit(fid)
        await self._assert_recording_duration_under_cap(room_id)

        if not room.farcaster_room_id:
            # Defensive: a row marked is_farcaster_native MUST have the
            # upstream id. Treat the inconsistency as a config error.
            raise HTTPException(
                status_code=500,
                detail="Native room missing farcaster_room_id",
            )

        # Reconcile upstream state. The host may have ended the room
        # from the Farcaster app (or another Juke device) — upstream
        # cleared it, but Juke's row stays `active` because we never
        # observed the end. Without this check, the recording agent
        # would try to join an ended upstream room, upstream would 4xx
        # the join, and we'd surface a generic 502 to the user. Peek
        # upstream first; if the room is gone or ended, mark our row
        # ended and return a clean 409 the iOS client can interpret.
        try:
            upstream_snapshot = await self.farcaster_spaces.get_room(
                room.farcaster_room_id
            )
        except FarcasterSpacesConfigError as exc:
            raise HTTPException(
                status_code=503,
                detail="Farcaster spaces service unavailable",
            ) from exc
        except Exception as exc:
            # Best-effort reconciliation. If upstream is flaky on the
            # peek, fall through and let the agent-join path discover
            # any real problem — better to attempt recording than to
            # block on a transient upstream blip.
            logger.warning(
                "[native-recording] upstream peek failed (room=%s err=%s) — "
                "proceeding optimistically",
                room_id,
                type(exc).__name__,
            )
            upstream_snapshot = "unknown"
        if upstream_snapshot is None or (
            hasattr(upstream_snapshot, "state")
            and getattr(upstream_snapshot, "state", None) in ("ended", "cancelled")
        ):
            # Upstream is gone — reconcile our row so the rail, end-
            # space CTA, and player all reflect reality.
            now = _utcnow()
            await self.db.execute(
                update(Room)
                .where(Room.id == room.id)
                .values(status="ended", ended_at=now)
            )
            await self.db.commit()
            raise HTTPException(
                status_code=409,
                detail="This space has already ended on Farcaster.",
            )

        # Lock + reread under the same transaction so two concurrent
        # callers can't both flip ``recording = True``.
        locked = await self.db.execute(
            select(Room).where(Room.id == room.id).with_for_update()
        )
        room = locked.scalar_one()
        if room.recording:
            raise HTTPException(
                status_code=409,
                detail="Recording is already in progress",
            )

        try:
            picked = await self.farcaster_spaces.pick_available_recording_agent()
        except FarcasterSpacesConfigError as exc:
            raise HTTPException(
                status_code=503,
                detail="No recording agents available",
            ) from exc
        if picked is None:
            raise HTTPException(
                status_code=503,
                detail="No recording agents available",
            )
        agent_fid, agent_bearer = picked

        try:
            join_result = await self.farcaster_spaces.join_room_as_listener(
                room_id=room.farcaster_room_id,
                bearer=agent_bearer,
            )
        except Exception as exc:
            logger.warning(
                "[native-recording] join_room_as_listener failed for "
                "room=%s agent_fid=%s err=%s",
                room_id,
                agent_fid,
                type(exc).__name__,
            )
            await self.farcaster_spaces.release_recording_agent(agent_fid)
            await self.db.rollback()
            # Race: room ended upstream between our peek and the agent
            # join. Surface the same 409 as the pre-flight check so the
            # iOS error UX is consistent.
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code is not None and 400 <= int(status_code) < 500:
                # Reconcile our row — upstream told us the room is gone.
                now = _utcnow()
                await self.db.execute(
                    update(Room)
                    .where(Room.id == room.id)
                    .values(status="ended", ended_at=now)
                )
                await self.db.commit()
                raise HTTPException(
                    status_code=409,
                    detail="This space has already ended on Farcaster.",
                ) from exc
            raise HTTPException(
                status_code=502,
                detail="Failed to join Farcaster room as recording agent",
            ) from exc

        signaling_url = join_result.get("wsUrl") or join_result.get("url")
        token = join_result.get("token")
        if not isinstance(signaling_url, str) or not isinstance(token, str):
            await self.farcaster_spaces.release_recording_agent(agent_fid)
            await self.db.rollback()
            raise HTTPException(
                status_code=502,
                detail="Upstream join response missing wsUrl/token",
            )

        # S3 target — match the existing recording path's prefix so
        # retention cleanup + presigning helpers all keep working.
        s3_target = f"recordings/{room_id}/native-{int(_utcnow().timestamp())}.ogg"

        try:
            recording_id = await self.recording_agent.start_recording(
                room_id=room_id,
                signaling_url=signaling_url,
                token=token,
                s3_target=s3_target,
            )
        except RecordingAgentError as exc:
            logger.warning(
                "[native-recording] worker spawn failed for room=%s "
                "agent_fid=%s err=%s",
                room_id,
                agent_fid,
                exc,
            )
            await self.farcaster_spaces.release_recording_agent(agent_fid)
            await self.db.rollback()
            raise HTTPException(
                status_code=502,
                detail="Failed to start recording-agent worker",
            ) from exc

        # Persist state. metadata_ is a JSON column — copy then
        # reassign so SQLAlchemy detects the change on a mutable dict.
        # The ``recording_agent_fid`` lives in metadata_ so the stop
        # path can release the agent; ``recording_id`` gets its own
        # typed column for ops queries.
        new_meta = dict(room.metadata_ or {})
        new_meta["recording_agent_fid"] = agent_fid
        new_meta["recording_s3_target"] = s3_target
        # Capture the recording-segment start so the stop path can set
        # the corresponding ``recordings.started_at``. ``rooms.started_at``
        # is when the SPACE started — not when this segment started, and
        # a host can record multiple segments per space.
        new_meta["recording_started_at"] = _utcnow().isoformat()

        await self.db.execute(
            update(Room)
            .where(Room.id == room.id)
            .values(
                recording=True,
                recording_id=recording_id,
                metadata_=new_meta,
            )
        )
        await self.redis.redis.set(
            f"room:{room_id}:native_recording_started_at",
            int(_utcnow().timestamp()),
            ex=6 * 60 * 60,
        )
        await self.db.commit()

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "recording_started",
                "room_id": room_id,
                "by_fid": fid,
            },
        )

        logger.info(
            "Native recording started for room %s by fid=%s (agent_fid=%s "
            "recording_id=%s...)",
            room_id,
            fid,
            agent_fid,
            recording_id[:8] if recording_id else "?",
        )
        return {
            "recording_id": recording_id,
            "status": "recording",
        }

    def _recover_recording_url_from_s3(
        self, room_id: str, s3_key: str | None
    ) -> str | None:
        """Best-effort recovery of a native recording the worker already
        uploaded but we never recorded the URL for.

        Returns a canonical object URL when an object exists at ``s3_key``,
        else ``None``. Never raises — S3 misconfig or a missing object
        just means "nothing to recover."
        """
        if not isinstance(s3_key, str) or not s3_key:
            return None
        try:
            from app.services.storage_service import StorageService

            storage = StorageService()
            # First: did the worker self-finalize (graceful disconnect) and
            # leave a complete object? Otherwise: did it crash mid-recording
            # and leave an incomplete multipart upload we can complete? Only
            # reached once the worker is confirmed gone, so completing its
            # upload can't race a live worker's own finalize.
            recovered = storage.object_exists(s3_key) or (
                storage.complete_orphaned_multipart_upload(s3_key)
                and storage.object_exists(s3_key)
            )
            if recovered:
                url = storage.build_object_url(s3_key)
                logger.info(
                    "[native-recording] recovered orphaned recording from S3 "
                    "for room=%s key=%s",
                    room_id,
                    s3_key,
                )
                return url
        except Exception as exc:  # noqa: BLE001 — recovery is best-effort
            logger.warning(
                "[native-recording] S3 recovery probe failed for room=%s "
                "key=%s err=%s",
                room_id,
                s3_key,
                type(exc).__name__,
            )
        return None

    async def _finalize_native_recording_stop(
        self, room: Room, recording_id: str, stopped_by_fid: int
    ) -> str | None:
        """Stop the recording-agent worker, persist the final S3 URL, and
        release the agent FID.  Shared by the host and admin stop paths.

        Returns the recording URL on success or ``None`` if the worker
        failed to finalise (caller decides whether to surface a 502).
        """
        room_id = _room_id_str(room.id)
        meta = dict(room.metadata_ or {})
        agent_fid = meta.get("recording_agent_fid")

        s3_key = meta.get("recording_s3_target")

        recording_url: str | None = None
        try:
            recording_url = await self.recording_agent.stop_recording(recording_id)
        except RecordingAgentError as exc:
            logger.warning(
                "[native-recording] worker stop failed for room=%s "
                "recording_id=%s err=%s",
                room_id,
                recording_id[:8],
                exc,
            )
            # The worker process is gone (backend redeploy, or it already
            # self-finalized + exited when the LiveKit room disconnected —
            # which is exactly what happens when a space ends on Farcaster's
            # side). On disconnect the worker flushes ffmpeg and PutObjects
            # the file to its deterministic ``s3_target`` BEFORE exiting, so
            # the audio is very often already in S3 — we just never recorded
            # the URL. Probe S3 and recover the file if it's there.
            recording_url = self._recover_recording_url_from_s3(room_id, s3_key)

        if isinstance(agent_fid, int):
            await self.farcaster_spaces.release_recording_agent(agent_fid)

        recording_started_at_raw = meta.get("recording_started_at")
        meta.pop("recording_agent_fid", None)
        meta.pop("recording_s3_target", None)
        meta.pop("recording_started_at", None)

        values: dict = {
            "recording": False,
            "recording_id": None,
            "metadata_": meta,
        }
        if recording_url:
            values["recording_url"] = recording_url
            if isinstance(s3_key, str) and s3_key:
                values["recording_key"] = s3_key
        result = await self.db.execute(
            update(Room)
            .where(Room.id == room.id, Room.recording_id == recording_id)
            .values(**values)
        )
        if result.rowcount == 0:
            logger.info(
                "[native-recording] stop skipped for room=%s recording_id=%s… "
                "(already stopped by a concurrent call)",
                room_id,
                recording_id[:8],
            )
            return None

        if recording_url:
            recording_started_at = _utcnow()
            if isinstance(recording_started_at_raw, str):
                try:
                    recording_started_at = datetime.fromisoformat(
                        recording_started_at_raw
                    )
                except ValueError:
                    pass
            recording_ended_at = _utcnow()
            duration = max(
                0,
                int((recording_ended_at - recording_started_at).total_seconds()),
            )
            self.db.add(
                Recording(
                    room_id=room.id,
                    source="native",
                    recording_url=recording_url,
                    s3_key=s3_key if isinstance(s3_key, str) else None,
                    started_at=recording_started_at,
                    ended_at=recording_ended_at,
                    duration_seconds=duration,
                    upstream_recording_id=recording_id,
                )
            )
        await self.db.commit()

        started_raw = await self.redis.redis.get(
            f"room:{room_id}:native_recording_started_at"
        )
        if started_raw:
            try:
                started_at = int(started_raw)
                elapsed = max(0, int(_utcnow().timestamp()) - started_at)
                if elapsed > 0:
                    dur_key = self._recording_duration_key(room_id)
                    await self.redis.redis.incrby(dur_key, elapsed)
                    await self.redis.redis.expire(dur_key, 25 * 60 * 60)
            except (ValueError, TypeError):
                pass
        await self.redis.redis.delete(f"room:{room_id}:native_recording_started_at")

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "recording_stopped",
                "room_id": room_id,
                "by_fid": stopped_by_fid,
            },
        )

        logger.info(
            "Native recording stopped for room %s by fid=%s "
            "(recording_id=%s... url=%s)",
            room_id,
            stopped_by_fid,
            recording_id[:8],
            "present" if recording_url else "missing",
        )

        return recording_url

    async def _stop_native_recording(self, room: Room, fid: int) -> dict:
        """Stop the recording-agent worker, persist the final S3 URL,
        and release the agent FID.

        Releases the agent FID even when the finalize errors out — a
        flaky worker must not sideline an agent forever.
        """
        if self.farcaster_spaces is None or self.recording_agent is None:
            raise HTTPException(
                status_code=503,
                detail="Recording-agent infrastructure not configured",
            )

        self._assert_native_recording_host(room, fid)

        if not room.recording:
            raise HTTPException(
                status_code=409,
                detail="Recording is not active",
            )

        await self._enforce_recording_rate_limit(fid)

        recording_id = room.recording_id
        if not isinstance(recording_id, str) or not recording_id:
            raise HTTPException(
                status_code=409,
                detail="No active recording-agent for this room",
            )

        recording_url = await self._finalize_native_recording_stop(
            room, recording_id, stopped_by_fid=fid
        )

        if recording_url is None:
            raise HTTPException(
                status_code=502,
                detail="Recording-agent worker failed to finalize",
            )
        return {"status": "stopped", "recording_url": recording_url}

    async def admin_stop_native_recording(self, room_id: str, admin_fid: int) -> dict:
        """Force-stop a native recording without host permission checks.

        Used by the LiveKit ``room_finished`` webhook (auto-stop when the
        upstream room closes) and the admin UI (manual recovery).  Skips
        the host FID check and recording rate-limit — those are caller
        concerns, not this method's.
        """
        if self.farcaster_spaces is None or self.recording_agent is None:
            raise HTTPException(
                status_code=503,
                detail="Recording-agent infrastructure not configured",
            )

        room = await self._get_room_or_404(room_id)

        if not room.is_farcaster_native:
            raise HTTPException(
                status_code=400,
                detail="Not a native Farcaster space",
            )

        if not room.recording:
            raise HTTPException(
                status_code=409,
                detail="Recording is not active",
            )

        recording_id = room.recording_id
        if not isinstance(recording_id, str) or not recording_id:
            raise HTTPException(
                status_code=409,
                detail="No active recording-agent for this room",
            )

        recording_url = await self._finalize_native_recording_stop(
            room, recording_id, stopped_by_fid=admin_fid
        )

        logger.info(
            "Admin stop native recording for room %s by admin_fid=%s "
            "(recording_url=%s)",
            room_id,
            admin_fid,
            "present" if recording_url else "missing",
        )

        # Unlike the host stop path, admin/system stops MUST NOT raise when
        # the worker can't finalize. This endpoint's primary job is to clear
        # a STUCK recording flag — most often because the worker process is
        # already gone (backend redeploy killed it, space ended on
        # Farcaster's side). ``_finalize_native_recording_stop`` has already
        # flipped ``recording=False`` and released the agent; surfacing a 502
        # here would leave the operator thinking the orphan is unresolved
        # when the DB state is, in fact, clean. Report the outcome instead.
        if recording_url is None:
            return {"status": "cleared", "recording_url": None}
        return {"status": "stopped", "recording_url": recording_url}

    async def _stop_egress_for_room(
        self, room_id: str, fid: int, publish_event: bool
    ) -> None:
        """Internal helper: look up egress_id in Redis, stop it, and publish.

        Tolerates a missing Redis key (e.g. after a restart) — in that case
        we can't stop the egress but we still want to publish the event so
        clients clear their UI.
        """
        egress_id = await self.redis.redis.get(f"room:{room_id}:egress_id")
        started_raw = await self.redis.redis.get(f"room:{room_id}:egress_started_at")

        if egress_id:
            try:
                await self.livekit.stop_egress(egress_id)
            except Exception as exc:
                # End Space immediately after Stop Recording races the
                # `egress_ended` webhook: LiveKit reports the egress as
                # already terminal (EGRESS_COMPLETE / EGRESS_ABORTED /
                # EGRESS_FAILED) and returns 412 failed_precondition.
                # That's benign — the egress is already done — so we log
                # at info level and let the webhook clean up state.
                msg = str(exc)
                if "cannot be stopped" in msg or "failed_precondition" in msg:
                    logger.info(
                        "Egress %s... for room %s already in terminal state; skipping stop",
                        egress_id[:8],
                        room_id,
                    )
                else:
                    logger.exception(
                        "LiveKit stop egress failed for room %s (egress_id=%s...)",
                        room_id,
                        egress_id[:8] if egress_id else "?",
                    )
        else:
            logger.warning(
                "No egress_id found in Redis for room %s during stop_recording",
                room_id,
            )

        # Accumulate runtime toward today's duration cap. We keep the
        # egress_id key around a little longer so the webhook can still
        # match on it — only the egress_id TTL matters for idempotency.
        if started_raw:
            try:
                started_at = int(started_raw)
                elapsed = max(0, int(_utcnow().timestamp()) - started_at)
                if elapsed > 0:
                    dur_key = self._recording_duration_key(room_id)
                    new_total = await self.redis.redis.incrby(dur_key, elapsed)
                    # Expire at end of UTC day (approximate: 25h is plenty).
                    await self.redis.redis.expire(dur_key, 25 * 60 * 60)
                    logger.info(
                        "Recording added %ds to room=%s daily total (now %ss)",
                        elapsed,
                        room_id,
                        new_total,
                    )
            except (ValueError, TypeError):
                logger.warning(
                    "Malformed egress_started_at for room %s: %r",
                    room_id,
                    started_raw,
                )

        await self.redis.redis.delete(f"room:{room_id}:egress_started_at")

        if publish_event:
            await self.redis.publish_room_event(
                room_id,
                {
                    "event": "recording_stopped",
                    "room_id": room_id,
                    "by_fid": fid,
                },
            )
            await self._broadcast_recording_state(room_id, False)

        logger.info(
            "Recording stop requested for room %s by fid=%s (egress_id=%s...)",
            room_id,
            fid,
            egress_id[:8] if egress_id else "?",
        )

    async def _broadcast_recording_state(
        self, room_id: str, is_recording: bool
    ) -> None:
        """Best-effort broadcast of the recording flag via LiveKit data.

        Clients subscribe on the ``space_state`` topic. If LiveKit rejects
        the send (e.g. room already torn down) we swallow the error so the
        caller isn't blocked.
        """
        try:
            payload = json.dumps(
                {
                    "type": "recording_state",
                    "recording": is_recording,
                }
            ).encode()
            await self.livekit.send_data(room_id, payload, topic="space_state")
        except Exception:
            logger.warning(
                "Failed to broadcast recording_state to room %s",
                room_id,
                exc_info=True,
            )

    async def end_room(
        self, room_id: str, fid: int, *, ended_via: str = "host"
    ) -> None:
        """
        End an active room or cancel a scheduled room.

        Scheduled rooms have no Redis/LiveKit state, so only a DB update is needed.
        Active rooms require full teardown (LiveKit, Redis, webhooks).

        ``ended_via`` tags the outbound ``room.finished`` payload so partner
        webhook consumers can distinguish a human host clicking End Space
        (``"host"``) from a server-side API end (``"api"``). Defaults to
        ``"host"`` for backward compatibility with the iOS path.
        """
        room = await self._get_room_or_404(room_id)

        # Scheduled rooms: host can cancel directly (no Redis state to check)
        if room.status == "scheduled":
            if room.host_fid != fid:
                raise HTTPException(
                    status_code=403, detail="Only the host can cancel a scheduled room"
                )
            await self.db.execute(
                update(Room)
                .where(Room.id == room.id)
                .values(status="cancelled", ended_at=_utcnow())
            )
            await self.db.commit()
            await self.redis.publish_room_discovery_event(
                _room_discovery_event(room_id, "room_cancelled", "cancelled")
            )
            logger.info("Scheduled room %s cancelled by fid=%s", room_id, fid)
            return

        # Idempotent: re-ending an already-finished room is a no-op. Without
        # this guard a double-call hits the actor_role check below, fails
        # because the first call cleared Redis participant state, and
        # surfaces a misleading 403 to the caller. Also prevents duplicate
        # ``room.finished`` dispatch on retry-on-transient-network paths.
        if room.status in ("ended", "cancelled"):
            return

        # Active rooms: require host/co-host role from Redis
        actor_role = await self._get_actor_role(room_id, fid)
        if not permission_service.can_end_room(actor_role):
            raise HTTPException(
                status_code=403, detail="Only hosts and co-hosts can end the room"
            )

        # If the room is currently recording, stop the egress before tearing down
        # LiveKit — otherwise the egress worker will be force-disconnected and
        # the final file may not be flushed/uploaded.
        if room.recording:
            try:
                await self._stop_egress_for_room(room_id, fid, publish_event=True)
            except Exception:
                logger.exception(
                    "Failed to stop egress for room %s during end_room (continuing)",
                    room_id,
                )

        # Update DB
        now = _utcnow()
        await self.db.execute(
            update(Room)
            .where(Room.id == uuid.UUID(room_id))
            .values(status="ended", ended_at=now)
        )
        await self.db.commit()

        if room.cast_hash:
            self._sync_room_reply_webhook()

        # Delete LiveKit room (best-effort; don't fail the operation if LiveKit is down)
        try:
            await self.livekit.delete_room(room_id)
        except Exception:
            logger.exception(
                "Failed to delete LiveKit room %s during end_room", room_id
            )

        # Publish event before clearing state so subscribers receive it
        await self.redis.publish_room_event(
            room_id,
            {"event": "room_ended", "room_id": room_id, "ended_by_fid": fid},
        )

        # Clear all Redis state (also clears user active rooms)
        await self.redis.clear_room_state(room_id)

        await self.redis.publish_room_discovery_event(
            _room_discovery_event(room_id, "room_ended", "ended")
        )

        # Dispatch outbound ``room.finished`` for developer-created rooms.
        # Required here because the LiveKit ``room_finished`` webhook handler
        # filters by ``Room.status == "active"`` — we just flipped to "ended"
        # so the handler's dispatch branch will skip when LiveKit's event
        # arrives moments later. Without this inline dispatch, partners
        # never see ``room.finished`` for explicit-end paths (iOS host
        # End Space, the new developer end endpoint, etc.). Empty-timeout
        # auto-close still dispatches from the LiveKit handler because the
        # row stays "active" until that webhook runs.
        await dispatch_dev_webhook(
            self.db,
            app_id=room.created_by_app_id,
            event_type="room.finished",
            data={
                "room_id": room_id,
                "host_fid": room.host_fid,
                "started_at": room.started_at.isoformat() if room.started_at else None,
                "ended_at": now.isoformat(),
                "ended_by_fid": fid,
                # ``host`` = human pressed End Space; ``api`` = developer
                # called POST /v1/developer/spaces/{id}/end on their own
                # server. Consumers building "ended by X" UX should branch
                # on this rather than treat ``ended_by_fid`` as a person.
                "ended_via": ended_via,
            },
        )

        logger.info("Room %s ended by fid=%s via=%s", room_id, fid, ended_via)

    async def _publish_participants_changed(self, room_id: str) -> None:
        """Best-effort, throttled discovery ping so the live rail refreshes
        listener counts within ~1s of a join/leave.

        The per-room event channel (``room:{id}:events``) already carries
        ``participant_joined`` / ``participant_left`` for in-room clients, but
        the discovery panel only subscribes to the discovery channel. Without
        this ping, card listener counts only refresh on the 30s poll. Coalesced
        server-side (see ``try_mark_participants_event``) to avoid event storms
        on churny rooms; never raises — a pubsub hiccup must not fail the
        join/leave itself.
        """
        try:
            if await self.redis.try_mark_participants_event(room_id):
                await self.redis.publish_room_discovery_event(
                    _room_discovery_event(room_id, "participants_changed", "active")
                )
        except Exception:  # pragma: no cover — best-effort
            logger.debug(
                "participants_changed discovery publish failed for room %s",
                room_id,
                exc_info=True,
            )

    async def join_room(self, room_id: str, fid: int) -> JoinResponse:
        """
        Join an active room as a listener.

        Checks:
          - Room exists and is active.
          - User is not banned.
          - User is not already an active participant (idempotent re-join returns existing token).
        """
        room = await self._get_room_or_404(room_id)

        # Farcaster-native rooms are media-hosted upstream on
        # client.farcaster.xyz — there's no Juke LiveKit room to
        # generate a token for. Clients should branch on
        # ``room.is_farcaster_native`` and route the user through the
        # Farcaster client directly. The 400 is defense-in-depth.
        if room.is_farcaster_native:
            raise HTTPException(
                status_code=400,
                detail="Native rooms join via client.farcaster.xyz directly",
            )

        if room.status != "active":
            raise HTTPException(status_code=400, detail="Room is not active")

        if await is_blocked(self.db, blocker_fid=room.host_fid, blocked_fid=fid):
            raise HTTPException(status_code=403, detail="You cannot join this room")

        # Ban check
        await self._assert_not_banned(room_id, fid)

        user = await self._get_user(fid)

        # Idempotency: if already in Redis, return a fresh token without duplicating the DB row
        existing = await self.redis.get_participant(room_id, fid)
        if existing:
            token = self.livekit.generate_token(
                room_id=room_id,
                fid=fid,
                display_name=existing.get("display_name", str(fid)),
                role=existing["role"],
                pfp_url=existing.get("pfp_url"),
            )
            participants_data = await self.redis.get_all_participants(room_id)
            host = await self._get_user(room.host_fid)
            speaker_count, listener_count = await self._count_participants(
                room_id, participants_data
            )
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            participants = self._build_participant_responses(participants_data)
            return JoinResponse(
                livekit_token=token,
                livekit_ws_url=settings.LIVEKIT_WS_URL,
                expires_at=_livekit_expires_at(),
                role=existing["role"],
                room=room_response,
                participants=participants,
            )

        display_name = user.display_name or user.username or str(fid)
        is_host = fid == room.host_fid
        participant_data = {
            "fid": fid,
            "role": "host" if is_host else "listener",
            "is_muted": not is_host,
            "hand_raised": False,
            "display_name": display_name,
            "pfp_url": user.pfp_url,
        }

        # Persist participant in DB (handle re-join after left_at was set)
        result = await self.db.execute(
            select(Participant).where(
                Participant.room_id == room.id,
                Participant.fid == fid,
            )
        )
        db_participant = result.scalar_one_or_none()

        if db_participant is None:
            db_participant = Participant(
                room_id=room.id,
                fid=fid,
                role=participant_data["role"],
                is_muted=participant_data["is_muted"],
            )
            self.db.add(db_participant)
        else:
            # Re-joining after a previous leave
            db_participant.left_at = None
            db_participant.role = participant_data["role"]
            db_participant.is_muted = participant_data["is_muted"]
            db_participant.hand_raised = False

        await self.db.commit()

        # Update Redis
        await self.redis.set_participant(room_id, fid, participant_data)
        # A fresh, authorised grant supersedes any earlier kick/demote
        # marker (see ``livekit_admission_service``).
        await self.redis.clear_livekit_revocation(room_id, fid)
        await self.redis.set_user_active_room(fid, room_id)

        # Generate LiveKit token
        role = participant_data["role"]
        token = self.livekit.generate_token(
            room_id=room_id,
            fid=fid,
            display_name=display_name,
            role=role,
            pfp_url=user.pfp_url,
        )

        # Publish join event
        await self.redis.publish_room_event(
            room_id,
            {
                "event": "participant_joined",
                "room_id": room_id,
                "fid": fid,
                "role": role,
                "display_name": display_name,
            },
        )
        # Nudge the live rail so cards reflect the new listener within ~1s.
        await self._publish_participants_changed(room_id)

        participants_data = await self.redis.get_all_participants(room_id)
        host = await self._get_user(room.host_fid)
        speaker_count, listener_count = await self._count_participants(
            room_id, participants_data
        )
        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        participants = self._build_participant_responses(participants_data)

        logger.info("fid=%s joined room %s", fid, room_id)
        return JoinResponse(
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
            expires_at=_livekit_expires_at(),
            role=role,
            room=room_response,
            participants=participants,
        )

    async def join_room_anonymously(
        self,
        room_id: str,
        session_id: str,
    ) -> JoinResponse:
        """
        Join an active room as an anonymous, listen-only LiveKit subscriber.

        Anonymous listeners are counted separately from named Farcaster
        participants and are never persisted to the participant hash or DB.
        """
        room = await self._get_room_or_404(room_id)

        if room.status != "active":
            raise HTTPException(status_code=400, detail="Room is not active")

        token = self.livekit.generate_anonymous_listener_token(
            room_id=room_id,
            session_id=session_id,
        )
        await self._register_anonymous_listener(room_id, session_id)
        # Anonymous listeners count toward the listener total on cards — ping
        # the live rail so the bump shows within ~1s (throttled).
        await self._publish_participants_changed(room_id)

        participants_data = await self.redis.get_all_participants(room_id)
        host = await self._get_user(room.host_fid)
        speaker_count, listener_count = await self._count_participants(
            room_id, participants_data
        )
        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        participants = self._build_participant_responses(participants_data)

        return JoinResponse(
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
            expires_at=_anonymous_livekit_expires_at(),
            role="listener",
            room=room_response,
            participants=participants,
        )

    async def join_room_as_agent(
        self,
        room_id: str,
        agent_fid: int,
        agent_name: str,
        agent_pfp_url: str | None = None,
    ) -> JoinResponse:
        """Join an active room as an agent listener.

        Similar to join_room but:
        - Agents always join as listeners
        - LiveKit token includes is_agent=True metadata
        - Agent listeners get can_publish_data=True (for sending transcription etc)
        - Skips _get_user() since the temp User was already created by the router
        - Checks allow_agents room flag
        """
        room = await self._get_room_or_404(room_id)

        if room.status != "active":
            raise HTTPException(status_code=400, detail="Room is not active")

        if not room.allow_agents:
            raise HTTPException(
                status_code=403, detail="This room does not allow agents"
            )

        # Ban check (agents can be banned by FID like any participant)
        await self._assert_not_banned(room_id, agent_fid)

        # Per-room concurrent agent cap. Limits a partner from spamming
        # their own room with a swarm of synthetic identities (each holds
        # data-publish rights and dilutes the participant list). Counts
        # agents already in Redis with ``is_agent=True``. The idempotent
        # rejoin path below skips this check by virtue of bailing
        # earlier on the ``existing`` participant row.
        existing = await self.redis.get_participant(room_id, agent_fid)
        if not existing:
            current_agents = await self._count_agents_in_room(room_id)
            if current_agents >= settings.MAX_AGENTS_PER_ROOM:
                raise HTTPException(
                    status_code=429,
                    detail=(
                        f"Room is at its agent cap "
                        f"({settings.MAX_AGENTS_PER_ROOM}). Wait for an "
                        f"existing agent to leave."
                    ),
                )

        display_name = agent_name

        if existing:
            token = self.livekit.generate_token(
                room_id=room_id,
                fid=agent_fid,
                display_name=existing.get("display_name", display_name),
                role=existing["role"],
                pfp_url=existing.get("pfp_url"),
                is_agent=True,
                can_publish_data_override=True,
            )
            participants_data = await self.redis.get_all_participants(room_id)
            host = await self._get_user(room.host_fid)
            speaker_count, listener_count = await self._count_participants(
                room_id, participants_data
            )
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            participants = self._build_participant_responses(participants_data)
            return JoinResponse(
                livekit_token=token,
                livekit_ws_url=settings.LIVEKIT_WS_URL,
                expires_at=_livekit_expires_at(),
                role=existing["role"],
                room=room_response,
                participants=participants,
            )

        participant_data = {
            "fid": agent_fid,
            "role": "listener",
            "is_muted": True,
            "hand_raised": False,
            "display_name": display_name,
            "pfp_url": agent_pfp_url,
            "is_agent": True,
        }

        # Persist participant in DB
        result = await self.db.execute(
            select(Participant).where(
                Participant.room_id == room.id,
                Participant.fid == agent_fid,
            )
        )
        db_participant = result.scalar_one_or_none()

        if db_participant is None:
            db_participant = Participant(
                room_id=room.id,
                fid=agent_fid,
                role="listener",
                is_muted=True,
            )
            self.db.add(db_participant)
        else:
            db_participant.left_at = None
            db_participant.role = "listener"
            db_participant.is_muted = True
            db_participant.hand_raised = False

        await self.db.commit()

        # Update Redis
        await self.redis.set_participant(room_id, agent_fid, participant_data)
        # A fresh, authorised grant supersedes any earlier kick/demote
        # marker (see ``livekit_admission_service``).
        await self.redis.clear_livekit_revocation(room_id, agent_fid)
        await self.redis.set_user_active_room(agent_fid, room_id)

        # Generate LiveKit token with agent metadata + data publish rights
        token = self.livekit.generate_token(
            room_id=room_id,
            fid=agent_fid,
            display_name=display_name,
            role="listener",
            pfp_url=agent_pfp_url,
            is_agent=True,
            can_publish_data_override=True,
        )

        # Publish join event
        await self.redis.publish_room_event(
            room_id,
            {
                "event": "participant_joined",
                "room_id": room_id,
                "fid": agent_fid,
                "role": "listener",
                "display_name": display_name,
                "is_agent": True,
            },
        )
        # Nudge the live rail so cards reflect the new participant within ~1s.
        await self._publish_participants_changed(room_id)

        participants_data = await self.redis.get_all_participants(room_id)
        host = await self._get_user(room.host_fid)
        speaker_count, listener_count = await self._count_participants(
            room_id, participants_data
        )
        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        participants = self._build_participant_responses(participants_data)

        logger.info("agent fid=%s (%s) joined room %s", agent_fid, agent_name, room_id)
        return JoinResponse(
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
            expires_at=_livekit_expires_at(),
            role="listener",
            room=room_response,
            participants=participants,
        )

    async def leave_room(self, room_id: str, fid: int) -> None:
        """
        Leave a room. Marks left_at in DB, removes from Redis, clears user's active room.
        """
        room = await self._get_room_or_404(room_id)

        # Native rooms never had a Juke join in the first place — see
        # ``join_room``. Return 400 so a buggy client that forgot to
        # branch on ``is_farcaster_native`` gets a loud, actionable
        # error instead of a silent no-op.
        if room.is_farcaster_native:
            raise HTTPException(
                status_code=400,
                detail="Native rooms leave via client.farcaster.xyz directly",
            )

        # Update DB left_at
        now = _utcnow()
        result = await self.db.execute(
            select(Participant).where(
                Participant.room_id == uuid.UUID(room_id),
                Participant.fid == fid,
                Participant.left_at.is_(None),
            )
        )
        db_participant = result.scalar_one_or_none()
        if db_participant:
            db_participant.left_at = now
            db_participant.hand_raised = False
            await self.db.commit()

        # Remove from Redis
        await self.redis.remove_participant(room_id, fid)
        await self.redis.remove_from_hand_queue(room_id, fid)
        await self.redis.clear_user_active_room(fid)

        await self.redis.publish_room_event(
            room_id,
            {"event": "participant_left", "room_id": room_id, "fid": fid},
        )

        logger.info("fid=%s left room %s", fid, room_id)

        # Auto-end room if no active participants remain
        remaining = await self.redis.get_participant_count(room_id)
        if remaining == 0:
            room = await self._get_room_or_404(room_id)
            now = _utcnow()
            await self.db.execute(
                update(Room)
                .where(Room.id == uuid.UUID(room_id), Room.status == "active")
                .values(status="ended", ended_at=now)
            )
            await self.db.commit()

            if room.cast_hash:
                self._sync_room_reply_webhook()

            await self.redis.clear_room_state(room_id)
            # Drain the live rail immediately — without this the emptied room
            # lingers as "Live now" until the next 30s discovery poll.
            await self.redis.publish_room_discovery_event(
                _room_discovery_event(room_id, "room_ended", "ended")
            )
            logger.info("Room %s auto-ended (no participants remaining)", room_id)
        else:
            # Room is still live but its listener count dropped — nudge the
            # live rail so cards reflect the departure within ~1s (throttled).
            await self._publish_participants_changed(room_id)

    async def raise_hand(
        self, room_id: str, fid: int, raised: bool
    ) -> RaiseHandResponse:
        """
        Toggle the raise-hand state for a listener.
        """
        await self._get_room_or_404(room_id)

        participant = await self._get_participant_or_403(room_id, fid)

        if not permission_service.can_raise_hand(participant["role"]):
            raise HTTPException(
                status_code=403,
                detail="Only listeners can raise their hand",
            )

        queue_position: int | None = None

        # Update Redis participant data
        participant["hand_raised"] = raised
        await self.redis.set_participant(room_id, fid, participant)

        if raised:
            queue_position = await self.redis.add_to_hand_queue(room_id, fid)
        else:
            await self.redis.remove_from_hand_queue(room_id, fid)

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "hand_raised" if raised else "hand_lowered",
                "room_id": room_id,
                "fid": fid,
                "queue_position": queue_position,
            },
        )

        # Send push notification to host when someone raises their hand
        if raised:
            try:
                room_state = await self.redis.get_room_state(room_id)
                host_fid = room_state.get("host_fid") if room_state else None
                if host_fid and int(host_fid) != fid:
                    raiser_name = (
                        participant.get("display_name")
                        or participant.get("username")
                        or "Someone"
                    )
                    raiser_pfp_url = participant.get("pfp_url")
                    await self.push.notify_hand_raised(
                        host_fid=int(host_fid),
                        raiser_name=raiser_name,
                        room_id=room_id,
                        raiser_pfp_url=raiser_pfp_url,
                    )
            except Exception as e:
                logger.warning("Failed to send hand-raised push: %s", e)

        return RaiseHandResponse(hand_raised=raised, queue_position=queue_position)

    async def promote_participant(
        self,
        room_id: str,
        actor_fid: int,
        target_fid: int,
    ) -> PromoteResponse:
        """
        Promote a listener to speaker.

        - Validates actor has permission.
        - Updates Redis + DB role.
        - Updates LiveKit publish permissions.
        - Removes target from hand queue.
        - Generates a new LiveKit token for the target.
        - Publishes role_changed event.
        """
        await self._get_room_or_404(room_id)

        actor_role = await self._get_actor_role(room_id, actor_fid)
        target_participant = await self._get_participant_or_403(room_id, target_fid)
        target_role = target_participant["role"]

        if not permission_service.can_promote(actor_role, target_role):
            raise HTTPException(
                status_code=403,
                detail=f"Actor role '{actor_role}' cannot promote '{target_role}'",
            )

        # Update Redis
        target_participant["role"] = "speaker"
        target_participant["is_muted"] = False
        await self.redis.set_participant(room_id, target_fid, target_participant)
        # A fresh, authorised grant supersedes any earlier kick/demote
        # marker (see ``livekit_admission_service``).
        await self.redis.clear_livekit_revocation(room_id, target_fid)

        # Update DB
        await self.db.execute(
            update(Participant)
            .where(
                Participant.room_id == uuid.UUID(room_id),
                Participant.fid == target_fid,
                Participant.left_at.is_(None),
            )
            .values(role="speaker", is_muted=False, hand_raised=False)
        )
        await self.db.commit()

        # Update LiveKit permissions
        try:
            await self.livekit.update_permissions(
                room_id=room_id,
                identity=str(target_fid),
                can_publish=True,
                role="speaker",
            )
        except Exception:
            logger.exception(
                "Failed to update LiveKit permissions for fid=%s in room %s",
                target_fid,
                room_id,
            )

        # Remove from hand queue
        await self.redis.remove_from_hand_queue(room_id, target_fid)

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "role_changed",
                "room_id": room_id,
                "fid": target_fid,
                "old_role": target_role,
                "new_role": "speaker",
                "by_fid": actor_fid,
            },
        )

        logger.info(
            "fid=%s promoted to speaker in room %s by fid=%s",
            target_fid,
            room_id,
            actor_fid,
        )

        # Send push notification to the promoted user
        try:
            room_state = await self.redis.get_room_state(room_id)
            room_title = room_state.get("title", "a space") if room_state else "a space"
            actor_participant = await self.redis.get_participant(room_id, actor_fid)
            inviter_name = "The host"
            inviter_pfp_url: str | None = None
            if actor_participant:
                inviter_name = (
                    actor_participant.get("display_name")
                    or actor_participant.get("username")
                    or "The host"
                )
                inviter_pfp_url = actor_participant.get("pfp_url")
            await self.push.notify_invited_to_speak(
                target_fid=target_fid,
                inviter_name=inviter_name,
                room_id=room_id,
                room_title=room_title,
                inviter_pfp_url=inviter_pfp_url,
            )
        except Exception as e:
            logger.warning("Failed to send invite-to-speak push: %s", e)

        return PromoteResponse(fid=target_fid, role="speaker")

    async def demote_participant(
        self,
        room_id: str,
        actor_fid: int,
        target_fid: int,
    ) -> PromoteResponse:
        """
        Demote a speaker (or co_host) back to listener.
        """
        await self._get_room_or_404(room_id)

        actor_role = await self._get_actor_role(room_id, actor_fid)
        target_participant = await self._get_participant_or_403(room_id, target_fid)
        target_role = target_participant["role"]

        if not permission_service.can_demote(actor_role, target_role):
            raise HTTPException(
                status_code=403,
                detail=f"Actor role '{actor_role}' cannot demote '{target_role}'",
            )

        # Update Redis
        target_participant["role"] = "listener"
        target_participant["is_muted"] = True
        target_participant["hand_raised"] = False
        await self.redis.set_participant(room_id, target_fid, target_participant)
        # Cap any stale speaker token if it is replayed after the user's
        # Redis row is gone (see ``livekit_admission_service``).
        await self.redis.mark_livekit_revocation(
            room_id,
            target_fid,
            RedisService.LIVEKIT_REVOCATION_LISTENER,
            LIVEKIT_REVOCATION_TTL_SECONDS,
        )

        # Update DB
        await self.db.execute(
            update(Participant)
            .where(
                Participant.room_id == uuid.UUID(room_id),
                Participant.fid == target_fid,
                Participant.left_at.is_(None),
            )
            .values(role="listener", is_muted=True, hand_raised=False)
        )
        await self.db.commit()

        # Revoke LiveKit publish permissions
        try:
            await self.livekit.update_permissions(
                room_id=room_id,
                identity=str(target_fid),
                can_publish=False,
                role="listener",
            )
        except Exception:
            logger.exception(
                "Failed to revoke LiveKit permissions for fid=%s in room %s",
                target_fid,
                room_id,
            )

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "role_changed",
                "room_id": room_id,
                "fid": target_fid,
                "old_role": target_role,
                "new_role": "listener",
                "by_fid": actor_fid,
            },
        )

        logger.info(
            "fid=%s demoted to listener in room %s by fid=%s",
            target_fid,
            room_id,
            actor_fid,
        )
        return PromoteResponse(fid=target_fid, role="listener")

    async def mute_participant(
        self,
        room_id: str,
        actor_fid: int,
        target_fid: int,
    ) -> None:
        """
        Server-side mute a speaker. Hosts and co-hosts only (co-host cannot mute host).
        """
        await self._get_room_or_404(room_id)

        actor_role = await self._get_actor_role(room_id, actor_fid)
        target_participant = await self._get_participant_or_403(room_id, target_fid)
        target_role = target_participant["role"]

        if not permission_service.can_mute_other(actor_role, target_role):
            raise HTTPException(
                status_code=403,
                detail=f"Actor role '{actor_role}' cannot mute '{target_role}'",
            )

        # Call LiveKit server-side mute
        try:
            await self.livekit.mute_participant(
                room_id=room_id, identity=str(target_fid)
            )
        except Exception:
            logger.exception(
                "LiveKit mute failed for fid=%s in room %s", target_fid, room_id
            )
            raise HTTPException(
                status_code=502, detail="Failed to mute participant via media server"
            )

        # Update Redis
        target_participant["is_muted"] = True
        await self.redis.set_participant(room_id, target_fid, target_participant)

        # Update DB
        await self.db.execute(
            update(Participant)
            .where(
                Participant.room_id == uuid.UUID(room_id),
                Participant.fid == target_fid,
                Participant.left_at.is_(None),
            )
            .values(is_muted=True)
        )
        await self.db.commit()

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "participant_muted",
                "room_id": room_id,
                "fid": target_fid,
                "by_fid": actor_fid,
            },
        )

        logger.info("fid=%s muted in room %s by fid=%s", target_fid, room_id, actor_fid)

    async def kick_participant(
        self,
        room_id: str,
        actor_fid: int,
        target_fid: int,
    ) -> None:
        """
        Forcibly remove a participant from the room.
        """
        await self._get_room_or_404(room_id)

        actor_role = await self._get_actor_role(room_id, actor_fid)
        target_participant = await self._get_participant_or_403(room_id, target_fid)
        target_role = target_participant["role"]

        if not permission_service.can_kick(actor_role, target_role):
            raise HTTPException(
                status_code=403,
                detail=f"Actor role '{actor_role}' cannot kick '{target_role}'",
            )

        await self._remove_participant_from_room(
            room_id=room_id,
            fid=target_fid,
            event_name="participant_kicked",
            extra_event_fields={"by_fid": actor_fid},
        )

        logger.info(
            "fid=%s kicked from room %s by fid=%s", target_fid, room_id, actor_fid
        )

    async def ban_participant(
        self,
        room_id: str,
        actor_fid: int,
        target_fid: int,
        reason: str | None = None,
        duration_hours: int | None = None,
    ) -> BanResponse:
        """
        Ban a participant: kick them first, then persist a ban record.

        A ban with `duration_hours=None` is permanent (within this room).
        """
        await self._get_room_or_404(room_id)

        actor_role = await self._get_actor_role(room_id, actor_fid)
        target_participant = await self._get_participant_or_403(room_id, target_fid)
        target_role = target_participant["role"]

        if not permission_service.can_ban(actor_role, target_role):
            raise HTTPException(
                status_code=403,
                detail=f"Actor role '{actor_role}' cannot ban '{target_role}'",
            )

        # Kick first
        await self._remove_participant_from_room(
            room_id=room_id,
            fid=target_fid,
            event_name="participant_banned",
            extra_event_fields={"by_fid": actor_fid, "reason": reason},
        )

        # Compute expiry
        expires_at: datetime | None = None
        if duration_hours is not None:
            expires_at = _utcnow() + timedelta(hours=duration_hours)

        # Check for existing ban record (upsert semantics)
        result = await self.db.execute(
            select(Ban).where(
                Ban.room_id == uuid.UUID(room_id),
                Ban.banned_fid == target_fid,
            )
        )
        existing_ban = result.scalar_one_or_none()

        if existing_ban:
            existing_ban.banned_by_fid = actor_fid
            existing_ban.reason = reason
            existing_ban.expires_at = expires_at
            existing_ban.created_at = _utcnow()
        else:
            ban = Ban(
                room_id=uuid.UUID(room_id),
                banned_fid=target_fid,
                banned_by_fid=actor_fid,
                reason=reason,
                expires_at=expires_at,
            )
            self.db.add(ban)

        await self.db.commit()

        logger.info(
            "fid=%s banned from room %s by fid=%s (expires=%s)",
            target_fid,
            room_id,
            actor_fid,
            expires_at,
        )
        return BanResponse(
            fid=target_fid,
            status="banned",
            expires_at=_iso(expires_at),
        )

    async def admin_end_room(self, room_id: str, admin_fid: int) -> None:
        """End any active room without permission checks (admin only)."""
        room = await self._get_room_or_404(room_id)

        if room.status != "active":
            raise HTTPException(status_code=400, detail="Room is not active")

        now = _utcnow()
        await self.db.execute(
            update(Room)
            .where(Room.id == uuid.UUID(room_id))
            .values(status="ended", ended_at=now)
        )
        await self.db.commit()

        if room.cast_hash:
            self._sync_room_reply_webhook()

        try:
            await self.livekit.delete_room(room_id)
        except Exception:
            logger.exception(
                "Failed to delete LiveKit room %s during admin_end_room", room_id
            )

        await self.redis.publish_room_event(
            room_id,
            {
                "event": "room_ended",
                "room_id": room_id,
                "ended_by_fid": admin_fid,
                "admin": True,
            },
        )
        await self.redis.clear_room_state(room_id)

        await self.redis.publish_room_discovery_event(
            _room_discovery_event(room_id, "room_ended", "ended")
        )
        logger.info("Room %s force-ended by admin fid=%s", room_id, admin_fid)

    async def admin_kick_participant(
        self, room_id: str, target_fid: int, admin_fid: int
    ) -> None:
        """Kick any participant without permission checks (admin only)."""
        await self._get_room_or_404(room_id)
        await self._get_participant_or_403(room_id, target_fid)

        await self._remove_participant_from_room(
            room_id=room_id,
            fid=target_fid,
            event_name="participant_kicked",
            extra_event_fields={"by_fid": admin_fid, "admin": True},
        )

        logger.info(
            "fid=%s force-kicked from room %s by admin fid=%s",
            target_fid,
            room_id,
            admin_fid,
        )

    async def list_active_rooms_from_db(self) -> list[RoomResponse]:
        """Return rooms relevant to the admin view (no pagination).

        Includes every ``active`` room PLUS any room still flagged
        ``recording=True`` regardless of status. The latter surfaces
        *orphaned recordings* — rooms whose space ended on Farcaster's
        side (so the reconciler flipped them to ``ended``) but whose
        recording flag never cleared. Without this, a stuck recording is
        invisible to the admin Stop button because the room dropped off
        the active list.
        """
        result = await self.db.execute(
            select(Room)
            .where(or_(Room.status == "active", Room.recording.is_(True)))
            .order_by(Room.started_at.desc())
        )
        rooms = result.scalars().all()

        responses = []
        for room in rooms:
            host = await self._get_user(room.host_fid)
            room_id = _room_id_str(room.id)
            speaker_count = await self.redis.get_speaker_count(room_id)
            listener_count = await self.redis.get_listener_count(room_id)
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            responses.append(room_response)

        return responses

    async def refresh_token(self, room_id: str, fid: int) -> TokenRefreshResponse:
        """
        Issue a fresh LiveKit token for a participant currently in the room.
        """
        await self._get_room_or_404(room_id)

        participant = await self.redis.get_participant(room_id, fid)
        if not participant:
            raise HTTPException(
                status_code=403, detail="You are not an active participant in this room"
            )

        user = await self._get_user(fid)
        display_name = user.display_name or user.username or str(fid)
        role = participant["role"]

        token = self.livekit.generate_token(
            room_id=room_id,
            fid=fid,
            display_name=display_name,
            role=role,
            pfp_url=user.pfp_url,
        )

        return TokenRefreshResponse(
            livekit_token=token,
            expires_at=_livekit_expires_at(),
        )

    # -----------------------------------------------------------------------
    # Helper methods
    # -----------------------------------------------------------------------

    async def _get_actor_role(self, room_id: str, fid: int) -> str:
        """
        Return the Redis-resident role for `fid` in `room_id`.
        Raises 403 if the participant is not found in the room.
        """
        participant = await self.redis.get_participant(room_id, fid)
        if not participant:
            raise HTTPException(
                status_code=403,
                detail="You are not an active participant in this room",
            )
        return participant["role"]

    async def _get_user(self, fid: int) -> User:
        """
        Fetch a User from the database by FID.
        Raises 404 if not found.
        """
        result = await self.db.execute(select(User).where(User.fid == fid))
        user = result.scalar_one_or_none()
        if user is None:
            raise HTTPException(
                status_code=404, detail=f"User with fid={fid} not found"
            )
        return user

    async def _get_rsvp_summary(
        self, room_id: uuid.UUID, current_fid: int | None = None
    ) -> RsvpSummary:
        """Build an RSVP summary for a room: count, top 5 users, and whether the current user is going."""
        # Total count
        count_result = await self.db.execute(
            select(sa_func.count(RoomRsvp.id)).where(RoomRsvp.room_id == room_id)
        )
        count = count_result.scalar() or 0

        # Top 5 users (earliest RSVPs)
        top_users_result = await self.db.execute(
            select(RoomRsvp.fid, User.display_name, User.pfp_url)
            .join(User, RoomRsvp.fid == User.fid)
            .where(RoomRsvp.room_id == room_id)
            .order_by(RoomRsvp.created_at)
            .limit(5)
        )
        users = [
            RsvpUserResponse(
                fid=row.fid,
                display_name=row.display_name or str(row.fid),
                pfp_url=row.pfp_url,
            )
            for row in top_users_result.all()
        ]

        # Check if current user is going
        is_going = False
        if current_fid is not None:
            exists_result = await self.db.execute(
                select(sa_func.count(RoomRsvp.id)).where(
                    RoomRsvp.room_id == room_id, RoomRsvp.fid == current_fid
                )
            )
            is_going = (exists_result.scalar() or 0) > 0

        return RsvpSummary(count=count, users=users, is_going=is_going)

    async def _get_rsvp_fids(self, room_id: uuid.UUID) -> list[int]:
        """Return all FIDs that RSVP'd to a room."""
        result = await self.db.execute(
            select(RoomRsvp.fid).where(RoomRsvp.room_id == room_id)
        )
        return [row[0] for row in result.all()]

    def _anonymous_listener_key(self, room_id: str) -> str:
        return f"room:{room_id}:anonymous_listeners"

    async def _register_anonymous_listener(self, room_id: str, session_id: str) -> None:
        key = self._anonymous_listener_key(room_id)
        now = _utcnow().timestamp()
        cutoff = now - ANONYMOUS_LISTENER_TTL_SECONDS
        pipe = self.redis.redis.pipeline()
        pipe.zremrangebyscore(key, 0, cutoff)
        pipe.zadd(key, {session_id: now})
        pipe.expire(key, ANONYMOUS_LISTENER_TTL_SECONDS)
        await pipe.execute()

    async def _get_anonymous_listener_count(self, room_id: str) -> int:
        key = self._anonymous_listener_key(room_id)
        now = _utcnow().timestamp()
        cutoff = now - ANONYMOUS_LISTENER_TTL_SECONDS
        try:
            pipe = self.redis.redis.pipeline()
            pipe.zremrangebyscore(key, 0, cutoff)
            pipe.zcard(key)
            results = await pipe.execute()
            count = results[1] if len(results) > 1 else 0
            if isinstance(count, int) and not isinstance(count, bool):
                return count
            return 0
        except AttributeError:
            return 0

    def _build_participant_responses(
        self, participants_data: list[dict]
    ) -> list[ParticipantResponse]:
        return [
            ParticipantResponse(
                fid=p["fid"],
                role=p["role"],
                is_muted=p.get("is_muted", True),
                hand_raised=p.get("hand_raised", False),
                display_name=p.get("display_name", str(p["fid"])),
                pfp_url=p.get("pfp_url"),
            )
            for p in participants_data
            if p.get("fid") is not None
        ]

    async def _count_agents_in_room(self, room_id: str) -> int:
        """Return the number of agent-flagged participants currently in
        ``room_id`` according to Redis. Used to enforce
        ``MAX_AGENTS_PER_ROOM`` against the partner agent-join path.
        """
        participants = await self.redis.get_all_participants(room_id)
        return sum(1 for p in participants if p.get("is_agent"))

    async def _count_participants(
        self, room_id: str, participants_data: list[dict]
    ) -> tuple[int, int]:
        speaker_count = sum(
            1
            for p in participants_data
            if p.get("role") in ("host", "co_host", "speaker")
        )
        named_listener_count = sum(
            1 for p in participants_data if p.get("role") == "listener"
        )
        return (
            speaker_count,
            named_listener_count + await self._get_anonymous_listener_count(room_id),
        )

    async def _get_live_counts(self, room_id: str) -> tuple[int, int]:
        """Return (speaker_count, listener_count) from Redis live state."""
        participants_data = await self.redis.get_all_participants(room_id)
        return await self._count_participants(room_id, participants_data)

    async def _build_room_response(
        self,
        room: Room,
        host: User,
        speaker_count: int,
        listener_count: int,
        rsvp_summary: RsvpSummary | None = None,
    ) -> RoomResponse:
        """
        Construct a RoomResponse from ORM model + live Redis counts.
        """
        host_response = UserResponse(
            fid=host.fid,
            username=host.username or str(host.fid),
            display_name=host.display_name or host.username or str(host.fid),
            pfp_url=host.pfp_url,
            # Never publish the host's custody address in room payloads (L11a).
            custody_address=None,
        )

        return RoomResponse(
            id=_room_id_str(room.id),
            title=room.title,
            host_fid=room.host_fid,
            host=host_response,
            status=room.status,
            started_at=room.started_at.isoformat() if room.started_at else "",
            ended_at=_iso(room.ended_at),
            scheduled_at=_iso(room.scheduled_at),
            speaker_count=speaker_count,
            listener_count=listener_count,
            recording=room.recording,
            cast_hash=room.cast_hash,
            allow_agents=room.allow_agents,
            rsvp_summary=rsvp_summary,
            farcaster_room_id=room.farcaster_room_id,
            is_farcaster_native=room.is_farcaster_native,
        )

    async def _announce_room(self, room_id: str, title: str, user: User) -> str | None:
        """Post announcement cast to Farcaster. Returns cast_hash or None."""
        return await self._publish_announcement(
            user,
            text=f"Live now: {title}\n\nListen on Juke",
            embed_url=JUKE_HOME_URL,
            room_id=room_id,
        )

    async def _announce_room_scheduled(
        self, room_id: str, title: str, user: User, scheduled_label: str
    ) -> str | None:
        """Post announcement cast for a scheduled space. Returns cast_hash or None."""
        return await self._publish_announcement(
            user,
            text=(
                f"Upcoming space: {title}\n\nStarts {scheduled_label}\n\n"
                "Join on Juke"
            ),
            embed_url=SPACE_URL_TEMPLATE.format(room_id=room_id),
            room_id=room_id,
        )

    async def _publish_announcement(
        self, user: User, *, text: str, embed_url: str, room_id: str
    ) -> str | None:
        """Best-effort host-signed announcement; never raises.

        A host without an approved signer simply gets no announcement cast.
        """
        try:
            signer = await farcaster_writes.load_user_signer(self.db, user.fid)
            cast_hash = await farcaster_writes.publish_cast(
                signer, text=text, embed_urls=[embed_url]
            )
        except Exception as exc:  # noqa: BLE001 - announcement is best-effort
            logger.warning(
                "Failed to announce room %s: %s", room_id, type(exc).__name__
            )
            return None
        await record_cast(
            self.db, fid=user.fid, cast_hash=cast_hash, source="room_announcement"
        )
        return cast_hash

    async def _create_system_chat_cast(
        self, room_id: str, title: str, host: User
    ) -> str:
        """Create a @jukeaudio fallback cast to use as the room chat target."""
        text = (
            f"Chat for: {title}\n\n"
            f"Hosted by @{host.username or host.fid}. Reply here to chat in Juke."
        )
        # The host's FID is known, so the mention resolves with no lookup.
        known = {host.username: host.fid} if host.username else {}
        try:
            signer = farcaster_writes.load_system_signer()
            return await farcaster_writes.publish_cast(
                signer,
                text=text,
                embed_urls=[SPACE_URL_TEMPLATE.format(room_id=room_id)],
                resolve_username=farcaster_writes.known_mentions_resolver(known),
            )
        except Exception as exc:
            logger.warning(
                "Failed to create system chat cast for room %s: %s",
                room_id,
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=502,
                detail="Failed to create chat target",
            ) from exc

    def _sync_room_reply_webhook(self) -> None:
        """Re-sync the global room-reply webhook's parent_hashes (background).

        Called whenever a room with an announcement cast goes live or ends.
        Best-effort: webhook sync must never fail a room operation.
        """
        try:
            schedule_room_reply_sync(self.redis.redis)
        except Exception:
            logger.exception("Failed to schedule room-reply webhook sync")

    # -----------------------------------------------------------------------
    # Private helpers
    # -----------------------------------------------------------------------

    async def _get_room_or_404(self, room_id: str) -> Room:
        """Fetch Room by ID string; raises 404 if not found."""
        try:
            room_uuid = uuid.UUID(room_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Room not found")

        result = await self.db.execute(select(Room).where(Room.id == room_uuid))
        room = result.scalar_one_or_none()
        if room is None:
            raise HTTPException(status_code=404, detail="Room not found")
        return room

    async def _get_participant_or_403(self, room_id: str, fid: int) -> dict:
        """
        Fetch live Redis participant data for `fid` in `room_id`.
        Raises 403 if the participant is not present.
        """
        participant = await self.redis.get_participant(room_id, fid)
        if not participant:
            raise HTTPException(
                status_code=403,
                detail=f"fid={fid} is not an active participant in this room",
            )
        return participant

    async def _assert_not_banned(self, room_id: str, fid: int) -> None:
        """
        Raise 403 if `fid` has an active (non-expired) ban in `room_id`.
        """
        now = _utcnow()
        result = await self.db.execute(
            select(Ban).where(
                Ban.room_id == uuid.UUID(room_id),
                Ban.banned_fid == fid,
            )
        )
        ban = result.scalar_one_or_none()
        if ban is None:
            return

        # Ban is active if it has no expiry (permanent) or expiry is in the future
        if ban.expires_at is None or ban.expires_at > now:
            raise HTTPException(
                status_code=403,
                detail="You are banned from this room",
            )

    async def _remove_participant_from_room(
        self,
        room_id: str,
        fid: int,
        event_name: str,
        extra_event_fields: dict | None = None,
    ) -> None:
        """
        Shared teardown logic for kick and ban:
          1. Record a LiveKit revocation marker and remove from Redis.
          2. Call LiveKit to disconnect the participant.
          3. Mark left_at in DB.
          4. Clear user's active room.
          5. Publish event.
        """
        # Record the revocation BEFORE disconnecting so a reconnect racing
        # the kick with a still-valid join token is rejected by the
        # ``participant_joined`` webhook.
        await self.redis.mark_livekit_revocation(
            room_id,
            fid,
            RedisService.LIVEKIT_REVOCATION_REMOVED,
            LIVEKIT_REVOCATION_TTL_SECONDS,
        )

        # Redis cleanup — before the LiveKit kick, so a stale-token
        # reconnect landing mid-teardown finds no participant row and the
        # admission webhook falls through to the ``removed`` marker.
        await self.redis.remove_participant(room_id, fid)
        await self.redis.remove_from_hand_queue(room_id, fid)
        await self.redis.clear_user_active_room(fid)

        # LiveKit removal (best-effort; participant may have already disconnected)
        try:
            await self.livekit.kick_participant(room_id=room_id, identity=str(fid))
        except Exception:
            logger.warning(
                "LiveKit kick failed for fid=%s in room %s (may already be disconnected)",
                fid,
                room_id,
            )

        # DB update
        now = _utcnow()
        await self.db.execute(
            update(Participant)
            .where(
                Participant.room_id == uuid.UUID(room_id),
                Participant.fid == fid,
                Participant.left_at.is_(None),
            )
            .values(left_at=now)
        )
        await self.db.commit()

        # Publish event
        event_payload: dict = {
            "event": event_name,
            "room_id": room_id,
            "fid": fid,
        }
        if extra_event_fields:
            event_payload.update(extra_event_fields)

        await self.redis.publish_room_event(room_id, event_payload)
