"""Tests for the Phase-4 recording-agent surface.

Covers:

* ``FarcasterSpacesService.pick_available_recording_agent`` / ``release_*``
* ``FarcasterSpacesService.get_recording_agent_bearer`` (per-FID cache)
* ``RecordingAgentService.start_recording`` / ``stop_recording`` —
  exercised via a fake subprocess that speaks the JSON-line protocol.
* ``RoomService._start_native_recording`` flips ``recording = True``
  and persists ``recording_id`` + ``recording_agent_fid``.

The subprocess tests use a tiny Python "fake worker" script written
into ``tmp_path``; we spawn it the same way the real worker would be
spawned (``asyncio.create_subprocess_exec`` with stdin/stdout pipes).
This exercises the actual pipe handshake — no mock subprocess sugar.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import uuid
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from eth_account import Account

from app.config import Settings
from app.schemas.farcaster_spaces import FarcasterSpacesConfigError
from app.services.farcaster_spaces_service import FarcasterSpacesService
from app.services.recording_agent_service import (
    RecordingAgentError,
    RecordingAgentService,
)

# ---------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------


AGENT_FID_A = 10_001
AGENT_FID_B = 10_002
AGENT_FID_C = 10_003

AGENT_KEY_A = "0x" + "11" * 32
AGENT_KEY_B = "0x" + "22" * 32
AGENT_KEY_C = "0x" + "33" * 32


def _settings_with_agents(
    *,
    fids: list[int] | None = None,
    keys: dict[int, str] | None = None,
) -> Settings:
    """Build a Settings with the recording-agent pool populated."""
    fids = fids if fids is not None else [AGENT_FID_A, AGENT_FID_B]
    keys = (
        keys
        if keys is not None
        else {
            AGENT_FID_A: AGENT_KEY_A,
            AGENT_FID_B: AGENT_KEY_B,
        }
    )
    keys_json = json.dumps({str(k): v for k, v in keys.items()})
    return Settings(
        JUKE_FARCASTER_CUSTODY_PRIVATE_KEY="0x" + "ab" * 32,
        JUKE_FARCASTER_FID=999_999,
        # Pin FARCASTER_APP_FID off so the resolver doesn't pick up
        # the dev's local-env value via the FARCASTER_APP_FID fallback
        # added in the env-vars-consolidation change. Tests that want
        # to exercise the fallback construct Settings explicitly.
        FARCASTER_APP_FID=0,
        FARCASTER_APP_MNEMONIC="",
        JUKE_RECORDING_AGENT_FIDS=fids,
        JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON=keys_json,
        # Resolve to a fake worker per-test; tests that need a real
        # subprocess override these explicitly.
        JUKE_RECORDING_AGENT_WORKER_PATH="/dev/null",
        JUKE_RECORDING_AGENT_NODE_BIN="/usr/bin/false",
    )


def _install_mint_transport(svc: FarcasterSpacesService) -> dict[str, int]:
    """Install an httpx MockTransport that responds to every PUT
    /v2/onboarding-state with a per-call unique bearer secret. Returns
    a counter dict the caller can read to assert mint-call counts.
    """
    counts = {"mints": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "PUT" and "onboarding-state" in str(req.url):
            counts["mints"] += 1
            return httpx.Response(
                200,
                json={
                    "result": {
                        "token": {
                            "secret": f"tok_mint_{counts['mints']}",
                            "expiresAt": int(time.time() * 1000) + 10 * 86400 * 1000,
                        }
                    }
                },
            )
        # Upstream room snapshot — RoomService._start_native_recording
        # peeks this before reserving an agent. Default to a live
        # snapshot so the reconcile branch doesn't accidentally trigger
        # in tests that aren't exercising it.
        if req.method == "GET" and "audio-room?roomId" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "result": {
                        "room": {
                            "id": "11111111-2222-3333-4444-555555555555",
                            "state": "live",
                            "host": {"fid": 42, "username": "host"},
                        }
                    }
                },
            )
        return httpx.Response(404, json={"error": "not found"})

    svc._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=10.0,
        follow_redirects=False,
    )
    return counts


# =====================================================================
# 1. Pool: pick / release / get_recording_agent_bearer
# =====================================================================


@pytest.mark.asyncio
async def test_pick_agent_returns_first_available():
    settings = _settings_with_agents()
    svc = FarcasterSpacesService(settings)
    _install_mint_transport(svc)

    picked = await svc.pick_available_recording_agent()
    assert picked is not None
    fid, bearer = picked
    assert fid == AGENT_FID_A  # first in the configured list
    assert bearer.startswith("tok_mint_")

    await svc.aclose()


@pytest.mark.asyncio
async def test_pick_agent_returns_none_when_all_busy():
    settings = _settings_with_agents()
    svc = FarcasterSpacesService(settings)
    _install_mint_transport(svc)

    a = await svc.pick_available_recording_agent()
    b = await svc.pick_available_recording_agent()
    assert a is not None and b is not None
    assert a[0] != b[0]  # different agents

    none_left = await svc.pick_available_recording_agent()
    assert none_left is None

    await svc.aclose()


@pytest.mark.asyncio
async def test_release_agent_makes_it_available_again():
    settings = _settings_with_agents()
    svc = FarcasterSpacesService(settings)
    _install_mint_transport(svc)

    a = await svc.pick_available_recording_agent()
    b = await svc.pick_available_recording_agent()
    assert a is not None and b is not None
    assert await svc.pick_available_recording_agent() is None

    await svc.release_recording_agent(a[0])
    again = await svc.pick_available_recording_agent()
    assert again is not None
    assert again[0] == a[0]

    # Double-release is a no-op.
    await svc.release_recording_agent(a[0])
    await svc.release_recording_agent(a[0])

    await svc.aclose()


@pytest.mark.asyncio
async def test_get_recording_agent_bearer_caches_per_fid():
    settings = _settings_with_agents()
    svc = FarcasterSpacesService(settings)
    counts = _install_mint_transport(svc)

    b1 = await svc.get_recording_agent_bearer(AGENT_FID_A)
    b2 = await svc.get_recording_agent_bearer(AGENT_FID_A)
    assert b1 == b2
    assert counts["mints"] == 1  # second call hit cache

    # Different FID -> separate mint.
    b3 = await svc.get_recording_agent_bearer(AGENT_FID_B)
    assert b3 != b1
    assert counts["mints"] == 2

    await svc.aclose()


@pytest.mark.asyncio
async def test_get_recording_agent_bearer_rejects_unregistered_fid():
    settings = _settings_with_agents()
    svc = FarcasterSpacesService(settings)
    _install_mint_transport(svc)

    with pytest.raises(FarcasterSpacesConfigError):
        await svc.get_recording_agent_bearer(99_998)  # not in pool

    await svc.aclose()


@pytest.mark.asyncio
async def test_get_recording_agent_bearer_rejects_fid_missing_key():
    # FID listed but no matching custody key.
    settings = _settings_with_agents(
        fids=[AGENT_FID_A, AGENT_FID_B, AGENT_FID_C],
        keys={AGENT_FID_A: AGENT_KEY_A, AGENT_FID_B: AGENT_KEY_B},
    )
    svc = FarcasterSpacesService(settings)
    _install_mint_transport(svc)

    with pytest.raises(FarcasterSpacesConfigError):
        await svc.get_recording_agent_bearer(AGENT_FID_C)

    await svc.aclose()


@pytest.mark.asyncio
async def test_pick_recovers_when_mint_fails(monkeypatch):
    settings = _settings_with_agents()
    svc = FarcasterSpacesService(settings)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "denied"})

    svc._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=10.0,
        follow_redirects=False,
    )

    with pytest.raises(httpx.HTTPStatusError):
        await svc.pick_available_recording_agent()
    # Agent must be released so a subsequent pick can still get it.
    assert AGENT_FID_A not in svc._agent_busy

    await svc.aclose()


@pytest.mark.asyncio
async def test_pick_returns_none_when_no_agents_configured():
    settings = _settings_with_agents(fids=[], keys={})
    svc = FarcasterSpacesService(settings)
    _install_mint_transport(svc)

    assert await svc.pick_available_recording_agent() is None

    await svc.aclose()


@pytest.mark.asyncio
async def test_recording_agent_pool_falls_back_to_farcaster_app_fid():
    """When `JUKE_RECORDING_AGENT_FIDS` is unset, the resolver falls
    back to `[FARCASTER_APP_FID]` and derives the custody key from
    `FARCASTER_APP_MNEMONIC`. Single-agent deployments don't need
    duplicate env vars."""
    # Use a 12-word mnemonic so eth_account's BIP39 path resolves.
    mnemonic = (
        "abandon abandon abandon abandon abandon abandon "
        "abandon abandon abandon abandon abandon about"
    )
    settings = Settings(
        FARCASTER_APP_MNEMONIC=mnemonic,
        FARCASTER_APP_FID=4242,
        # Neither explicit recording-agent var set.
        JUKE_RECORDING_AGENT_FIDS=[],
        JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON="",
        JUKE_RECORDING_AGENT_WORKER_PATH="/dev/null",
        JUKE_RECORDING_AGENT_NODE_BIN="/usr/bin/false",
    )

    # Resolved pool contains the FARCASTER_APP_FID.
    assert settings.recording_agent_fids_resolved() == [4242]
    # Resolved custody keys include a derived key for that FID.
    keys = settings.recording_agent_custody_keys()
    assert 4242 in keys
    assert keys[4242].startswith("0x")
    assert len(keys[4242]) == 66  # "0x" + 32 bytes hex


@pytest.mark.asyncio
async def test_explicit_recording_agent_fids_take_precedence_over_fallback():
    """When both are set, the explicit `JUKE_RECORDING_AGENT_FIDS`
    list wins (no contamination from `FARCASTER_APP_FID`)."""
    mnemonic = (
        "abandon abandon abandon abandon abandon abandon "
        "abandon abandon abandon abandon abandon about"
    )
    settings = Settings(
        FARCASTER_APP_MNEMONIC=mnemonic,
        FARCASTER_APP_FID=4242,
        JUKE_RECORDING_AGENT_FIDS=[9999],
        JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON=json.dumps({"9999": "0x" + "ab" * 32}),
        JUKE_RECORDING_AGENT_WORKER_PATH="/dev/null",
        JUKE_RECORDING_AGENT_NODE_BIN="/usr/bin/false",
    )
    assert settings.recording_agent_fids_resolved() == [9999]
    assert settings.recording_agent_custody_keys() == {9999: "0x" + "ab" * 32}


@pytest.mark.asyncio
async def test_each_agent_signs_with_its_own_key():
    """The mint upstream call must arrive with an EIP-191 signature
    that recovers to the agent FID's own custody address, NOT the
    service-FID custody address. Defends against a refactor that
    accidentally reuses the service key for every agent.
    """
    settings = _settings_with_agents()
    svc = FarcasterSpacesService(settings)

    captured_sigs: list[bytes] = []
    captured_bodies: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        auth = req.headers.get("authorization", "")
        b64 = auth.removeprefix("Bearer eip191:")
        import base64

        captured_sigs.append(base64.b64decode(b64))
        captured_bodies.append(json.loads(req.content))
        return httpx.Response(
            200,
            json={
                "result": {
                    "token": {
                        "secret": f"tok_{len(captured_sigs)}",
                        "expiresAt": int(time.time() * 1000) + 10 * 86400 * 1000,
                    }
                }
            },
        )

    svc._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=10.0,
        follow_redirects=False,
    )

    await svc.get_recording_agent_bearer(AGENT_FID_A)
    await svc.get_recording_agent_bearer(AGENT_FID_B)

    from eth_account.messages import encode_defunct
    from app.services.farcaster_spaces_service import _canonicalize

    expected_addrs = {
        AGENT_FID_A: Account.from_key(AGENT_KEY_A).address.lower(),
        AGENT_FID_B: Account.from_key(AGENT_KEY_B).address.lower(),
    }
    seen_addrs: list[str] = []
    for body, sig in zip(captured_bodies, captured_sigs):
        canonical = _canonicalize(body["authRequest"])
        recovered = Account.recover_message(
            encode_defunct(text=canonical), signature=sig
        )
        seen_addrs.append(recovered.lower())

    # Both agent addresses recovered, and neither equals the service
    # custody key's address.
    service_addr = Account.from_key(
        settings.JUKE_FARCASTER_CUSTODY_PRIVATE_KEY
    ).address.lower()
    assert set(seen_addrs) == set(expected_addrs.values())
    assert service_addr not in seen_addrs

    await svc.aclose()


# =====================================================================
# 2. RecordingAgentService — subprocess protocol
# =====================================================================


# A fake Node worker, written in Python so we don't need node on the
# test host. The contract is identical to worker.mjs: read one JSON
# line from stdin, emit one or more JSON event lines on stdout, exit
# on SIGTERM after emitting ``finalized``.
_FAKE_WORKER_OK = """\
import json, sys, signal

