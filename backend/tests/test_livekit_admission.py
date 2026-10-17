"""SECURITY (H3): short LiveKit TTL + participant_joined re-validation.

Join tokens can't be revoked, so a kicked/banned/demoted user could
replay a still-valid token. These tests cover:

* the 15-minute token TTL and the ``expires_at`` the clients refresh on,
* kick/ban/demote writing revocation markers (and fresh grants clearing them),
* ``decide_admission`` / ``enforce_admission`` for every branch,
* the LiveKit webhook enforcing admission before dev-webhook dispatch.
"""

from __future__ import annotations

import inspect
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.models.ban import Ban
from app.routers import webhooks
from app.services import livekit_admission_service as admission
from app.services import room_service as room_service_module
from app.services.livekit_admission_service import (
    AdmissionAction,
    decide_admission,
    enforce_admission,
)
from app.services.livekit_service import PARTICIPANT_TOKEN_TTL
from app.services.redis_service import RedisService

ROOM_ID = str(uuid.uuid4())
FID = 4242


# ---------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------


class _MemoryRedis:
    """Just enough of ``redis.asyncio.Redis`` for RedisService here."""

    def __init__(self) -> None:
        self.values: dict[str, Any] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.expiry: dict[str, int] = {}

    async def get(self, key: str) -> Any:
        return self.values.get(key)

    async def set(self, key: str, value: Any, ex: int | None = None) -> None:
        self.values[key] = value.encode() if isinstance(value, str) else value
        if ex is not None:
            self.expiry[key] = ex

    async def delete(self, key: str) -> None:
        self.values.pop(key, None)

    async def hget(self, key: str, field: str) -> str | None:
        return self.hashes.get(key, {}).get(field)

    async def hset(self, key: str, field: str, value: str) -> None:
        self.hashes.setdefault(key, {})[field] = value


class _BanResult:
    def __init__(self, ban: Ban | None) -> None:
        self._ban = ban

    def scalar_one_or_none(self) -> Ban | None:
        return self._ban


class _FakeDb:
    def __init__(self, ban: Ban | None = None) -> None:
        self.ban = ban

    async def execute(self, _stmt: Any) -> _BanResult:
        return _BanResult(self.ban)


def _redis_service() -> RedisService:
    return RedisService(_MemoryRedis())  # type: ignore[arg-type]


def _participant(
    *, can_publish: bool | None = None, role: str | None = None
) -> SimpleNamespace:
    """LiveKit ParticipantInfo stand-in. ``can_publish=None`` means the
    webhook omitted the permission block (role metadata fallback)."""
    permission = (
        None if can_publish is None else SimpleNamespace(can_publish=can_publish)
    )
    metadata = json.dumps({"role": role}) if role else ""
    return SimpleNamespace(identity=str(FID), permission=permission, metadata=metadata)


def _ban(expires_at: datetime | None = None) -> Ban:
    return Ban(
        room_id=uuid.UUID(ROOM_ID),
        banned_fid=FID,
        banned_by_fid=1,
        expires_at=expires_at,
    )


async def _decide(
    *,
    db: _FakeDb | None = None,
    redis_service: RedisService | None = None,
    participant: SimpleNamespace | None = None,
) -> AdmissionAction:
    return await decide_admission(
        db=db or _FakeDb(),  # type: ignore[arg-type]
        redis_service=redis_service or _redis_service(),
        room_id=ROOM_ID,
        fid=FID,
        participant=participant or _participant(can_publish=False),
    )


# ---------------------------------------------------------------------
# TTL
# ---------------------------------------------------------------------


def test_participant_token_ttl_is_short():
    assert PARTICIPANT_TOKEN_TTL == timedelta(minutes=15)


def test_revocation_marker_outlives_token():
    assert room_service_module.LIVEKIT_REVOCATION_TTL_SECONDS > (
        PARTICIPANT_TOKEN_TTL.total_seconds()
    )


def test_livekit_expires_at_tracks_token_ttl():
    """Clients refresh 5 minutes before ``expires_at``; it must reflect
    the real 15-minute token lifetime, not the old 6 hours."""
    before = datetime.now(timezone.utc)
    expires = datetime.fromisoformat(room_service_module._livekit_expires_at())
    delta = expires - before
    assert timedelta(minutes=14) < delta <= timedelta(minutes=15, seconds=5)


def test_generate_token_uses_ttl_constant():
    from app.services.livekit_service import LiveKitService

    src = inspect.getsource(LiveKitService.generate_token)
    assert "with_ttl(PARTICIPANT_TOKEN_TTL)" in src
    assert "hours=6" not in src


