"""Re-validate LiveKit participants when they (re)connect.

LiveKit join tokens can't be revoked: kick / ban / demote only act on the
live connection, so a user holding a still-valid token could reconnect
(or keep a speaker grant) after being removed. LiveKit's
``participant_joined`` webhook fires for every connect, so we compare the
connecting identity against Juke's authoritative state and correct it:

* Active DB ban                                 -> remove from the room.
* Redis participant row present                 -> Redis role wins; a
  publish grant the role doesn't allow is downgraded to listener.
* No Redis row + ``removed`` revocation marker  -> remove (kicked/banned).
* No Redis row + ``listener`` revocation marker -> downgrade (demoted).
* No Redis row and no marker                    -> leave alone.

The last case is deliberately permissive. During an SDK-internal full
reconnect LiveKit may deliver ``participant_left`` (which clears the Redis
row) before the new ``participant_joined``; removing on "row missing"
would drop legitimate listeners and speakers mid-space. Short token TTLs
bound what a stale token can do in that case.

We never *upgrade* a participant here — promotion always goes through
the explicit promote path.
"""

from __future__ import annotations

import enum
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ban import Ban
from app.services.livekit_service import LiveKitService
from app.services.redis_service import RedisService

logger = logging.getLogger(__name__)

PUBLISHING_ROLES = frozenset({"host", "co_host", "speaker"})


class AdmissionAction(str, enum.Enum):
    ALLOW = "allow"
    REMOVE = "remove"
    DOWNGRADE = "downgrade"


def _has_permission_field(participant: Any) -> bool:
    has_field = getattr(participant, "HasField", None)
    if callable(has_field):
        try:
            return bool(has_field("permission"))
        except ValueError:
            return False
    return getattr(participant, "permission", None) is not None


def _participant_can_publish(participant: Any) -> bool:
    """Whether the connecting participant holds a publish grant.

    Prefers the server-reported ``permission.can_publish``; falls back to
    the role baked into the token metadata when permission is absent.
    """
    if _has_permission_field(participant):
        return bool(participant.permission.can_publish)
    raw_metadata = getattr(participant, "metadata", None) or ""
    try:
        metadata = json.loads(raw_metadata) if raw_metadata else {}
    except (json.JSONDecodeError, TypeError):
        metadata = {}
    return isinstance(metadata, dict) and metadata.get("role") in PUBLISHING_ROLES


async def _has_active_ban(db: AsyncSession, room_id: str, fid: int) -> bool:
    try:
        room_uuid = uuid.UUID(room_id)
    except (TypeError, ValueError):
        return False
    result = await db.execute(
        select(Ban).where(Ban.room_id == room_uuid, Ban.banned_fid == fid)
    )
    ban = result.scalar_one_or_none()
    if ban is None:
        return False
    return ban.expires_at is None or ban.expires_at > datetime.now(timezone.utc)


async def decide_admission(
    *,
    db: AsyncSession,
    redis_service: RedisService,
    room_id: str,
    fid: int,
    participant: Any,
) -> AdmissionAction:
    """Pure decision step (no LiveKit side effects) for testability."""
    if await _has_active_ban(db, room_id, fid):
        return AdmissionAction.REMOVE

    can_publish = _participant_can_publish(participant)
    redis_participant = await redis_service.get_participant(room_id, fid)
    if redis_participant is not None:
        allowed_to_publish = redis_participant.get("role") in PUBLISHING_ROLES
        if can_publish and not allowed_to_publish:
            return AdmissionAction.DOWNGRADE
        return AdmissionAction.ALLOW

    revocation = await redis_service.get_livekit_revocation(room_id, fid)
    if revocation == RedisService.LIVEKIT_REVOCATION_REMOVED:
        return AdmissionAction.REMOVE
    if revocation == RedisService.LIVEKIT_REVOCATION_LISTENER and can_publish:
        return AdmissionAction.DOWNGRADE
    return AdmissionAction.ALLOW


async def enforce_admission(
    *,
    db: AsyncSession,
    redis_service: RedisService,
    livekit: LiveKitService,
    room_id: str,
    fid: int,
    participant: Any,
) -> AdmissionAction:
    """Decide and apply. LiveKit API failures are logged, not raised, so a
    LiveKit hiccup never 500s the webhook (LiveKit would just retry)."""
    action = await decide_admission(
        db=db,
        redis_service=redis_service,
        room_id=room_id,
        fid=fid,
        participant=participant,
    )
    if action is AdmissionAction.ALLOW:
        return action

    identity = str(fid)
    try:
        if action is AdmissionAction.REMOVE:
            await livekit.kick_participant(room_id=room_id, identity=identity)
        else:
            await livekit.update_permissions(
                room_id=room_id,
                identity=identity,
                can_publish=False,
                role="listener",
            )
    except Exception:
        logger.exception(
            "LiveKit admission enforcement (%s) failed for fid=%s in room %s",
            action.value,
            fid,
            room_id,
        )
        return action

    logger.warning(
        "LiveKit admission: %s fid=%s in room %s (stale or revoked grant)",
        action.value,
        fid,
        room_id,
    )
    return action