config = json.loads(sys.stdin.readline())
# Echo back the recording id so the test can validate the wire payload.
print(json.dumps({"event": "started", "recording_id": config["recording_id"]}))
sys.stdout.flush()

def _term(_signum, _frame):
    print(json.dumps({"event": "finalized", "url": "s3://bucket/" + config["s3_target"]}))
    sys.stdout.flush()
    sys.exit(0)

signal.signal(signal.SIGTERM, _term)

# Idle until SIGTERM.
while True:
    signal.pause()
"""


_FAKE_WORKER_REJECT = """\
import json, sys
_ = sys.stdin.readline()
print(json.dumps({"event": "error", "message": "stub-only"}))
sys.stdout.flush()
sys.exit(1)
"""


_FAKE_WORKER_WITH_LIB_LOG_NOISE = """\
import json, sys, signal

# Simulate @livekit/rtc-node's pino logger writing structured log
# lines to stdout BEFORE our real `started` event lands. Without the
# orchestrator's skip-non-event filter, the first of these would be
# read as the worker's first event and the start would be rejected.
print(json.dumps({"level": 20, "name": "lk-rtc", "msg": "Connect callback received"}))
print(json.dumps({"level": 30, "name": "lk-rtc", "msg": "Subscribed to participant"}))
sys.stdout.flush()

