"""WS3 — Developer API Farcaster-native lifecycle.

Covers the full create → start → end → read lifecycle for developer
Farcaster-native spaces in BOTH host modes:

* **bot-hosted** (``host_mode="bot"``) — the upstream room is hosted by a
  registered bot FID; the bearer is minted from the bot's signer.
* **user-hosted** (``host_mode="user_fid"``) — the caller passes an
  end-user-signed JFS bearer forwarded verbatim upstream.

Every ``client.farcaster.xyz`` call is intercepted at the httpx transport
layer (``httpx.MockTransport``) — no real network. Custody (``env:``) bot
bearer minting runs for real (EIP-191). ``dispatch_dev_webhook`` is
monkeypatched per-test to capture ``room.started`` / ``room.finished``
payloads without spinning up delivery workers.
"""

from __future__ import annotations

import base64
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from jose import jwt

pytest.importorskip("aiosqlite")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

import app.services.farcaster_spaces_service as fcsp_module
from app.config import settings
from app.database import Base
from app.dependencies import get_db, require_developer_api_key
from app.main import app
from app.models.developer import (
    DeveloperApiKey,
    DeveloperApp,
    DeveloperApplication,
)
from app.models.developer_app_bot import DeveloperAppBot
from app.models.room import Room
from app.models.user import User
from app.routers.developer import get_developer_room_service
from app.schemas.auth import UserResponse
from app.schemas.room import RoomCreateResponse, RoomDetailResponse, RoomResponse
from app.services.farcaster_spaces_service import FarcasterSpacesService
from tests.custody_bot_helpers import install_custody_fakes, seed_custody_bot

OWNER_FID = 4001
OTHER_FID = 4002
BOT_FID = 65001
USER_HOST_FID = 90001

BOT_KEY_HEX = "0x" + "ab" * 32
BOT_KEY_ENV_VAR = "JUKE_DEV_BOT_CUSTODY_TEST_NL_BOT"

FARCASTER_AUDIENCE = "https://client.farcaster.xyz"


# ---------------------------------------------------------------------------
# Auth + SIWN sidecar helpers (mirrored from test_developer_farcaster_native)
# ---------------------------------------------------------------------------


def _auth_header(fid: int) -> dict[str, str]:
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp()),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    _mark_siwn_sync(fid)
    return {"Authorization": f"Bearer {token}"}


def _siwn_store_for(redis) -> dict:
    if not redis.__dict__.get("__siwn_wired__"):
        store: dict[str, str] = {}
        redis.__dict__["__siwn_wired__"] = True
        redis.__dict__["__siwn_store__"] = store

        async def _exists(key, *_args, **_kwargs):
            if isinstance(key, str) and key.startswith("siwn:") and key in store:
                return 1
            return 0

        redis.exists = _exists
    return redis.__dict__["__siwn_store__"]


def _mark_siwn_sync(fid: int) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    _siwn_store_for(redis)[f"siwn:{fid}"] = "1"


def _b64url(obj: dict[str, Any]) -> str:
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _make_user_bearer(
    fid: int,
    *,
    audience: str = FARCASTER_AUDIENCE,
    exp_offset: int = 300,
) -> str:
    """Build a structurally-valid JFS bearer that ``decode_jfs_bearer``
    accepts (signature verification is delegated upstream)."""
    now = int(time.time())
    header = {"fid": fid, "type": "app_key", "key": "0x" + "cd" * 32}
    payload = {"audience": audience, "timestamp": now, "exp": now + exp_offset}
    # "c2ln" is base64url("sig") — passes the 3-segment base64url validator.
    return f"{_b64url(header)}.{_b64url(payload)}.c2ln"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def developer_key_settings(monkeypatch):
    monkeypatch.setattr(settings, "JUKE_API_KEY_PEPPER", "test-pepper")
    monkeypatch.setattr(
        settings,
        "JUKE_API_KEY_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(b"0" * 32).decode(),
    )
    monkeypatch.setattr(
        settings,
        "JUKE_BOT_SIGNER_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(b"\x11" * 32).decode(),
    )


