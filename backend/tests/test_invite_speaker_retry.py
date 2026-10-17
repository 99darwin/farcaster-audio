"""Tests for :py:meth:`FarcasterSpacesService.invite_speaker_with_retry`.

The single-shot ``invite_speaker`` call is unreliable because the
upstream often no-ops (or 4xx's) when the target FID isn't yet a
participant. The retry loop trades a small wall-clock budget for far
better odds the invite lands — with three early-exit conditions:

* Upstream returned 2xx → success
* Participants list shows target already on stage → success (someone
  else promoted them, or they accepted a previous attempt)
* Room ended (host bailed before joining) → cancel

We pin down each branch end-to-end using ``httpx.MockTransport`` for
the upstream side and async lambdas / mocked attribute returns for
the cooperating callbacks.

Critical guarantees verified:

* Tests pass ``delays_seconds=(0.0, ...)`` so no real wall-clock sleep
  occurs — keeps the suite snappy.
* Bearer / response body never logged at INFO level.
* Loop NEVER raises out into the caller (which would surface as an
  unhandled asyncio task exception in prod).
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import patch

import httpx
import pytest

from app.config import Settings
from app.schemas.farcaster_spaces import AudioRoomParticipant, SpaceUser
from app.services.farcaster_spaces_service import FarcasterSpacesService

TEST_FID = 7777
ROOM_ID = "rm_native_test"


def _make_settings() -> Settings:
    """Build Settings bypassing .env discovery."""
    return Settings(
        JUKE_FARCASTER_CUSTODY_PRIVATE_KEY="0x" + "22" * 32,
        JUKE_FARCASTER_FID=999_999,
        JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS=24,
    )


def _prime_bearer(svc: FarcasterSpacesService) -> None:
    """Skip the mint flow by seeding a long-lived bearer."""
    svc._bearer_secret = "test_bearer_value"
    svc._bearer_expires_at_ms = int(time.time() * 1000) + 10 * 86400 * 1000


def _install_invite_transport(
    svc: FarcasterSpacesService,
    *,
    status_sequence: list[int] | None = None,
    participants: list[dict[str, Any]] | None = None,
    raise_on_invite: list[Exception] | None = None,
) -> dict[str, int]:
    """Wire up a MockTransport that responds to:

    * ``GET /v1/audio-room/participants`` — returns ``participants``
      (empty by default) wrapped in the upstream envelope.
    * ``POST /v1/audio-room/accept-speaker`` — returns the next status
      code from ``status_sequence`` (defaults to 500 on each call), OR
      raises the next exception from ``raise_on_invite`` if provided.

    Returns a counters dict updated in place: ``{"invites": N,
    "participants": M}`` so tests can assert on call counts.
    """
    counters = {"invites": 0, "participants": 0}
    status_iter = iter(status_sequence or [])
    raise_iter = iter(raise_on_invite or [])

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "/v1/audio-room/participants" in url:
            counters["participants"] += 1
            return httpx.Response(
                200,
                json={"result": {"participants": participants or []}},
            )
        if "/v1/audio-room/accept-speaker" in url:
            counters["invites"] += 1
            exc = next(raise_iter, None)
            if exc is not None:
                raise exc
            try:
                code = next(status_iter)
            except StopIteration:
                code = 500
            return httpx.Response(code, json={"result": {}})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    svc._client = httpx.AsyncClient(
        transport=transport, timeout=10.0, follow_redirects=False
    )
    return counters


# ---------------------------------------------------------------------
# Happy path — first attempt succeeds
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_succeeds_first_attempt():
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    counters = _install_invite_transport(svc, status_sequence=[200])

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0, 0.0, 0.0),
        max_attempts=3,
    )
    assert ok is True
    # First attempt succeeded — no retries needed.
    assert counters["invites"] == 1
    # Participants check runs before EACH invite attempt (used as a
    # bail-out probe). With one successful attempt we expect one probe.
    assert counters["participants"] == 1
    await svc.aclose()


# ---------------------------------------------------------------------
# Eventual success after several failures
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_succeeds_eventually():
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    # Fail 3x then succeed on the 4th call.
    counters = _install_invite_transport(svc, status_sequence=[400, 500, 503, 200])

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        max_attempts=6,
    )
    assert ok is True
    assert counters["invites"] == 4
    await svc.aclose()


# ---------------------------------------------------------------------
# Bail when room ends mid-loop
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_bails_when_room_ends():
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    counters = _install_invite_transport(
        svc, status_sequence=[500, 500, 500, 500, 500, 500]
    )

    # Room ends after the 2nd attempt.
    call_count = {"n": 0}

    async def is_room_ended() -> bool:
        call_count["n"] += 1
        # First two checks pass; third returns True (room ended).
        return call_count["n"] >= 3

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        is_room_ended=is_room_ended,
        delays_seconds=(0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        max_attempts=6,
    )
    assert ok is False
    # Two failing invites before the room-ended check trips.
    assert counters["invites"] == 2
    await svc.aclose()


# ---------------------------------------------------------------------
# Bail when target already on stage
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_bails_when_target_already_on_stage():
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    # Participants list shows TEST_FID as a speaker — the loop should
    # short-circuit before ever issuing an invite.
    counters = _install_invite_transport(
        svc,
        status_sequence=[200],  # not reached
        participants=[
            {
                "user": {"fid": TEST_FID, "username": "alice"},
                "role": "speaker",
            }
        ],
    )

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0, 0.0, 0.0),
        max_attempts=3,
    )
    assert ok is True
    assert counters["invites"] == 0
    # One participants probe → returned True → exit.
    assert counters["participants"] == 1
    await svc.aclose()


@pytest.mark.asyncio
async def test_invite_with_retry_treats_host_role_as_on_stage():
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    counters = _install_invite_transport(
        svc,
        status_sequence=[200],
        participants=[
            {
                "user": {"fid": TEST_FID, "username": "alice"},
                "role": "host",
            }
        ],
    )

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0,),
        max_attempts=1,
    )
    assert ok is True
    assert counters["invites"] == 0
    await svc.aclose()


@pytest.mark.asyncio
async def test_invite_with_retry_ignores_listener_role():
    """Target present in participants as a LISTENER should NOT trigger
    the bail-out — they're still off-stage and the invite needs to fire.
    """
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    counters = _install_invite_transport(
        svc,
        status_sequence=[200],
        participants=[
            {
                "user": {"fid": TEST_FID, "username": "alice"},
                "role": "listener",
            }
        ],
    )

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0,),
        max_attempts=1,
    )
    assert ok is True
    # Listener doesn't trip the on-stage bail — invite fires once.
    assert counters["invites"] == 1
    await svc.aclose()


# ---------------------------------------------------------------------
# All attempts fail
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_exhausts_and_returns_false():
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    counters = _install_invite_transport(
        svc, status_sequence=[400, 400, 400, 400, 400, 400]
    )

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        max_attempts=6,
    )
    assert ok is False
    assert counters["invites"] == 6
    await svc.aclose()


# ---------------------------------------------------------------------
# Network errors during invite are swallowed, not raised
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_swallows_network_errors():
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    counters = _install_invite_transport(
        svc,
        status_sequence=[200],  # 4th call succeeds after 3 network blips
        raise_on_invite=[
            httpx.ConnectError("conn"),
            httpx.ReadTimeout("read"),
            httpx.RemoteProtocolError("proto"),
        ],
    )

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0, 0.0, 0.0, 0.0),
        max_attempts=4,
    )
    assert ok is True
    assert counters["invites"] == 4
    await svc.aclose()


# ---------------------------------------------------------------------
# Unconfigured service silently no-ops
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_skips_when_unconfigured():
    """No custody key configured → ``_get_bearer`` raises
    ``FarcasterSpacesConfigError`` which the loop must translate to a
    silent no-op (returns False) rather than a noisy traceback."""
    svc = FarcasterSpacesService(
        Settings(
            JUKE_FARCASTER_CUSTODY_PRIVATE_KEY="",
            JUKE_FARCASTER_FID=0,
        )
    )

    ok = await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0,),
        max_attempts=3,
    )
    assert ok is False
    await svc.aclose()


# ---------------------------------------------------------------------
# Unexpected exceptions in the loop body NEVER propagate
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_never_raises_to_caller():
    """If something inside the loop body raises (e.g. a programming
    error in the participants probe), the outer guard must translate
    it to ``False`` — the loop is fired from
    ``asyncio.create_task`` and an unhandled raise here surfaces as
    an asyncio loop warning."""
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)

    async def boom() -> bool:
        raise RuntimeError("simulated programming error")

    # Patch get_participants on the instance to raise unexpectedly.
    with patch.object(svc, "get_participants", side_effect=boom):
        # And install a transport that always 500s so even if probes
        # don't trip, invites do.
        _install_invite_transport(svc, status_sequence=[500])

        ok = await svc.invite_speaker_with_retry(
            ROOM_ID,
            TEST_FID,
            delays_seconds=(0.0,),
            max_attempts=1,
        )
    # Probe raises but is caught at the per-attempt level; invite then
    # 500s; final return is False — NEVER raised.
    assert ok is False
    await svc.aclose()


# ---------------------------------------------------------------------
# Bearer NEVER appears in invite payloads or logs
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_retry_never_logs_bearer(caplog):
    svc = FarcasterSpacesService(_make_settings())
    _prime_bearer(svc)
    bearer_secret = svc._bearer_secret
    assert bearer_secret is not None

    _install_invite_transport(svc, status_sequence=[500, 500, 500])

    caplog.set_level("DEBUG", logger="app.services.farcaster_spaces_service")
    await svc.invite_speaker_with_retry(
        ROOM_ID,
        TEST_FID,
        delays_seconds=(0.0, 0.0, 0.0),
        max_attempts=3,
    )
    # Nothing in the captured log records should carry the bearer.
    for record in caplog.records:
        assert bearer_secret not in record.getMessage()
    await svc.aclose()


# ---------------------------------------------------------------------
# Participants schema acceptance — ensure the on-stage detection works
# against the parsed ``AudioRoomParticipant`` model the service returns
# from ``get_participants`` in practice.
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_target_already_on_stage_works_with_pydantic_models():
    """Direct unit on ``_target_already_on_stage`` using parsed
    Pydantic models — guards against a regression where the on-stage
    detection silently misses host/cohost/speaker because of a field
    rename or alias drift."""
    svc = FarcasterSpacesService(_make_settings())

    on_stage = AudioRoomParticipant(
        user=SpaceUser(fid=TEST_FID, username="alice"),
        role="speaker",
    )
    cohost = AudioRoomParticipant(
        user=SpaceUser(fid=TEST_FID, username="alice"),
        role="cohost",
    )
    host_ = AudioRoomParticipant(
        user=SpaceUser(fid=TEST_FID, username="alice"),
        role="host",
    )
    listener = AudioRoomParticipant(
        user=SpaceUser(fid=TEST_FID, username="alice"),
        role="listener",
    )

    async def _fake_speaker(_room_id: str):
        return [on_stage]

    async def _fake_cohost(_room_id: str):
        return [cohost]

    async def _fake_host(_room_id: str):
        return [host_]

    async def _fake_listener(_room_id: str):
        return [listener]

    with patch.object(svc, "get_participants", side_effect=_fake_speaker):
        assert await svc._target_already_on_stage(ROOM_ID, TEST_FID) is True
    with patch.object(svc, "get_participants", side_effect=_fake_cohost):
        assert await svc._target_already_on_stage(ROOM_ID, TEST_FID) is True
    with patch.object(svc, "get_participants", side_effect=_fake_host):
        assert await svc._target_already_on_stage(ROOM_ID, TEST_FID) is True
    with patch.object(svc, "get_participants", side_effect=_fake_listener):
        assert await svc._target_already_on_stage(ROOM_ID, TEST_FID) is False
    await svc.aclose()