config = json.loads(sys.stdin.readline())
print(json.dumps({"event": "started", "recording_id": config["recording_id"]}))
sys.stdout.flush()

def _term(_signum, _frame):
    print(json.dumps({"event": "finalized", "url": "s3://bucket/" + config["s3_target"]}))
    sys.stdout.flush()
    sys.exit(0)

signal.signal(signal.SIGTERM, _term)
while True:
    signal.pause()
"""


_FAKE_WORKER_ERROR_ON_STOP = """\
import json, sys, signal

config = json.loads(sys.stdin.readline())
print(json.dumps({"event": "started"}))
sys.stdout.flush()

def _term(_signum, _frame):
    print(json.dumps({"event": "error", "message": "finalize blew up"}))
    sys.stdout.flush()
    sys.exit(1)

signal.signal(signal.SIGTERM, _term)
while True:
    signal.pause()
"""


def _install_fake_worker(settings_obj: Settings, script_path: str, source: str) -> None:
    """Write ``source`` to ``script_path`` and point the recording-
    agent service at the python interpreter + that script."""
    with open(script_path, "w") as fh:
        fh.write(source)
    # Mutate the settings instance in place — pydantic-settings allows
    # attribute writes by default.
    object.__setattr__(settings_obj, "JUKE_RECORDING_AGENT_WORKER_PATH", script_path)
    object.__setattr__(settings_obj, "JUKE_RECORDING_AGENT_NODE_BIN", sys.executable)


@pytest.mark.asyncio
async def test_start_recording_spawns_subprocess(tmp_path):
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_ok.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_OK)

    svc = RecordingAgentService(settings)

    recording_id = await svc.start_recording(
        room_id="rm-abc",
        signaling_url="wss://livekit.farcaster.xyz",
        token="LIVEKIT_JWT_TOKEN",
        s3_target="recordings/rm-abc/native-1234.ogg",
    )

    assert isinstance(recording_id, str)
    assert len(recording_id) == 32  # uuid hex
    assert recording_id in svc._active

    # Stop to clean up.
    url = await svc.stop_recording(recording_id)
    assert url == "s3://bucket/recordings/rm-abc/native-1234.ogg"
    assert recording_id not in svc._active


@pytest.mark.asyncio
async def test_start_recording_skips_non_event_stdout_lines(tmp_path):
    """Regression: @livekit/rtc-node's internal pino logger writes
    structured log lines to stdout that share our JSON-line shape but
    have no `event` field. The orchestrator must skip them and keep
    reading until the worker's real `{event: "started"}` lands —
    otherwise the start gets rejected on a library log line and the
    user sees a generic 502 with the actual reason masked."""
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_with_noise.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_WITH_LIB_LOG_NOISE)

    svc = RecordingAgentService(settings)
    recording_id = await svc.start_recording(
        room_id="rm-noisy",
        signaling_url="wss://livekit.farcaster.xyz",
        token="LIVEKIT_JWT_TOKEN",
        s3_target="recordings/rm-noisy/native-1234.ogg",
    )
    assert isinstance(recording_id, str)
    assert recording_id in svc._active

    # Stop to clean up.
    await svc.stop_recording(recording_id)


@pytest.mark.asyncio
async def test_stop_recording_signals_subprocess_and_returns_url(tmp_path):
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_ok.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_OK)

    svc = RecordingAgentService(settings)
    recording_id = await svc.start_recording(
        room_id="rm-xyz",
        signaling_url="wss://livekit.farcaster.xyz",
        token="tok",
        s3_target="recordings/rm-xyz/native.ogg",
    )

    url = await svc.stop_recording(recording_id)
    assert url == "s3://bucket/recordings/rm-xyz/native.ogg"


@pytest.mark.asyncio
async def test_active_recording_ids_tracks_lifecycle(tmp_path):
    """active_recording_ids() reflects the live worker registry so the
    shutdown drain knows what to finalize."""
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_ok.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_OK)

    svc = RecordingAgentService(settings)
    assert svc.active_recording_ids() == []

    recording_id = await svc.start_recording(
        room_id="rm-xyz",
        signaling_url="wss://livekit.farcaster.xyz",
        token="tok",
        s3_target="recordings/rm-xyz/native.ogg",
    )
    assert svc.active_recording_ids() == [recording_id]

    await svc.stop_recording(recording_id)
    assert svc.active_recording_ids() == []


@pytest.mark.asyncio
async def test_start_recording_propagates_worker_rejection(tmp_path):
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_reject.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_REJECT)

    svc = RecordingAgentService(settings)
    with pytest.raises(RecordingAgentError) as excinfo:
        await svc.start_recording(
            room_id="rm-x",
            signaling_url="wss://x",
            token="t",
            s3_target="recordings/x.ogg",
        )
    assert "stub-only" in str(excinfo.value)
    assert svc._active == {}


@pytest.mark.asyncio
async def test_stop_recording_unknown_id_raises():
    settings = _settings_with_agents()
    svc = RecordingAgentService(settings)
    with pytest.raises(RecordingAgentError):
        await svc.stop_recording("does-not-exist")


@pytest.mark.asyncio
async def test_stop_recording_propagates_finalize_error(tmp_path):
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_stop_err.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_ERROR_ON_STOP)

    svc = RecordingAgentService(settings)
    recording_id = await svc.start_recording(
        room_id="rm-err",
        signaling_url="wss://x",
        token="t",
        s3_target="recordings/rm-err.ogg",
    )

    with pytest.raises(RecordingAgentError):
        await svc.stop_recording(recording_id)
    # Registry cleared regardless of error.
    assert recording_id not in svc._active


@pytest.mark.asyncio
async def test_start_recording_bad_binary_raises():
    """If the configured node binary can't be exec'd we surface a clear
    error rather than crashing."""
    settings = _settings_with_agents()
    object.__setattr__(settings, "JUKE_RECORDING_AGENT_NODE_BIN", "/nonexistent/binary")
    object.__setattr__(
        settings, "JUKE_RECORDING_AGENT_WORKER_PATH", "/nonexistent/worker.mjs"
    )
    svc = RecordingAgentService(settings)
    with pytest.raises(RecordingAgentError):
        await svc.start_recording(
            room_id="rm",
            signaling_url="wss://x",
            token="t",
            s3_target="recordings/r.ogg",
        )


@pytest.mark.asyncio
async def test_token_not_passed_as_argv(tmp_path, monkeypatch):
    """Defense-in-depth: the bearer-derived LiveKit token must reach
    the worker via stdin, NEVER as an argv element. Spy on
    ``asyncio.create_subprocess_exec`` to assert."""
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_ok.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_OK)

    real_create = asyncio.create_subprocess_exec
    captured: list[tuple] = []

    async def _spy(*args, **kwargs):
        captured.append(args)
        return await real_create(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _spy)

    svc = RecordingAgentService(settings)
    recording_id = await svc.start_recording(
        room_id="rm",
        signaling_url="wss://livekit.farcaster.xyz",
        token="SUPER_SECRET_LIVEKIT_JWT",
        s3_target="recordings/rm/native.ogg",
    )
    await svc.stop_recording(recording_id)

    # Exactly one spawn captured; none of the argv entries leak the token.
    assert len(captured) == 1
    for arg in captured[0]:
        assert "SUPER_SECRET_LIVEKIT_JWT" not in str(arg)


# =====================================================================
# 3. Native-recording dispatch — RoomService._start_native_recording
# =====================================================================


from app.models.room import Room  # noqa: E402  (after sys.path established)


class _FakeRedisService:
    """Minimal RedisService stand-in covering only what the native-
    recording path touches."""

    class _Redis:
        def __init__(self):
            self.store: dict[str, Any] = {}

        async def set(self, key, value, ex=None, nx=None):
            self.store[key] = value
            return True

        async def get(self, key):
            v = self.store.get(key)
            if v is None:
                return None
            return str(v).encode() if isinstance(v, bytes) else str(v)

        async def incrby(self, key, n):
            v = int(self.store.get(key, 0)) + n
            self.store[key] = v
            return v

        async def expire(self, key, _ttl):
            return True

        async def delete(self, *keys):
            for k in keys:
                self.store.pop(k, None)
            return len(keys)

    def __init__(self):
        self.redis = self._Redis()
        self.published: list[tuple[str, dict]] = []

    async def publish_room_event(self, room_id, event):
        self.published.append((room_id, event))

    async def publish_room_discovery_event(self, _payload):
        return None


class _FakeUpdateResult:
    """Minimal SQLAlchemy-like result for UPDATE statements."""

    rowcount = 1


class _FakeDB:
    """In-memory async-session stub for the native-recording path."""

    def __init__(self, room: Room):
        self._room = room
        self.executed: list[Any] = []
        self.added: list[Any] = []
        self.committed = False
        self.rolled_back = False

    def add(self, instance):
        # ORM-style add for new instances (e.g. Recording rows inserted
        # by the native-recording stop path). Captured so tests can
        # assert against the inserted objects.
        self.added.append(instance)

    async def execute(self, stmt):
        self.executed.append(stmt)
        # Crude routing — every select returns our single room; every
        # update mutates the row in-place so the route reads the new
        # state on the second select.
        compiled = str(stmt)
        if compiled.lstrip().lower().startswith("select"):
            return _StaticResult(self._room)
        if "UPDATE rooms" in compiled or "rooms SET" in compiled.lower():
            # Walk the (Column, BindParameter) pairs on the update so we
            # apply values using the Python attribute name on the model
            # (``metadata_`` not ``metadata``). ``stmt._values`` is the
            # internal-but-stable dict SQLAlchemy keeps for this.
            values = getattr(stmt, "_values", None) or {}
            from app.models.room import Room as _Room

            col_to_attr = {
                getattr(_Room, name).property.columns[0]: name
                for name in dir(_Room)
                if not name.startswith("_")
                and hasattr(getattr(_Room, name, None), "property")
            }
            for col, bind in values.items():
                attr = col_to_attr.get(col)
                if attr is None:
                    continue
                value = bind.value if hasattr(bind, "value") else bind
                setattr(self._room, attr, value)
            return _FakeUpdateResult()
        return _StaticResult(None)

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


class _StaticResult:
    def __init__(self, value):
        self._value = value

    def scalar_one(self):
        return self._value

    def scalar_one_or_none(self):
        return self._value


@pytest.mark.asyncio
async def test_native_recording_flips_room_recording_true(tmp_path):
    """Full ``_start_native_recording`` happy path:

    1. Reserve an agent FID.
    2. Successful upstream join.
    3. Worker spawns + emits ``started``.
    4. Room row updated: ``recording=True``, ``recording_id`` set,
       ``metadata_["recording_agent_fid"]`` populated.
    """
    settings = _settings_with_agents()
    script = str(tmp_path / "worker_ok.py")
    _install_fake_worker(settings, script, _FAKE_WORKER_OK)

    # Real FarcasterSpacesService with mocked transport (join +
    # mint).
    fcsp = FarcasterSpacesService(settings)

    def transport_handler(req: httpx.Request) -> httpx.Response:
        if req.method == "PUT" and "onboarding-state" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "result": {
                        "token": {
                            "secret": "tok_agent_a",
                            "expiresAt": int(time.time() * 1000) + 10 * 86400 * 1000,
                        }
                    }
                },
            )
        # Upstream room snapshot — RoomService._start_native_recording
        # peeks this BEFORE reserving a recording agent so it can
        # reconcile + 409 if the host ended the room from the Farcaster
        # app. Return a live snapshot so the happy path proceeds.
        if req.method == "GET" and "audio-room?roomId" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "result": {
                        "room": {
                            "id": "11111111-2222-3333-4444-555555555555",
                            "state": "live",
                            "host": {"fid": 42, "username": "host"},
                        }
                    }
                },
            )
        if req.method == "POST" and "audio-room/join" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "result": {
                        "wsUrl": "wss://livekit.farcaster.xyz",
                        "token": "JOIN_TOKEN_OK",
                    }
                },
            )
        return httpx.Response(404)

    fcsp._client = httpx.AsyncClient(
        transport=httpx.MockTransport(transport_handler),
        timeout=10.0,
        follow_redirects=False,
    )

    recording_agent = RecordingAgentService(settings)

    room = Room(
        id=uuid.uuid4(),
        title="Native test room",
        host_fid=42,
        status="active",
        recording=False,
        recording_url=None,
        recording_key=None,
        recording_id=None,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={"farcaster_host_fid": 100},
    )

    from app.services.room_service import RoomService

    db = _FakeDB(room)
    redis = _FakeRedisService()
    livekit = AsyncMock()
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=redis,  # type: ignore[arg-type]
        livekit=livekit,
        farcaster_spaces=fcsp,
        recording_agent=recording_agent,
    )

    # Stub the actor-role / rate-limit helpers so we don't need a full
    # participants infra for the test.
    async def _ok_role(_room_id, _fid):
        return "host"

    async def _ok_rl(_fid):
        return None

    async def _ok_cap(_room_id):
        return None

    room_service._get_actor_role = _ok_role  # type: ignore[method-assign]
    room_service._enforce_recording_rate_limit = _ok_rl  # type: ignore[method-assign]
    room_service._assert_recording_duration_under_cap = _ok_cap  # type: ignore[method-assign]

    result = await room_service.start_recording(str(room.id), fid=42)

    assert result["status"] == "recording"
    assert isinstance(result["recording_id"], str)
    assert room.recording is True
    assert room.recording_id == result["recording_id"]
    assert room.metadata_["recording_agent_fid"] == AGENT_FID_A
    assert db.committed is True

    # Stop path cleans up.
    stop_result = await room_service.stop_recording(str(room.id), fid=42)
    assert stop_result["status"] == "stopped"
    assert room.recording is False
    assert room.recording_id is None
    # Agent released.
    assert AGENT_FID_A not in fcsp._agent_busy
    # A Recording row was inserted with the segment-specific metadata.
    # Without this, a host who stops + restarts recording in the same
    # space would overwrite the prior segment (the original bug).
    from app.models.recording import Recording as _Recording

    inserted = [r for r in db.added if isinstance(r, _Recording)]
    assert len(inserted) == 1, db.added
    rec = inserted[0]
    assert rec.room_id == room.id
    assert rec.source == "native"
    assert rec.recording_url  # non-empty
    assert rec.upstream_recording_id == result["recording_id"]

    await fcsp.aclose()


@pytest.mark.asyncio
async def test_native_recording_503_when_no_agents_configured(tmp_path):
    """When the pool is empty, ``_start_native_recording`` must surface
    503 — NOT silently fall through to the egress path."""
    settings = _settings_with_agents(fids=[], keys={})
    fcsp = FarcasterSpacesService(settings)
    _install_mint_transport(fcsp)

    recording_agent = RecordingAgentService(settings)

    room = Room(
        id=uuid.uuid4(),
        title="t",
        host_fid=42,
        status="active",
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={"farcaster_host_fid": 100},
    )

    from fastapi import HTTPException

    from app.services.room_service import RoomService

    db = _FakeDB(room)
    redis = _FakeRedisService()
    livekit = AsyncMock()
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=redis,  # type: ignore[arg-type]
        livekit=livekit,
        farcaster_spaces=fcsp,
        recording_agent=recording_agent,
    )

    async def _ok_role(_room_id, _fid):
        return "host"

    async def _ok_rl(_fid):
        return None

    async def _ok_cap(_room_id):
        return None

    room_service._get_actor_role = _ok_role  # type: ignore[method-assign]
    room_service._enforce_recording_rate_limit = _ok_rl  # type: ignore[method-assign]
    room_service._assert_recording_duration_under_cap = _ok_cap  # type: ignore[method-assign]

    with pytest.raises(HTTPException) as excinfo:
        await room_service.start_recording(str(room.id), fid=42)
    assert excinfo.value.status_code == 503
    assert "recording agents" in excinfo.value.detail.lower()

    await fcsp.aclose()


@pytest.mark.asyncio
async def test_native_recording_rejects_non_host():
    """A caller whose fid != ``room.host_fid`` must 403 — even if they
    used to be in the Redis participant cache from some prior Juke
    session, native rooms don't track participants Juke-side."""
    from fastapi import HTTPException

    from app.services.room_service import RoomService

    settings = _settings_with_agents()
    fcsp = FarcasterSpacesService(settings)
    recording_agent = RecordingAgentService(settings)

    room = Room(
        id=uuid.uuid4(),
        title="Native test room",
        host_fid=42,
        status="active",
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={},
    )

    db = _FakeDB(room)
    redis = _FakeRedisService()
    livekit = AsyncMock()
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=redis,  # type: ignore[arg-type]
        livekit=livekit,
        farcaster_spaces=fcsp,
        recording_agent=recording_agent,
    )

    with pytest.raises(HTTPException) as excinfo:
        # fid 99 is NOT the host (host_fid=42).
        await room_service.start_recording(str(room.id), fid=99)
    assert excinfo.value.status_code == 403
    assert "host" in excinfo.value.detail.lower()

    await fcsp.aclose()