# ---------------------------------------------------------------------
# Redis revocation markers
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revocation_marker_roundtrip_and_clear():
    redis_service = _redis_service()
    await redis_service.mark_livekit_revocation(
        ROOM_ID, FID, RedisService.LIVEKIT_REVOCATION_REMOVED, 1200
    )
    assert (
        await redis_service.get_livekit_revocation(ROOM_ID, FID)
        == RedisService.LIVEKIT_REVOCATION_REMOVED
    )
    key = redis_service.livekit_revocation_key(ROOM_ID, FID)
    assert redis_service.redis.expiry[key] == 1200  # type: ignore[attr-defined]
    await redis_service.clear_livekit_revocation(ROOM_ID, FID)
    assert await redis_service.get_livekit_revocation(ROOM_ID, FID) is None


def test_kick_and_ban_mark_removed_before_livekit_kick():
    src = inspect.getsource(
        room_service_module.RoomService._remove_participant_from_room
    )
    mark = src.index("LIVEKIT_REVOCATION_REMOVED")
    remove_row = src.index("self.redis.remove_participant")
    kick = src.index("self.livekit.kick_participant")
    # Row removed before the kick so a mid-teardown reconnect hits the marker.
    assert remove_row < kick
    assert mark < kick


def test_demote_marks_listener():
    src = inspect.getsource(room_service_module.RoomService.demote_participant)
    assert "LIVEKIT_REVOCATION_LISTENER" in src


@pytest.mark.parametrize(
    "method", ["join_room", "join_room_as_agent", "promote_participant"]
)
def test_fresh_grants_clear_revocation_marker(method):
    src = inspect.getsource(getattr(room_service_module.RoomService, method))
    assert "clear_livekit_revocation" in src


# ---------------------------------------------------------------------
# decide_admission
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_active_ban_removes_even_with_redis_row():
    redis_service = _redis_service()
    await redis_service.set_participant(ROOM_ID, FID, {"role": "speaker"})
    action = await _decide(db=_FakeDb(_ban()), redis_service=redis_service)
    assert action is AdmissionAction.REMOVE


@pytest.mark.asyncio
async def test_expired_ban_is_ignored():
    expired = _ban(datetime.now(timezone.utc) - timedelta(minutes=1))
    assert await _decide(db=_FakeDb(expired)) is AdmissionAction.ALLOW


@pytest.mark.asyncio
async def test_redis_role_allows_matching_publish_grant():
    redis_service = _redis_service()
    await redis_service.set_participant(ROOM_ID, FID, {"role": "speaker"})
    action = await _decide(
        redis_service=redis_service, participant=_participant(can_publish=True)
    )
    assert action is AdmissionAction.ALLOW


@pytest.mark.asyncio
async def test_redis_listener_with_stale_speaker_grant_is_downgraded():
    redis_service = _redis_service()
    await redis_service.set_participant(ROOM_ID, FID, {"role": "listener"})
    action = await _decide(
        redis_service=redis_service, participant=_participant(can_publish=True)
    )
    assert action is AdmissionAction.DOWNGRADE


@pytest.mark.asyncio
async def test_redis_row_wins_over_stale_marker():
    """A user kicked then legitimately re-joined isn't removed again."""
    redis_service = _redis_service()
    await redis_service.mark_livekit_revocation(
        ROOM_ID, FID, RedisService.LIVEKIT_REVOCATION_REMOVED, 1200
    )
    await redis_service.set_participant(ROOM_ID, FID, {"role": "listener"})
    assert await _decide(redis_service=redis_service) is AdmissionAction.ALLOW


@pytest.mark.asyncio
async def test_removed_marker_without_row_removes():
    redis_service = _redis_service()
    await redis_service.mark_livekit_revocation(
        ROOM_ID, FID, RedisService.LIVEKIT_REVOCATION_REMOVED, 1200
    )
    assert await _decide(redis_service=redis_service) is AdmissionAction.REMOVE


@pytest.mark.asyncio
async def test_listener_marker_downgrades_publisher_only():
    redis_service = _redis_service()
    await redis_service.mark_livekit_revocation(
        ROOM_ID, FID, RedisService.LIVEKIT_REVOCATION_LISTENER, 1200
    )
    assert (
        await _decide(
            redis_service=redis_service, participant=_participant(can_publish=True)
        )
        is AdmissionAction.DOWNGRADE
    )
    assert (
        await _decide(
            redis_service=redis_service, participant=_participant(can_publish=False)
        )
        is AdmissionAction.ALLOW
    )


@pytest.mark.asyncio
async def test_no_row_no_marker_is_left_alone():
    """participant_left can beat participant_joined during an SDK full
    reconnect; a missing row alone must never drop a live speaker."""
    action = await _decide(participant=_participant(can_publish=True))
    assert action is AdmissionAction.ALLOW


@pytest.mark.asyncio
async def test_metadata_role_fallback_when_permission_absent():
    redis_service = _redis_service()
    await redis_service.set_participant(ROOM_ID, FID, {"role": "listener"})
    action = await _decide(
        redis_service=redis_service, participant=_participant(role="speaker")
    )
    assert action is AdmissionAction.DOWNGRADE