@pytest.fixture(autouse=True)
def fast_retries(monkeypatch):
    """Zero the upstream retry backoff so 5xx/network error paths don't
    sleep through the exponential schedule."""
    monkeypatch.setattr(fcsp_module, "RETRY_BASE_SECONDS", 0.0)


_CUSTODY_GATES: dict[str, Any] = {}


@pytest.fixture(autouse=True)
def custody_gates(monkeypatch):
    """Allowlist + fake on-chain custody for admin-seeded custody bots."""
    _CUSTODY_GATES["onchain"] = install_custody_fakes(monkeypatch)
    _CUSTODY_GATES["monkeypatch"] = monkeypatch
    yield
    _CUSTODY_GATES.clear()


@pytest.fixture(autouse=True)
def capture_webhooks(monkeypatch):
    """Capture ``dispatch_dev_webhook`` calls from the developer router so
    tests can assert webhook payloads without a delivery worker."""
    mock = AsyncMock()
    monkeypatch.setattr("app.routers.developer.dispatch_dev_webhook", mock)
    return mock


@pytest.fixture
async def db_session():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[
                User.__table__,
                DeveloperApplication.__table__,
                DeveloperApp.__table__,
                DeveloperApiKey.__table__,
                DeveloperAppBot.__table__,
                Room.__table__,
            ],
        )
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest.fixture
async def client_with_db(client, db_session):
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(require_developer_api_key, None)
        app.dependency_overrides.pop(get_developer_room_service, None)
        app.state.farcaster_spaces_service = None


async def _seed_user(
    db: AsyncSession,
    *,
    fid: int = OWNER_FID,
    developer_access_status: str = "approved",
) -> User:
    user = User(
        fid=fid,
        signer_uuid=f"signer-{fid}",
        username=f"user{fid}",
        developer_access_status=developer_access_status,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _create_app_and_key(client_with_db, fid: int = OWNER_FID) -> tuple[str, str]:
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": f"app-{fid}"},
        headers=_auth_header(fid),
    )
    assert create_app.status_code == 201, create_app.text
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(fid),
    )
    assert create_key.status_code == 201, create_key.text
    return app_id, create_key.json()["secret_key"]


async def _register_custody_bot(
    db: AsyncSession, app_id: str, *, fid: int = BOT_FID
) -> DeveloperAppBot:
    """Seed an admin-provisioned custody bot (self-serve refuses them)."""
    return await seed_custody_bot(
        db,
        _CUSTODY_GATES["monkeypatch"],
        _CUSTODY_GATES["onchain"],
        app_id=app_id,
        fid=fid,
        private_key_hex=BOT_KEY_HEX,
        env_var=BOT_KEY_ENV_VAR,
    )