@pytest.mark.asyncio
async def test_native_recording_host_passes_without_redis_participant():
    """The host (room.host_fid == fid) must NOT be blocked by the
    empty Redis participant cache — that was the bug. We stop short of
    the agent-pool reservation (returns 503 ``no recording agents``) to
    keep this test focused on the role check."""
    from fastapi import HTTPException

    from app.services.room_service import RoomService

    settings = _settings_with_agents()
    fcsp = FarcasterSpacesService(settings)
    # Force the agent pool to come up empty so we 503 right after the
    # host check passes — we just need to prove the role check itself
    # didn't 403 with "not an active participant".
    fcsp.pick_available_recording_agent = AsyncMock(return_value=None)  # type: ignore[method-assign]
    recording_agent = RecordingAgentService(settings)

    room = Room(
        id=uuid.uuid4(),
        title="Native test room",
        host_fid=42,
        status="active",
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={},
    )

    db = _FakeDB(room)
    redis = _FakeRedisService()
    livekit = AsyncMock()
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=redis,  # type: ignore[arg-type]
        livekit=livekit,
        farcaster_spaces=fcsp,
        recording_agent=recording_agent,
    )

    async def _ok_rl(_fid):
        return None

    async def _ok_cap(_room_id):
        return None

    room_service._enforce_recording_rate_limit = _ok_rl  # type: ignore[method-assign]
    room_service._assert_recording_duration_under_cap = _ok_cap  # type: ignore[method-assign]

    with pytest.raises(HTTPException) as excinfo:
        await room_service.start_recording(str(room.id), fid=42)
    # 503 = passed role + rate-limit + cap, blocked by empty agent pool.
    # The OLD bug surfaced as 403 "not an active participant in this room".
    assert excinfo.value.status_code == 503
    assert "active participant" not in excinfo.value.detail.lower()

    await fcsp.aclose()