@pytest.mark.asyncio
async def test_non_uuid_room_skips_ban_lookup():
    assert not await admission._has_active_ban(
        _FakeDb(_ban()), "not-a-uuid", FID  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------
# enforce_admission
# ---------------------------------------------------------------------


def _livekit() -> SimpleNamespace:
    return SimpleNamespace(kick_participant=AsyncMock(), update_permissions=AsyncMock())


async def _enforce(
    redis_service: RedisService, participant: SimpleNamespace, livekit: Any
) -> AdmissionAction:
    return await enforce_admission(
        db=_FakeDb(),  # type: ignore[arg-type]
        redis_service=redis_service,
        livekit=livekit,
        room_id=ROOM_ID,
        fid=FID,
        participant=participant,
    )


@pytest.mark.asyncio
async def test_enforce_remove_kicks():
    redis_service = _redis_service()
    await redis_service.mark_livekit_revocation(
        ROOM_ID, FID, RedisService.LIVEKIT_REVOCATION_REMOVED, 1200
    )
    livekit = _livekit()
    action = await _enforce(redis_service, _participant(can_publish=False), livekit)
    assert action is AdmissionAction.REMOVE
    livekit.kick_participant.assert_awaited_once_with(
        room_id=ROOM_ID, identity=str(FID)
    )
    livekit.update_permissions.assert_not_awaited()


@pytest.mark.asyncio
async def test_enforce_downgrade_revokes_publish():
    redis_service = _redis_service()
    await redis_service.set_participant(ROOM_ID, FID, {"role": "listener"})
    livekit = _livekit()
    action = await _enforce(redis_service, _participant(can_publish=True), livekit)
    assert action is AdmissionAction.DOWNGRADE
    livekit.update_permissions.assert_awaited_once_with(
        room_id=ROOM_ID, identity=str(FID), can_publish=False, role="listener"
    )
    livekit.kick_participant.assert_not_awaited()


@pytest.mark.asyncio
async def test_enforce_allow_has_no_side_effects():
    livekit = _livekit()
    action = await _enforce(_redis_service(), _participant(can_publish=True), livekit)
    assert action is AdmissionAction.ALLOW
    livekit.kick_participant.assert_not_awaited()
    livekit.update_permissions.assert_not_awaited()


@pytest.mark.asyncio
async def test_enforce_swallows_livekit_errors():
    redis_service = _redis_service()
    await redis_service.mark_livekit_revocation(
        ROOM_ID, FID, RedisService.LIVEKIT_REVOCATION_REMOVED, 1200
    )
    livekit = _livekit()
    livekit.kick_participant.side_effect = RuntimeError("livekit down")
    action = await _enforce(redis_service, _participant(can_publish=False), livekit)
    assert action is AdmissionAction.REMOVE


# ---------------------------------------------------------------------
# Webhook wiring
# ---------------------------------------------------------------------


class _FakeLiveKitService:
    instances: list["_FakeLiveKitService"] = []

    def __init__(self) -> None:
        self.closed = False
        _FakeLiveKitService.instances.append(self)

    async def close(self) -> None:
        self.closed = True


def _joined_event(identity: str) -> SimpleNamespace:
    return SimpleNamespace(
        room=SimpleNamespace(name=ROOM_ID),
        participant=SimpleNamespace(identity=identity),
    )


@pytest.fixture
def webhook_spies(monkeypatch):
    _FakeLiveKitService.instances = []
    enforce = AsyncMock(return_value=AdmissionAction.ALLOW)
    load_room = AsyncMock(return_value=None)
    monkeypatch.setattr(webhooks, "LiveKitService", _FakeLiveKitService)
    monkeypatch.setattr(webhooks, "enforce_admission", enforce)
    monkeypatch.setattr(webhooks, "_load_room_for_dev_webhook", load_room)
    return SimpleNamespace(enforce=enforce, load_room=load_room)


@pytest.mark.asyncio
async def test_webhook_enforces_admission_then_dispatches(webhook_spies):
    event = _joined_event(str(FID))
    await webhooks._handle_participant_joined(event, object(), _redis_service())
    webhook_spies.enforce.assert_awaited_once()
    kwargs = webhook_spies.enforce.await_args.kwargs
    assert kwargs["room_id"] == ROOM_ID
    assert kwargs["fid"] == FID
    assert kwargs["participant"] is event.participant
    webhook_spies.load_room.assert_awaited_once()
    assert _FakeLiveKitService.instances[0].closed


@pytest.mark.asyncio
async def test_webhook_skips_dev_dispatch_when_removed(webhook_spies):
    webhook_spies.enforce.return_value = AdmissionAction.REMOVE
    await webhooks._handle_participant_joined(
        _joined_event(str(FID)), object(), _redis_service()
    )
    webhook_spies.load_room.assert_not_awaited()
    assert _FakeLiveKitService.instances[0].closed


@pytest.mark.asyncio
@pytest.mark.parametrize("identity", ["anon:abc", "EG_worker"])
async def test_webhook_ignores_non_fid_identities(webhook_spies, identity):
    await webhooks._handle_participant_joined(
        _joined_event(identity), object(), _redis_service()
    )
    webhook_spies.enforce.assert_not_awaited()