async def _seed_managed_pending_bot(
    db: AsyncSession, *, app_id: uuid.UUID, fid: int
) -> DeveloperAppBot:
    """A managed (``app_key``) bot stuck in ``pending_approval`` — minting
    raises ``BotSignerNotReady`` → the router should surface 409."""
    bot = DeveloperAppBot(
        app_id=app_id,
        fid=fid,
        auth_mode="app_key",
        signer_status="pending_approval",
        signer_public_key="0x" + "ee" * 32,
        signer_private_key_encrypted=b"not-decryptable-in-this-state",
        is_active=True,
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    return bot


async def _seed_native_room(
    db: AsyncSession,
    *,
    app_id: uuid.UUID,
    host_fid: int,
    host_mode: str,
    farcaster_host_fid: int,
    status: str = "scheduled",
    farcaster_room_id: str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    recording: bool = False,
) -> Room:
    # Ensure the host User row exists (FK for Room.host_fid). In production
    # this is the app owner (bot mode) or the mirror-user upserted at create
    # time (user mode); seed the mirror here for direct-seeded rooms.
    existing = (
        await db.execute(select(User).where(User.fid == host_fid))
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            User(fid=host_fid, signer_uuid="mirror-only", username=f"host{host_fid}")
        )
        await db.commit()
    room = Room(
        title="Native room",
        host_fid=host_fid,
        status=status,
        started_at=(datetime.now(timezone.utc) if status == "active" else None),
        livekit_room_id=None,
        is_farcaster_native=True,
        farcaster_room_id=farcaster_room_id,
        created_by_app_id=app_id,
        allow_agents=True,
        recording=recording,
        metadata_={
            "host_mode": host_mode,
            "farcaster_host_fid": farcaster_host_fid,
            "source": "developer-api",
        },
    )
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return room


async def _app_uuid(db: AsyncSession, app_id: str) -> uuid.UUID:
    row = await db.execute(
        select(DeveloperApp).where(DeveloperApp.id == uuid.UUID(app_id))
    )
    return row.scalar_one().id


# ---------------------------------------------------------------------------
# Mock upstream transport
# ---------------------------------------------------------------------------


def _install_mock_fcsp(
    *,
    farcaster_room_id: str = "11111111-2222-3333-4444-555555555555",
    create_host_fid: int = 1,
    create_status: int = 200,
    start_status: int = 200,
    end_status: int = 200,
    participants: list[dict] | None = None,
    participants_status: int = 200,
) -> tuple[FarcasterSpacesService, dict[str, Any]]:
    """Install a deterministic mock ``FarcasterSpacesService``. The returned
    state dict tracks call counts + the last Authorization header seen per
    upstream path (for bearer-forwarded-verbatim assertions)."""
    state: dict[str, Any] = {
        "mints": 0,
        "creates": 0,
        "starts": 0,
        "ends": 0,
        "participant_reads": 0,
        "auth": {},
    }

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        auth = req.headers.get("authorization")
        if req.method == "PUT" and "onboarding-state" in url:
            state["mints"] += 1
            return httpx.Response(
                200,
                json={
                    "result": {
                        "token": {
                            "secret": f"svc_bearer_{state['mints']}",
                            "expiresAt": int(time.time() * 1000) + 10 * 86400 * 1000,
                        }
                    }
                },
            )
        if req.method == "POST" and url.endswith("/v1/audio-rooms"):
            state["creates"] += 1
            state["auth"]["create"] = auth
            if create_status != 200:
                return httpx.Response(create_status, json={"error": "nope"})
            return httpx.Response(
                200,
                json={
                    "result": {
                        "room": {
                            "id": farcaster_room_id,
                            "title": "From upstream",
                            "host": {
                                "fid": create_host_fid,
                                "username": f"host{create_host_fid}",
                            },
                            "state": "live",
                        }
                    }
                },
            )
        if req.method == "POST" and "audio-room/start-scheduled" in url:
            state["starts"] += 1
            state["auth"]["start"] = auth
            if start_status != 200:
                return httpx.Response(start_status, json={"error": "nope"})
            return httpx.Response(200, json={"result": {"room": None}})
        if req.method == "POST" and "audio-room/end" in url:
            state["ends"] += 1
            state["auth"]["end"] = auth
            if end_status != 200:
                return httpx.Response(end_status, json={"error": "nope"})
            return httpx.Response(200, json={"result": {"room": None}})
        if req.method == "GET" and "audio-room/participants" in url:
            state["participant_reads"] += 1
            if participants_status != 200:
                return httpx.Response(participants_status, json={"error": "nope"})
            return httpx.Response(
                200,
                json={"result": {"participants": participants or []}},
            )
        return httpx.Response(404, json={"error": "unmocked"})

    svc = FarcasterSpacesService(settings)
    svc._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=10.0,
        follow_redirects=False,
    )
    # The service-FID bearer (used by read-only ``get_participants`` via
    # ``_get_envelope``) can't be minted in tests — the service custody key
    # isn't configured. Stub it so the participants read reaches the mocked
    # GET. All write paths pass an explicit bearer and never touch this.
    svc._get_bearer = AsyncMock(return_value="svc-bearer")  # type: ignore[method-assign]
    app.state.farcaster_spaces_service = svc
    return svc, state