@pytest.mark.asyncio
async def test_native_recording_409_when_upstream_room_already_ended():
    """Repro: host created the space from Juke, ended it from the
    Farcaster app. Juke's row stays `active` because we never saw the
    upstream end. When the host then taps Record, the recording agent
    would try to join a dead upstream room, upstream 4xx'd the join,
    and we surfaced a generic 502 "Failed to join Farcaster room as
    recording agent" — confusing because the user doesn't know the
    room is actually gone.

    After this fix: peek upstream room state BEFORE reserving an
    agent. If `state == "ended"` (or upstream returns no such room),
    reconcile our row → status=ended, return 409 with a clear message.
    """
    from fastapi import HTTPException

    from app.services.room_service import RoomService

    settings = _settings_with_agents()
    fcsp = FarcasterSpacesService(settings)

    # MockTransport returns an ended room snapshot.
    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "PUT" and "onboarding-state" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "result": {
                        "token": {
                            "secret": "tok_service",
                            "expiresAt": int(time.time() * 1000) + 10 * 86400 * 1000,
                        }
                    }
                },
            )
        if req.method == "GET" and "audio-room?roomId" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "result": {
                        "room": {
                            "id": "11111111-2222-3333-4444-555555555555",
                            "state": "ended",
                            "host": {"fid": 42, "username": "host"},
                        }
                    }
                },
            )
        return httpx.Response(404)

    fcsp._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=10.0,
        follow_redirects=False,
    )
    recording_agent = RecordingAgentService(settings)

    room = Room(
        id=uuid.uuid4(),
        title="Native test room",
        host_fid=42,
        status="active",
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={},
    )
    db = _FakeDB(room)
    redis = _FakeRedisService()
    livekit = AsyncMock()
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=redis,  # type: ignore[arg-type]
        livekit=livekit,
        farcaster_spaces=fcsp,
        recording_agent=recording_agent,
    )

    async def _ok_rl(_fid):
        return None

    async def _ok_cap(_room_id):
        return None

    room_service._enforce_recording_rate_limit = _ok_rl  # type: ignore[method-assign]
    room_service._assert_recording_duration_under_cap = _ok_cap  # type: ignore[method-assign]

    with pytest.raises(HTTPException) as excinfo:
        await room_service.start_recording(str(room.id), fid=42)
    # Clear, host-readable error — NOT the old 502.
    assert excinfo.value.status_code == 409
    assert "already ended" in excinfo.value.detail.lower()

    await fcsp.aclose()


