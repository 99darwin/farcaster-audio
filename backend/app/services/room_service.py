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
from sqlalchemy import delete, func as sa_func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import DEMO_SIGNER_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.ban import Ban
from app.models.participant import Participant
from app.models.room import Room
from app.models.room_rsvp import RoomRsvp
from app.models.user import User
from app.schemas.auth import UserResponse
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
from app.services import permission_service
from app.services.livekit_service import LiveKitService
from app.services.push_service import PushService
from app.services.redis_service import RedisService

logger = logging.getLogger(__name__)


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
    return (_utcnow() + timedelta(hours=6)).isoformat()


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
    def __init__(self, db: AsyncSession, redis: RedisService, livekit: LiveKitService):
        self.db = db
        self.redis = redis
        self.livekit = livekit
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
        elif announce_cast:
            cast_hash = await self._announce_room(room_id, title, host)
            if cast_hash:
                webhook_id, webhook_secret = await self._register_cast_webhook(
                    room_id, cast_hash
                )
                await self.db.execute(
                    update(Room)
                    .where(Room.id == room.id)
                    .values(
                        cast_hash=cast_hash,
                        neynar_webhook_id=webhook_id,
                        neynar_webhook_secret=webhook_secret,
                    )
                )
                await self.db.commit()
                await self.db.refresh(room)

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
        logger.info("Room %s created by fid=%s", room_id, fid)
        return RoomCreateResponse(
            room=room_response,
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
            expires_at=_livekit_expires_at(),
        )

    async def start_scheduled_room(self, room_id: str, fid: int) -> RoomGoLiveResponse:
        """
        Transition a scheduled room to active. Only the host may call this.

        Creates LiveKit room, seeds Redis, registers host as first participant,
        and returns a LiveKit token so the host can connect.
        """
        room = await self._get_room_or_404(room_id)

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
            rsvp_fids = await self._get_rsvp_fids(room.id)
            for target_fid in rsvp_fids:
                if target_fid == fid:
                    continue
                try:
                    await self.push.send_push(
                        fid=target_fid,
                        title="Space is Live",
                        body=f'"{room.title}" is now live \u2014 join now!',
                        data={"type": "space_live", "url": f"/space/{str(room.id)}"},
                    )
                except Exception:
                    pass  # best-effort
        except Exception:
            pass  # don't block go-live

        await self.redis.publish_room_discovery_event(
            _room_discovery_event(room_id, "room_started", "active")
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

        speaker_count = sum(
            1
            for p in participants_data
            if p.get("role") in ("host", "co_host", "speaker")
        )
        listener_count = sum(
            1 for p in participants_data if p.get("role") == "listener"
        )

        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        participants = [
            ParticipantResponse(
                fid=p["fid"],
                role=p["role"],
                is_muted=p.get("is_muted", True),
                hand_raised=p.get("hand_raised", False),
                display_name=p.get("display_name", str(p["fid"])),
                pfp_url=p.get("pfp_url"),
            )
            for p in participants_data
        ]

        return RoomDetailResponse(
            room=room_response,
            participants=participants,
            hand_queue=hand_queue,
        )

    async def list_scheduled_rooms(
        self,
        limit: int = 20,
        cursor: int = 0,
    ) -> RoomListResponse:
        """Return upcoming scheduled rooms ordered by scheduled_at ASC."""
        now = _utcnow()
        query = (
            select(Room)
            .where(Room.status == "scheduled", Room.scheduled_at >= now)
            .order_by(Room.scheduled_at.asc())
            .offset(cursor)
            .limit(limit + 1)
        )
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
    ) -> RoomListResponse:
        """
        Return paginated active rooms sorted by recency (newest first).

        `cursor` is a zero-based offset into the Redis sorted set.
        """
        room_id_strs = await self.redis.get_active_rooms(limit=limit + 1, offset=cursor)

        has_more = len(room_id_strs) > limit
        page_ids = room_id_strs[:limit]

        if not page_ids:
            return RoomListResponse(rooms=[], next_cursor=None)

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
        ordered_rooms = [rooms_by_id[rid] for rid in page_ids if rid in rooms_by_id]
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
            host = hosts_by_fid.get(room.host_fid)
            if host is None:
                raise HTTPException(
                    status_code=404, detail=f"User with fid={room.host_fid} not found"
                )
            speaker_count, listener_count = count_map.get(rid, (0, 0))
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            rooms.append(room_response)

        next_cursor = str(cursor + limit) if has_more else None

        return RoomListResponse(rooms=rooms, next_cursor=next_cursor)

    async def register_rsvp(self, room_id: str, fid: int) -> RsvpResponse:
        """RSVP to a scheduled room. Idempotent (uses INSERT ON CONFLICT DO NOTHING)."""
        room = await self._get_room_or_404(room_id)
        if room.status != "scheduled":
            raise HTTPException(
                status_code=400, detail="RSVPs are only available for scheduled rooms"
            )

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

        # Redis TTL: match the LiveKit token TTL ceiling (6h) — long enough to
        # outlast any reasonable room while preventing orphaned keys.
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

    async def end_room(self, room_id: str, fid: int) -> None:
        """
        End an active room or cancel a scheduled room.

        Scheduled rooms have no Redis/LiveKit state, so only a DB update is needed.
        Active rooms require full teardown (LiveKit, Redis, webhooks).
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

        # Clean up Neynar webhook (best-effort)
        if room.neynar_webhook_id:
            await self._delete_cast_webhook(room.neynar_webhook_id)

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
        logger.info("Room %s ended by fid=%s", room_id, fid)

    async def join_room(self, room_id: str, fid: int) -> JoinResponse:
        """
        Join an active room as a listener.

        Checks:
          - Room exists and is active.
          - User is not banned.
          - User is not already an active participant (idempotent re-join returns existing token).
        """
        room = await self._get_room_or_404(room_id)

        if room.status != "active":
            raise HTTPException(status_code=400, detail="Room is not active")

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
            speaker_count = sum(
                1
                for p in participants_data
                if p.get("role") in ("host", "co_host", "speaker")
            )
            listener_count = sum(
                1 for p in participants_data if p.get("role") == "listener"
            )
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            participants = [
                ParticipantResponse(
                    fid=p["fid"],
                    role=p["role"],
                    is_muted=p.get("is_muted", True),
                    hand_raised=p.get("hand_raised", False),
                    display_name=p.get("display_name", str(p["fid"])),
                    pfp_url=p.get("pfp_url"),
                )
                for p in participants_data
            ]
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

        participants_data = await self.redis.get_all_participants(room_id)
        host = await self._get_user(room.host_fid)
        speaker_count = sum(
            1
            for p in participants_data
            if p.get("role") in ("host", "co_host", "speaker")
        )
        listener_count = sum(
            1 for p in participants_data if p.get("role") == "listener"
        )
        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        participants = [
            ParticipantResponse(
                fid=p["fid"],
                role=p["role"],
                is_muted=p.get("is_muted", True),
                hand_raised=p.get("hand_raised", False),
                display_name=p.get("display_name", str(p["fid"])),
                pfp_url=p.get("pfp_url"),
            )
            for p in participants_data
        ]

        logger.info("fid=%s joined room %s", fid, room_id)
        return JoinResponse(
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
            expires_at=_livekit_expires_at(),
            role=role,
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

        display_name = agent_name

        # Idempotency: if already in Redis, return a fresh token
        existing = await self.redis.get_participant(room_id, agent_fid)
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
            speaker_count = sum(
                1
                for p in participants_data
                if p.get("role") in ("host", "co_host", "speaker")
            )
            listener_count = sum(
                1 for p in participants_data if p.get("role") == "listener"
            )
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            participants = [
                ParticipantResponse(
                    fid=p["fid"],
                    role=p["role"],
                    is_muted=p.get("is_muted", True),
                    hand_raised=p.get("hand_raised", False),
                    display_name=p.get("display_name", str(p["fid"])),
                    pfp_url=p.get("pfp_url"),
                )
                for p in participants_data
            ]
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

        participants_data = await self.redis.get_all_participants(room_id)
        host = await self._get_user(room.host_fid)
        speaker_count = sum(
            1
            for p in participants_data
            if p.get("role") in ("host", "co_host", "speaker")
        )
        listener_count = sum(
            1 for p in participants_data if p.get("role") == "listener"
        )
        room_response = await self._build_room_response(
            room, host, speaker_count, listener_count
        )

        participants = [
            ParticipantResponse(
                fid=p["fid"],
                role=p["role"],
                is_muted=p.get("is_muted", True),
                hand_raised=p.get("hand_raised", False),
                display_name=p.get("display_name", str(p["fid"])),
                pfp_url=p.get("pfp_url"),
            )
            for p in participants_data
        ]

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
        await self._get_room_or_404(room_id)

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

            if room.neynar_webhook_id:
                await self._delete_cast_webhook(room.neynar_webhook_id)

            await self.redis.clear_room_state(room_id)
            logger.info("Room %s auto-ended (no participants remaining)", room_id)

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

        if room.neynar_webhook_id:
            await self._delete_cast_webhook(room.neynar_webhook_id)

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
        """Return all active rooms from DB (admin view, no pagination)."""
        result = await self.db.execute(
            select(Room).where(Room.status == "active").order_by(Room.started_at.desc())
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

        # Token TTL is 6 hours (matches LiveKitService.generate_token)
        expires_at = _utcnow() + timedelta(hours=6)

        return TokenRefreshResponse(
            livekit_token=token,
            expires_at=expires_at.isoformat(),
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
            custody_address=host.custody_address,
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
        )

    async def _announce_room(self, room_id: str, title: str, user: User) -> str | None:
        """Post announcement cast to Farcaster. Returns cast_hash or None."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://api.neynar.com/v2/farcaster/cast",
                    json={
                        "signer_uuid": user.signer_uuid,
                        "text": f"Live now: {title}\n\nListen on Juke",
                        "embeds": [{"url": "https://juke.audio"}],
                    },
                    headers={"api_key": settings.NEYNAR_API_KEY},
                )
                resp.raise_for_status()
                data = resp.json()
                return data.get("cast", {}).get("hash")
        except Exception as e:
            logger.warning("Failed to announce room: %s", e)
            return None

    async def _announce_room_scheduled(
        self, room_id: str, title: str, user: User, scheduled_label: str
    ) -> str | None:
        """Post announcement cast for a scheduled space. Returns cast_hash or None."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://api.neynar.com/v2/farcaster/cast",
                    json={
                        "signer_uuid": user.signer_uuid,
                        "text": f"Upcoming space: {title}\n\nStarts {scheduled_label}\n\nJoin on Juke",
                        "embeds": [{"url": f"https://juke.audio/space/{room_id}"}],
                    },
                    headers={"api_key": settings.NEYNAR_API_KEY},
                )
                resp.raise_for_status()
                data = resp.json()
                return data.get("cast", {}).get("hash")
        except Exception as e:
            logger.warning("Failed to announce scheduled room: %s", e)
            return None

    async def _register_cast_webhook(
        self, room_id: str, cast_hash: str
    ) -> tuple[str | None, str | None]:
        """Register a Neynar webhook to listen for replies to the announcement cast.
        Returns (webhook_id, webhook_secret) or (None, None) on failure."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://api.neynar.com/v2/farcaster/webhook",
                    json={
                        "name": f"space-replies-{room_id[:8]}",
                        "url": f"{settings.API_BASE_URL}/v1/webhooks/neynar",
                        "subscription": {
                            "cast.created": {
                                "parent_hashes": [cast_hash],
                            },
                        },
                    },
                    headers={"x-api-key": settings.NEYNAR_API_KEY},
                )
                resp.raise_for_status()
                webhook = resp.json().get("webhook", {})
                webhook_id = webhook.get("webhook_id")
                webhook_secret = webhook.get("secret")
                logger.info(
                    "Registered Neynar webhook %s for room %s", webhook_id, room_id
                )
                return webhook_id, webhook_secret
        except Exception as e:
            logger.warning(
                "Failed to register Neynar webhook for room %s: %s", room_id, e
            )
            return None, None

    async def _delete_cast_webhook(self, webhook_id: str) -> None:
        """Delete a Neynar webhook. Best-effort; failures are logged."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.request(
                    "DELETE",
                    "https://api.neynar.com/v2/farcaster/webhook",
                    json={"webhook_id": webhook_id},
                    headers={"x-api-key": settings.NEYNAR_API_KEY},
                )
                resp.raise_for_status()
                logger.info("Deleted Neynar webhook %s", webhook_id)
        except Exception as e:
            logger.warning("Failed to delete Neynar webhook %s: %s", webhook_id, e)

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
          1. Call LiveKit to disconnect the participant.
          2. Remove from Redis.
          3. Mark left_at in DB.
          4. Clear user's active room.
          5. Publish event.
        """
        # LiveKit removal (best-effort; participant may have already disconnected)
        try:
            await self.livekit.kick_participant(room_id=room_id, identity=str(fid))
        except Exception:
            logger.warning(
                "LiveKit kick failed for fid=%s in room %s (may already be disconnected)",
                fid,
                room_id,
            )

        # Redis cleanup
        await self.redis.remove_participant(room_id, fid)
        await self.redis.remove_from_hand_queue(room_id, fid)
        await self.redis.clear_user_active_room(fid)

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