class _FakeRoomService:
    """Stand-in for ``RoomService`` on the create/juke path. ``.redis`` is
    an AsyncMock so ``add_active_room`` / ``publish_room_discovery_event``
    can be asserted."""

    def __init__(self):
        self.redis = AsyncMock()
        self.end_room = AsyncMock()
        self._room_detail: RoomDetailResponse | None = None

    async def create_room(self, **kwargs):  # pragma: no cover — juke path
        raise AssertionError("native path must not call create_room")

    async def get_room(self, *, room_id: str, current_fid=None) -> RoomDetailResponse:
        return self._room_detail


def _install_fake_room_service(detail: RoomDetailResponse | None = None):
    fake = _FakeRoomService()
    fake._room_detail = detail

    async def _override():
        yield fake

    app.dependency_overrides[get_developer_room_service] = _override
    return fake


# ===========================================================================
# CREATE
# ===========================================================================


@pytest.mark.asyncio
async def test_create_user_hosted_happy(client_with_db, db_session, capture_webhooks):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    fake = _install_fake_room_service()
    _svc, state = _install_mock_fcsp(
        farcaster_room_id="dddddddd-1111-2222-3333-444444444444",
        create_host_fid=USER_HOST_FID,
    )
    bearer = _make_user_bearer(USER_HOST_FID)

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={
            "title": "User hosted",
            "host": "farcaster",
            "user_jfs_bearer": bearer,
        },
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["room"]["is_farcaster_native"] is True
    assert body["room"]["host_fid"] == USER_HOST_FID
    assert body["room"]["host_mode"] == "user_fid"
    assert body["room"]["farcaster_host_fid"] == USER_HOST_FID
    assert body["livekit_token"] is None

    # Bearer forwarded verbatim as the upstream Authorization header.
    assert state["auth"]["create"] == f"Bearer {bearer}"
    assert state["creates"] == 1

    # Mirror user upserted for the bearer fid.
    mirror = (
        await db_session.execute(select(User).where(User.fid == USER_HOST_FID))
    ).scalar_one()
    assert mirror.signer_uuid == "mirror-only"

    # Persisted row.
    row = (
        await db_session.execute(select(Room).where(Room.host_fid == USER_HOST_FID))
    ).scalar_one()
    assert row.metadata_["host_mode"] == "user_fid"
    assert row.metadata_["farcaster_host_fid"] == USER_HOST_FID
    assert row.status == "active"

    # Live create → active-rooms + room.started webhook with native fields.
    fake.redis.add_active_room.assert_awaited_once()
    started = [
        c
        for c in capture_webhooks.call_args_list
        if c.kwargs.get("event_type") == "room.started"
    ]
    assert len(started) == 1
    data = started[0].kwargs["data"]
    assert data["is_farcaster_native"] is True
    assert data["host_mode"] == "user_fid"
    assert data["farcaster_host_fid"] == USER_HOST_FID
    assert data["farcaster_room_id"] == "dddddddd-1111-2222-3333-444444444444"
    assert data["host_fid"] == USER_HOST_FID


@pytest.mark.asyncio
async def test_create_both_host_inputs_rejected(client_with_db, db_session):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    _install_fake_room_service()

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={
            "title": "Ambiguous",
            "host": "farcaster",
            "host_bot_fid": BOT_FID,
            "user_jfs_bearer": _make_user_bearer(USER_HOST_FID),
        },
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_create_neither_host_input_rejected(client_with_db, db_session):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    _install_fake_room_service()

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Empty", "host": "farcaster"},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_create_malformed_bearer_400_no_leak(client_with_db, db_session, caplog):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    _install_fake_room_service()
    _install_mock_fcsp()
    # Structurally valid 3-segment base64url shape but a stale/invalid claim
    # set (wrong audience) → decode_jfs_bearer raises ValueError → 400.
    bearer = _make_user_bearer(USER_HOST_FID, audience="https://evil.example")

    with caplog.at_level("WARNING"):
        response = await client_with_db.post(
            "/v1/developer/spaces",
            json={
                "title": "Bad bearer",
                "host": "farcaster",
                "user_jfs_bearer": bearer,
            },
            headers={"X-Juke-Api-Key": secret_key},
        )
    assert response.status_code == 400, response.text
    # The raw bearer must never appear in logs.
    assert bearer not in caplog.text