@pytest.mark.asyncio
async def test_finalize_recovers_orphaned_recording_from_s3(monkeypatch):
    """When the worker process is gone (backend redeploy, or it already
    self-finalized + exited on LiveKit disconnect — the orphaned-space
    case), ``_finalize_native_recording_stop`` must probe S3 for the file
    the worker deterministically uploaded and re-link it instead of
    losing the recording.
    """
    from app.models.recording import Recording as _Recording
    from app.services.room_service import RoomService
    import app.services.room_service as room_service_mod

    s3_key = "recordings/abc/native-123.ogg"
    room = Room(
        id=uuid.uuid4(),
        title="orphaned native space",
        host_fid=42,
        status="ended",  # reconciler already flipped it
        recording=True,  # …but the flag is stuck
        recording_url=None,
        recording_key=None,
        recording_id="rec-orphan-1",
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={
            "recording_agent_fid": AGENT_FID_A,
            "recording_s3_target": s3_key,
        },
    )

    # Worker is gone — stop_recording raises.
    recording_agent = AsyncMock()
    recording_agent.stop_recording = AsyncMock(
        side_effect=RecordingAgentError("No active recording-agent worker")
    )
    farcaster_spaces = AsyncMock()

    db = _FakeDB(room)
    redis = _FakeRedisService()
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=redis,  # type: ignore[arg-type]
        livekit=AsyncMock(),
        farcaster_spaces=farcaster_spaces,
        recording_agent=recording_agent,
    )

    # Stub StorageService so the S3 probe says the file exists.
    class _StubStorage:
        def object_exists(self, key):
            assert key == s3_key
            return True

        def complete_orphaned_multipart_upload(self, key):  # pragma: no cover
            raise AssertionError("should not reach MPU recovery when object exists")

        def build_object_url(self, key):
            return f"https://bucket.s3.us-east-1.amazonaws.com/{key}"

    monkeypatch.setattr("app.services.storage_service.StorageService", _StubStorage)

    url = await room_service._finalize_native_recording_stop(
        room, "rec-orphan-1", stopped_by_fid=room_service_mod.SYSTEM_ACTOR_FID
    )

    assert url == f"https://bucket.s3.us-east-1.amazonaws.com/{s3_key}"
    assert room.recording is False
    assert room.recording_id is None
    assert room.recording_key == s3_key
    # The recovered segment is recorded so it shows on the host's profile.
    inserted = [r for r in db.added if isinstance(r, _Recording)]
    assert len(inserted) == 1
    assert inserted[0].s3_key == s3_key
    assert inserted[0].source == "native"
    # Agent FID was released.
    farcaster_spaces.release_recording_agent.assert_awaited_once_with(AGENT_FID_A)


