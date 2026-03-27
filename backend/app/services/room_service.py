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

import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.ban import Ban
from app.models.participant import Participant
from app.models.room import Room
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
    RoomListResponse,
    RoomResponse,
)
from app.services import permission_service
from app.services.livekit_service import LiveKitService
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


# ---------------------------------------------------------------------------
# RoomService
# ---------------------------------------------------------------------------


class RoomService:
    def __init__(self, db: AsyncSession, redis: RedisService, livekit: LiveKitService):
        self.db = db
        self.redis = redis
        self.livekit = livekit

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    async def create_room(
        self,
        fid: int,
        title: str,
        announce_cast: bool = False,
    ) -> RoomCreateResponse:
        """
        Create a new audio room.

        Steps:
          1. Fetch the host user from DB.
          2. Persist the Room row.
          3. Create the LiveKit room.
          4. Seed Redis state.
          5. Register the host as the first participant (role=host).
          6. Return room data + LiveKit token + WS URL.
        """
        host = await self._get_user(fid)

        room = Room(
            title=title,
            host_fid=fid,
            status="active",
        )
        self.db.add(room)
        await self.db.flush()  # populate room.id without committing

        room_id = _room_id_str(room.id)

        # Create the LiveKit room (best-effort; roll back if it fails)
        try:
            await self.livekit.create_room(room_id=room_id, title=title)
        except Exception as exc:
            logger.exception("LiveKit room creation failed for room %s", room_id)
            await self.db.rollback()
            raise HTTPException(status_code=502, detail="Failed to create media room") from exc

        room.livekit_room_id = room_id
        await self.db.commit()
        await self.db.refresh(room)

        # Seed Redis state
        started_ts = room.started_at.timestamp() if room.started_at else _utcnow().timestamp()
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
        is_demo_user = host.signer_uuid == "demo-readonly"
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
                webhook_id, webhook_secret = await self._register_cast_webhook(room_id, cast_hash)
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

        room_response = await self._build_room_response(room, host, speaker_count, listener_count)

        logger.info("Room %s created by fid=%s", room_id, fid)
        return RoomCreateResponse(
            room=room_response,
            livekit_token=token,
            livekit_ws_url=settings.LIVEKIT_WS_URL,
        )

    async def get_room(self, room_id: str) -> RoomDetailResponse:
        """
        Fetch room details including live participant list and hand queue from Redis.
        """
        room = await self._get_room_or_404(room_id)
        host = await self._get_user(room.host_fid)

        participants_data = await self.redis.get_all_participants(room_id)
        hand_queue = await self.redis.get_hand_queue(room_id)

        speaker_count = sum(
            1 for p in participants_data if p.get("role") in ("host", "co_host", "speaker")
        )
        listener_count = sum(1 for p in participants_data if p.get("role") == "listener")

        room_response = await self._build_room_response(room, host, speaker_count, listener_count)

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
                logger.warning("Skipping malformed room_id in active_rooms set: %s", rid)

        result = await self.db.execute(select(Room).where(Room.id.in_(uuids)))
        rooms_by_id: dict[str, Room] = {_room_id_str(r.id): r for r in result.scalars().all()}

        # Preserve Redis ordering
        rooms = []
        for rid in page_ids:
            room = rooms_by_id.get(rid)
            if room is None:
                # Stale entry — clean up asynchronously (fire-and-forget is fine here)
                logger.warning("Room %s in Redis active set but missing from DB", rid)
                continue
            host = await self._get_user(room.host_fid)
            speaker_count = await self.redis.get_speaker_count(rid)
            listener_count = await self.redis.get_listener_count(rid)
            room_response = await self._build_room_response(
                room, host, speaker_count, listener_count
            )
            rooms.append(room_response)

        next_cursor = str(cursor + limit) if has_more else None

        return RoomListResponse(rooms=rooms, next_cursor=next_cursor)

    async def end_room(self, room_id: str, fid: int) -> None:
        """
        End an active room. Only hosts and co-hosts may do this.
        """
        room = await self._get_room_or_404(room_id)

        actor_role = await self._get_actor_role(room_id, fid)
        if not permission_service.can_end_room(actor_role):
            raise HTTPException(status_code=403, detail="Only hosts and co-hosts can end the room")

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
            logger.exception("Failed to delete LiveKit room %s during end_room", room_id)

        # Publish event before clearing state so subscribers receive it
        await self.redis.publish_room_event(
            room_id,
            {"event": "room_ended", "room_id": room_id, "ended_by_fid": fid},
        )

        # Clear all Redis state (also clears user active rooms)
        await self.redis.clear_room_state(room_id)

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
                1 for p in participants_data if p.get("role") in ("host", "co_host", "speaker")
            )
            listener_count = sum(1 for p in participants_data if p.get("role") == "listener")
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
            1 for p in participants_data if p.get("role") in ("host", "co_host", "speaker")
        )
        listener_count = sum(1 for p in participants_data if p.get("role") == "listener")
        room_response = await self._build_room_response(room, host, speaker_count, listener_count)

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
            role=role,
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
            now = _utcnow()
            await self.db.execute(
                update(Room)
                .where(Room.id == uuid.UUID(room_id), Room.status == "active")
                .values(status="ended", ended_at=now)
            )
            await self.db.commit()
            await self.redis.clear_room_state(room_id)
            logger.info("Room %s auto-ended (no participants remaining)", room_id)

    async def raise_hand(self, room_id: str, fid: int, raised: bool) -> RaiseHandResponse:
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

        logger.info("fid=%s promoted to speaker in room %s by fid=%s", target_fid, room_id, actor_fid)
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

        logger.info("fid=%s demoted to listener in room %s by fid=%s", target_fid, room_id, actor_fid)
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
            await self.livekit.mute_participant(room_id=room_id, identity=str(target_fid))
        except Exception:
            logger.exception(
                "LiveKit mute failed for fid=%s in room %s", target_fid, room_id
            )
            raise HTTPException(status_code=502, detail="Failed to mute participant via media server")

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

        logger.info("fid=%s kicked from room %s by fid=%s", target_fid, room_id, actor_fid)

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

    async def refresh_token(self, room_id: str, fid: int) -> TokenRefreshResponse:
        """
        Issue a fresh LiveKit token for a participant currently in the room.
        """
        await self._get_room_or_404(room_id)

        participant = await self.redis.get_participant(room_id, fid)
        if not participant:
            raise HTTPException(status_code=403, detail="You are not an active participant in this room")

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
            raise HTTPException(status_code=404, detail=f"User with fid={fid} not found")
        return user

    async def _build_room_response(
        self,
        room: Room,
        host: User,
        speaker_count: int,
        listener_count: int,
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
            speaker_count=speaker_count,
            listener_count=listener_count,
            recording=room.recording,
            cast_hash=room.cast_hash,
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
                logger.info("Registered Neynar webhook %s for room %s", webhook_id, room_id)
                return webhook_id, webhook_secret
        except Exception as e:
            logger.warning("Failed to register Neynar webhook for room %s: %s", room_id, e)
            return None, None

    async def _delete_cast_webhook(self, webhook_id: str) -> None:
        """Delete a Neynar webhook. Best-effort; failures are logged."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.delete(
                    f"https://api.neynar.com/v2/farcaster/webhook",
                    params={"webhook_id": webhook_id},
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