@pytest.mark.asyncio
async def test_create_bot_unapproved_signer_409(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    _install_fake_room_service()
    _install_mock_fcsp()
    await _seed_managed_pending_bot(
        db_session, app_id=await _app_uuid(db_session, app_id), fid=65010
    )

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={
            "title": "Pending bot host",
            "host": "farcaster",
            "host_bot_fid": 65010,
        },
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 409, response.text


@pytest.mark.asyncio
async def test_create_bot_hosted_sets_host_mode(
    client_with_db, db_session, capture_webhooks
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, _app_id, fid=BOT_FID)
    _install_fake_room_service()
    _install_mock_fcsp(farcaster_room_id="cccccccc-0000-1111-2222-333333333333")

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Bot hosted", "host": "farcaster", "host_bot_fid": BOT_FID},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["room"]["host_mode"] == "bot"
    assert body["room"]["host_fid"] == OWNER_FID
    assert body["room"]["farcaster_host_fid"] == BOT_FID
    started = [
        c
        for c in capture_webhooks.call_args_list
        if c.kwargs.get("event_type") == "room.started"
    ]
    assert started and started[0].kwargs["data"]["host_mode"] == "bot"


@pytest.mark.asyncio
async def test_create_scheduled_no_started_webhook(
    client_with_db, db_session, capture_webhooks
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, _app_id, fid=BOT_FID)
    fake = _install_fake_room_service()
    _install_mock_fcsp()
    future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={
            "title": "Scheduled",
            "host": "farcaster",
            "host_bot_fid": BOT_FID,
            "scheduled_at": future,
        },
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    assert response.json()["room"]["status"] == "scheduled"
    # No room.started + no active-rooms registration for a scheduled create.
    fake.redis.add_active_room.assert_not_called()
    started = [
        c
        for c in capture_webhooks.call_args_list
        if c.kwargs.get("event_type") == "room.started"
    ]
    assert started == []


# ===========================================================================
# START
# ===========================================================================


@pytest.mark.asyncio
async def test_start_user_hosted_happy(client_with_db, db_session, capture_webhooks):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=USER_HOST_FID,
        host_mode="user_fid",
        farcaster_host_fid=USER_HOST_FID,
        status="scheduled",
    )
    _svc, state = _install_mock_fcsp()
    bearer = _make_user_bearer(USER_HOST_FID)

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        json={"user_jfs_bearer": bearer},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.json()["room"]["status"] == "active"
    assert state["auth"]["start"] == f"Bearer {bearer}"

    await db_session.refresh(room)
    assert room.status == "active"
    started = [
        c
        for c in capture_webhooks.call_args_list
        if c.kwargs.get("event_type") == "room.started"
    ]
    assert started and started[0].kwargs["data"]["is_farcaster_native"] is True


@pytest.mark.asyncio
async def test_start_bot_hosted_happy(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, app_id, fid=BOT_FID)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="scheduled",
    )
    _svc, state = _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert state["starts"] == 1
    await db_session.refresh(room)
    assert room.status == "active"


@pytest.mark.asyncio
async def test_start_user_hosted_missing_bearer_400(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=USER_HOST_FID,
        host_mode="user_fid",
        farcaster_host_fid=USER_HOST_FID,
    )
    _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 400, response.text


@pytest.mark.asyncio
async def test_start_user_hosted_fid_mismatch_403(client_with_db, db_session, caplog):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=USER_HOST_FID,
        host_mode="user_fid",
        farcaster_host_fid=USER_HOST_FID,
    )
    _install_mock_fcsp()
    # A bearer signed by a DIFFERENT fid than the room host.
    other_bearer = _make_user_bearer(USER_HOST_FID + 999)

    with caplog.at_level("WARNING"):
        response = await client_with_db.post(
            f"/v1/developer/spaces/{room.id}/start",
            json={"user_jfs_bearer": other_bearer},
            headers={"X-Juke-Api-Key": secret_key},
        )
    assert response.status_code == 403, response.text
    assert other_bearer not in caplog.text