@pytest.mark.asyncio
async def test_finalize_returns_none_when_no_s3_file(monkeypatch):
    """Worker gone AND nothing in S3 → clear the stuck flag but return
    None (no file to recover)."""
    from app.services.room_service import RoomService

    s3_key = "recordings/abc/native-123.ogg"
    room = Room(
        id=uuid.uuid4(),
        title="orphaned native space",
        host_fid=42,
        status="ended",
        recording=True,
        recording_id="rec-orphan-2",
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={"recording_s3_target": s3_key},
    )

    recording_agent = AsyncMock()
    recording_agent.stop_recording = AsyncMock(side_effect=RecordingAgentError("gone"))

    db = _FakeDB(room)
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=_FakeRedisService(),  # type: ignore[arg-type]
        livekit=AsyncMock(),
        farcaster_spaces=AsyncMock(),
        recording_agent=recording_agent,
    )

    class _StubStorage:
        def object_exists(self, key):
            return False

        def complete_orphaned_multipart_upload(self, key):
            return False  # no incomplete upload to complete either

        def build_object_url(self, key):  # pragma: no cover — not reached
            raise AssertionError("should not build URL when no object")

    monkeypatch.setattr("app.services.storage_service.StorageService", _StubStorage)

    url = await room_service._finalize_native_recording_stop(
        room, "rec-orphan-2", stopped_by_fid=0
    )

    assert url is None
    # Flag still cleared so the orphan stops showing as recording.
    assert room.recording is False
    assert room.recording_id is None