@pytest.mark.asyncio
async def test_start_idempotent_when_active(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="active",
    )
    _svc, state = _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.json()["room"]["status"] == "active"
    # No upstream start issued on the idempotent path.
    assert state["starts"] == 0


@pytest.mark.asyncio
async def test_start_ended_room_400(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="ended",
    )
    _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 400, response.text


@pytest.mark.asyncio
async def test_start_cross_app_404(client_with_db, db_session):
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    app_a, _secret_a = await _create_app_and_key(client_with_db, fid=OWNER_FID)
    _app_b, secret_b = await _create_app_and_key(client_with_db, fid=OTHER_FID)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_a),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
    )
    _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_b},
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_start_non_native_400(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = Room(
        title="Juke room",
        host_fid=OWNER_FID,
        status="scheduled",
        is_farcaster_native=False,
        created_by_app_id=await _app_uuid(db_session, app_id),
    )
    db_session.add(room)
    await db_session.commit()
    await db_session.refresh(room)
    _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 400, response.text


@pytest.mark.asyncio
async def test_start_upstream_4xx_maps_400_row_stays_scheduled(
    client_with_db, db_session
):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, app_id, fid=BOT_FID)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="scheduled",
    )
    _install_mock_fcsp(start_status=400)

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 400, response.text
    await db_session.refresh(room)
    assert room.status == "scheduled"


@pytest.mark.asyncio
async def test_start_upstream_5xx_maps_502_row_stays_scheduled(
    client_with_db, db_session
):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, app_id, fid=BOT_FID)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="scheduled",
    )
    _install_mock_fcsp(start_status=500)

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/start",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 502, response.text
    await db_session.refresh(room)
    assert room.status == "scheduled"


# ===========================================================================
# END
# ===========================================================================


@pytest.mark.asyncio
async def test_end_user_hosted_native(client_with_db, db_session, capture_webhooks):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=USER_HOST_FID,
        host_mode="user_fid",
        farcaster_host_fid=USER_HOST_FID,
        status="active",
    )
    _svc, state = _install_mock_fcsp()
    bearer = _make_user_bearer(USER_HOST_FID)

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/end",
        json={"user_jfs_bearer": bearer},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ended"
    assert state["auth"]["end"] == f"Bearer {bearer}"
    assert state["ends"] == 1

    await db_session.refresh(room)
    assert room.status == "ended"
    finished = [
        c
        for c in capture_webhooks.call_args_list
        if c.kwargs.get("event_type") == "room.finished"
    ]
    assert len(finished) == 1
    data = finished[0].kwargs["data"]
    assert data["ended_via"] == "api"
    assert data["ended_by_fid"] == OWNER_FID
    assert data["is_farcaster_native"] is True
    assert data["host_mode"] == "user_fid"
    assert data["farcaster_host_fid"] == USER_HOST_FID


@pytest.mark.asyncio
async def test_end_bot_hosted_native(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, app_id, fid=BOT_FID)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="active",
    )
    _svc, state = _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/end",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert state["ends"] == 1
    await db_session.refresh(room)
    assert room.status == "ended"


@pytest.mark.asyncio
async def test_end_idempotent(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="ended",
    )
    _svc, state = _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/end",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ended"
    # No upstream end on the idempotent path.
    assert state["ends"] == 0


@pytest.mark.asyncio
async def test_end_scheduled_becomes_cancelled(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, app_id, fid=BOT_FID)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="scheduled",
    )
    _svc, state = _install_mock_fcsp()

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/end",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    # Upstream end still issued (tolerant of 4xx) so the schedule is torn down.
    assert state["ends"] == 1
    await db_session.refresh(room)
    assert room.status == "cancelled"


@pytest.mark.asyncio
async def test_end_upstream_httpx_error_502_row_stays_active(
    client_with_db, db_session
):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_custody_bot(db_session, app_id, fid=BOT_FID)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="active",
    )
    _install_mock_fcsp(end_status=500)

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/end",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 502, response.text
    await db_session.refresh(room)
    assert room.status == "active"


@pytest.mark.asyncio
async def test_end_juke_hosted_delegates_to_end_room(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    fake = _install_fake_room_service()
    room = Room(
        title="Juke room",
        host_fid=OWNER_FID,
        status="active",
        is_farcaster_native=False,
        created_by_app_id=await _app_uuid(db_session, app_id),
    )
    db_session.add(room)
    await db_session.commit()
    await db_session.refresh(room)

    response = await client_with_db.post(
        f"/v1/developer/spaces/{room.id}/end",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ended"
    fake.end_room.assert_awaited_once()
    assert fake.end_room.await_args.kwargs["ended_via"] == "api"


# ===========================================================================
# GET
# ===========================================================================


@pytest.mark.asyncio
async def test_get_native_participants_mapping_and_header(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="active",
    )
    _install_fake_room_service()
    _install_mock_fcsp(
        participants=[
            {
                "user": {"fid": 111, "username": "host"},
                "role": "host",
                "joinedAt": "2026-01-01T00:00:00Z",
            },
            {
                "user": {"fid": 222, "username": "co"},
                "role": "cohost",
                "handRaised": True,
                "joinedAt": "2026-01-01T00:01:00Z",
            },
            {
                "user": {"fid": 333, "username": "spk"},
                "role": "speaker",
                "handRaised": True,
                "joinedAt": "2026-01-01T00:00:30Z",
            },
        ]
    )

    response = await client_with_db.get(
        f"/v1/developer/spaces/{room.id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.headers["X-Juke-Participants-Source"] == "upstream"
    body = response.json()
    roles = {p["fid"]: p["role"] for p in body["participants"]}
    assert roles == {111: "host", 222: "co_host", 333: "speaker"}
    # All native participants report is_muted False.
    assert all(p["is_muted"] is False for p in body["participants"])
    # hand_queue: raised hands ordered by joined_at ascending → 333 before 222.
    assert body["hand_queue"] == [333, 222]


@pytest.mark.asyncio
async def test_get_native_degrades_to_empty_on_upstream_error(
    client_with_db, db_session
):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="active",
    )
    _install_fake_room_service()
    _install_mock_fcsp(participants_status=400)

    response = await client_with_db.get(
        f"/v1/developer/spaces/{room.id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    # A read never 502s on an upstream blip — it degrades.
    assert response.status_code == 200, response.text
    assert response.headers["X-Juke-Participants-Source"] == "unavailable"
    assert response.json()["participants"] == []


@pytest.mark.asyncio
async def test_get_native_unavailable_when_service_absent(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = await _seed_native_room(
        db_session,
        app_id=await _app_uuid(db_session, app_id),
        host_fid=OWNER_FID,
        host_mode="bot",
        farcaster_host_fid=BOT_FID,
        status="active",
    )
    _install_fake_room_service()
    # No FarcasterSpacesService installed on app.state.
    app.state.farcaster_spaces_service = None

    response = await client_with_db.get(
        f"/v1/developer/spaces/{room.id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.headers["X-Juke-Participants-Source"] == "unavailable"


@pytest.mark.asyncio
async def test_get_non_native_reports_juke_source(client_with_db, db_session):
    await _seed_user(db_session)
    app_id, secret_key = await _create_app_and_key(client_with_db)
    room = Room(
        title="Juke room",
        host_fid=OWNER_FID,
        status="active",
        is_farcaster_native=False,
        created_by_app_id=await _app_uuid(db_session, app_id),
    )
    db_session.add(room)
    await db_session.commit()
    await db_session.refresh(room)

    detail = RoomDetailResponse(
        room=RoomResponse(
            id=str(room.id),
            title="Juke room",
            host_fid=OWNER_FID,
            host=UserResponse(
                fid=OWNER_FID,
                username="owner",
                display_name="owner",
                pfp_url=None,
                custody_address=None,
            ),
            status="active",
            started_at=datetime.now(timezone.utc).isoformat(),
        ),
        participants=[],
        hand_queue=[],
    )
    _install_fake_room_service(detail)

    response = await client_with_db.get(
        f"/v1/developer/spaces/{room.id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 200, response.text
    assert response.headers["X-Juke-Participants-Source"] == "juke"