@pytest.mark.asyncio
async def test_finalize_recovers_from_incomplete_multipart_upload(monkeypatch):
    """Worker hard-crashed (no graceful finalize) → no complete object,
    but its checkpointed multipart parts survive. Recovery completes the
    upload and re-links the recording."""
    from app.models.recording import Recording as _Recording
    from app.services.room_service import RoomService

    s3_key = "recordings/xyz/native-99.ogg"
    room = Room(
        id=uuid.uuid4(),
        title="crashed native space",
        host_fid=42,
        status="ended",
        recording=True,
        recording_id="rec-crash-1",
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="11111111-2222-3333-4444-555555555555",
        metadata_={"recording_agent_fid": AGENT_FID_A, "recording_s3_target": s3_key},
    )

    recording_agent = AsyncMock()
    recording_agent.stop_recording = AsyncMock(side_effect=RecordingAgentError("gone"))
    farcaster_spaces = AsyncMock()

    db = _FakeDB(room)
    room_service = RoomService(
        db=db,  # type: ignore[arg-type]
        redis=_FakeRedisService(),  # type: ignore[arg-type]
        livekit=AsyncMock(),
        farcaster_spaces=farcaster_spaces,
        recording_agent=recording_agent,
    )

    # No complete object exists yet; completing the orphaned MPU makes one.
    class _StubStorage:
        def __init__(self):
            self._completed = False

        def object_exists(self, key):
            return self._completed

        def complete_orphaned_multipart_upload(self, key):
            assert key == s3_key
            self._completed = True
            return True

        def build_object_url(self, key):
            return f"https://bucket.s3.us-east-1.amazonaws.com/{key}"

    monkeypatch.setattr("app.services.storage_service.StorageService", _StubStorage)

    url = await room_service._finalize_native_recording_stop(
        room, "rec-crash-1", stopped_by_fid=0
    )

    assert url == f"https://bucket.s3.us-east-1.amazonaws.com/{s3_key}"
    assert room.recording is False
    assert room.recording_key == s3_key
    inserted = [r for r in db.added if isinstance(r, _Recording)]
    assert len(inserted) == 1 and inserted[0].s3_key == s3_key
