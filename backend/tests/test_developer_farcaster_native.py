"""Tests for the Phase-4 part-2 developer API: native-mode spaces +
per-app bot registry.

Covers:

* ``POST /v1/developer/bots`` registers a managed bot row and refuses
  legacy custody mode (403, C1).
* Duplicate ``(app_id, fid)`` is rejected (409); same fid under a
  different app is accepted.
* ``GET /v1/developer/bots`` is scoped to the calling app.
* ``DELETE /v1/developer/bots/{id}`` soft-deactivates (row stays;
  ``is_active=False``).
* ``POST /v1/developer/spaces`` with ``host="farcaster"`` requires
  ``host_bot_fid`` (422 when missing) and rejects bots owned by
  other apps (403).
* The native-host happy path creates a Juke ``Room`` with
  ``is_farcaster_native=True`` + ``farcaster_room_id`` set.
* The ``host="juke"`` path is unchanged (delegates to the fake room
  service like the existing developer-key tests).
* ``POST /v1/developer/rooms/{room_id}/agent-join`` with
  ``agent_bot_fid`` returns ``{wsUrl, token}`` for native rooms and
  preserves the existing Juke-hosted flow when called without that
  field.
* ``FarcasterSpacesService.get_developer_bot_bearer`` caches per
  ``(app_id, fid)`` — the second call does NOT re-mint — but re-checks
  ``is_active`` before serving from cache.
* The custody_key_ref resolver only resolves allowlisted, prefixed env
  vars whose key matches the registered + on-chain custody address, and
  fails with one uniform error otherwise.

All upstream ``client.farcaster.xyz`` calls are intercepted at the
httpx transport layer (``httpx.MockTransport``) — no real network.
``eth-account`` runs for real so the EIP-191 sign-and-mint path is
exercised end-to-end.
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
from app.schemas.farcaster_spaces import FarcasterSpacesConfigError
from app.schemas.room import RoomCreateResponse, RoomResponse
from app.services.farcaster_spaces_service import (
    CUSTODY_KEY_REF_FAILED,
    FarcasterSpacesService,
)
from tests.custody_bot_helpers import (
    allowlist_custody_ref,
    custody_address_for,
    install_custody_fakes,
    seed_custody_bot,
)

OWNER_FID = 3001
OTHER_FID = 3002

# Test private keys — not associated with any real FID. Env var names
# carry the mandatory ``JUKE_DEV_BOT_CUSTODY_`` prefix.
BOT_KEY_HEX = "0x" + "ab" * 32
BOT_KEY_ENV_VAR = "JUKE_DEV_BOT_CUSTODY_TEST_BOT"

OTHER_BOT_KEY_HEX = "0x" + "cd" * 32
OTHER_BOT_KEY_ENV_VAR = "JUKE_DEV_BOT_CUSTODY_TEST_OTHER_BOT"

BOT_ADDRESS = custody_address_for(BOT_KEY_HEX)
OTHER_BOT_ADDRESS = custody_address_for(OTHER_BOT_KEY_HEX)

BOT_KEY_REF = f"env:{BOT_KEY_ENV_VAR}"


# ---------------------------------------------------------------------------
# Auth + SIWN sidecar helpers (mirrored from test_developer_keys.py)
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def developer_key_settings(monkeypatch):
    """Match the encryption keys used by other developer tests."""
    monkeypatch.setattr(settings, "JUKE_API_KEY_PEPPER", "test-pepper")
    monkeypatch.setattr(
        settings,
        "JUKE_API_KEY_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(b"0" * 32).decode(),
    )


@pytest.fixture(autouse=True)
def bot_signer_key(monkeypatch):
    """Managed-signer encryption key so self-serve registration works."""
    monkeypatch.setattr(
        settings,
        "JUKE_BOT_SIGNER_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(bytes([0x11]) * 32).decode(),
    )


@pytest.fixture(autouse=True)
def onchain(monkeypatch):
    """Empty custody allowlist + fake on-chain custody lookup."""
    return install_custody_fakes(monkeypatch)


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
        # Ensure no leaked FarcasterSpacesService stub between tests —
        # the next test installs a fresh transport via _install_mock_fcsp.
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
    """Create a dev app + API key, return (app_id, secret_key)."""
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


# ---------------------------------------------------------------------------
# Mock FarcasterSpacesService transport
# ---------------------------------------------------------------------------


def _install_mock_fcsp(
    *,
    farcaster_room_id: str = "11111111-2222-3333-4444-555555555555",
    join_ws_url: str = "wss://livekit.upstream.example",
    join_token: str = "lk-upstream-token",
) -> tuple[FarcasterSpacesService, dict[str, int]]:
    """Build a ``FarcasterSpacesService`` wired to a deterministic
    mock transport. Install it as ``app.state.farcaster_spaces_service``.

    Returns the (service, counters) tuple. Counters are a dict
    tracking ``mints``, ``creates``, ``joins``.
    """
    counters: dict[str, int] = {"mints": 0, "creates": 0, "joins": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if req.method == "PUT" and "onboarding-state" in url:
            counters["mints"] += 1
            return httpx.Response(
                200,
                json={
                    "result": {
                        "token": {
                            "secret": f"tok_dev_bot_{counters['mints']}",
                            "expiresAt": (int(time.time() * 1000) + 10 * 86400 * 1000),
                        }
                    }
                },
            )
        if req.method == "POST" and url.endswith("/v1/audio-rooms"):
            counters["creates"] += 1
            return httpx.Response(
                200,
                json={
                    "result": {
                        "room": {
                            "id": farcaster_room_id,
                            "title": "From upstream",
                            "host": {"fid": 1, "username": "bot"},
                            "state": "scheduled",
                        }
                    }
                },
            )
        if req.method == "POST" and "audio-room/join" in url:
            counters["joins"] += 1
            return httpx.Response(
                200,
                json={
                    "result": {
                        "wsUrl": join_ws_url,
                        "token": join_token,
                    }
                },
            )
        return httpx.Response(404, json={"error": "unmocked"})

    svc = FarcasterSpacesService(settings)
    svc._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=10.0,
        follow_redirects=False,
    )
    app.state.farcaster_spaces_service = svc
    return svc, counters


# ---------------------------------------------------------------------------
# 1. Bot registry CRUD
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_register_bot_persists_row(client_with_db, db_session):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    response = await client_with_db.post(
        "/v1/developer/bots",
        json={"fid": 50001, "label": "concierge"},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["fid"] == 50001
    assert body["label"] == "concierge"
    assert body["is_active"] is True
    assert body["auth_mode"] == "app_key"
    assert "custody_key_ref" not in body
    assert "custody_address" not in body

    row = (
        await db_session.execute(
            select(DeveloperAppBot).where(DeveloperAppBot.fid == 50001)
        )
    ).scalar_one()
    assert row.custody_key_ref is None
    assert row.is_active is True


@pytest.mark.asyncio
async def test_register_custody_bot_refused_self_serve(client_with_db, db_session):
    """C1: a self-serve key must not be able to point a bot at a server
    env var (e.g. ``env:JWT_SECRET``) — custody mode is admin-only."""
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    for key_ref in (BOT_KEY_REF, "env:JWT_SECRET"):
        response = await client_with_db.post(
            "/v1/developer/bots",
            json={
                "fid": 50009,
                "custody_address": BOT_ADDRESS,
                "custody_key_ref": key_ref,
            },
            headers={"X-Juke-Api-Key": secret_key},
        )
        assert response.status_code == 403, response.text
        assert "JWT_SECRET" not in response.text

    rows = (
        (
            await db_session.execute(
                select(DeveloperAppBot).where(DeveloperAppBot.fid == 50009)
            )
        )
        .scalars()
        .all()
    )
    assert rows == []


@pytest.mark.asyncio
async def test_register_bot_duplicate_fid_for_same_app_rejected(
    client_with_db, db_session
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    payload = {"fid": 50002}
    first = await client_with_db.post(
        "/v1/developer/bots",
        json=payload,
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert first.status_code == 201

    second = await client_with_db.post(
        "/v1/developer/bots",
        json=payload,
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_register_bot_same_fid_different_app_allowed(client_with_db, db_session):
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    _app_a, secret_a = await _create_app_and_key(client_with_db, fid=OWNER_FID)
    _app_b, secret_b = await _create_app_and_key(client_with_db, fid=OTHER_FID)

    payload = {"fid": 50003}
    a = await client_with_db.post(
        "/v1/developer/bots",
        json=payload,
        headers={"X-Juke-Api-Key": secret_a},
    )
    assert a.status_code == 201, a.text

    b = await client_with_db.post(
        "/v1/developer/bots",
        json=payload,
        headers={"X-Juke-Api-Key": secret_b},
    )
    assert b.status_code == 201, b.text


@pytest.mark.asyncio
async def test_list_bots_scoped_to_calling_app(client_with_db, db_session):
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    _app_a, secret_a = await _create_app_and_key(client_with_db, fid=OWNER_FID)
    _app_b, secret_b = await _create_app_and_key(client_with_db, fid=OTHER_FID)

    await client_with_db.post(
        "/v1/developer/bots",
        json={"fid": 50004, "label": "A-bot"},
        headers={"X-Juke-Api-Key": secret_a},
    )
    await client_with_db.post(
        "/v1/developer/bots",
        json={"fid": 50005, "label": "B-bot"},
        headers={"X-Juke-Api-Key": secret_b},
    )

    list_a = await client_with_db.get(
        "/v1/developer/bots",
        headers={"X-Juke-Api-Key": secret_a},
    )
    assert list_a.status_code == 200
    a_fids = sorted(b["fid"] for b in list_a.json()["bots"])
    assert a_fids == [50004]

    list_b = await client_with_db.get(
        "/v1/developer/bots",
        headers={"X-Juke-Api-Key": secret_b},
    )
    assert list_b.status_code == 200
    b_fids = sorted(b["fid"] for b in list_b.json()["bots"])
    assert b_fids == [50005]


@pytest.mark.asyncio
async def test_delete_bot_deactivates(client_with_db, db_session):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    create = await client_with_db.post(
        "/v1/developer/bots",
        json={"fid": 50006},
        headers={"X-Juke-Api-Key": secret_key},
    )
    bot_id = create.json()["id"]

    delete = await client_with_db.delete(
        f"/v1/developer/bots/{bot_id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert delete.status_code == 200
    assert delete.json()["status"] == "deactivated"

    row = (
        await db_session.execute(
            select(DeveloperAppBot).where(DeveloperAppBot.fid == 50006)
        )
    ).scalar_one()
    # Soft delete: row remains, is_active flipped.
    assert row.is_active is False


# ---------------------------------------------------------------------------
# 2. POST /v1/developer/spaces — native host branch
# ---------------------------------------------------------------------------


class _FakeDeveloperRoomService:
    """Stand-in for ``RoomService`` on the Juke-hosted path. Captures
    calls and returns a deterministic ``RoomCreateResponse``."""

    def __init__(self):
        self.calls: list[dict[str, Any]] = []
        # Minimal RedisService surface needed by the native-host path:
        # ``publish_room_discovery_event`` is awaited once.
        self.redis = AsyncMock()
        self.redis.publish_room_discovery_event = AsyncMock()

    async def create_room(
        self,
        *,
        fid: int,
        title: str,
        announce_cast: bool = False,
        scheduled_at=None,
        allow_agents: bool = True,
        created_by_app_id=None,
    ) -> RoomCreateResponse:
        self.calls.append(
            {
                "fid": fid,
                "title": title,
                "announce_cast": announce_cast,
                "scheduled_at": scheduled_at,
                "allow_agents": allow_agents,
                "created_by_app_id": created_by_app_id,
            }
        )
        return RoomCreateResponse(
            room=RoomResponse(
                id=str(uuid.uuid4()),
                title=title,
                host_fid=fid,
                host=UserResponse(
                    fid=fid,
                    username=f"user{fid}",
                    display_name=f"user{fid}",
                    pfp_url=None,
                    custody_address=None,
                ),
                status="active",
                started_at=datetime.now(timezone.utc).isoformat(),
                allow_agents=allow_agents,
            ),
            livekit_token="fake-livekit-token",
            livekit_ws_url="wss://livekit.juke.example",
            expires_at=datetime.now(timezone.utc).isoformat(),
        )


def _install_fake_room_service() -> _FakeDeveloperRoomService:
    fake = _FakeDeveloperRoomService()

    async def _override():
        yield fake

    app.dependency_overrides[get_developer_room_service] = _override
    return fake


async def _register_bot(
    db: AsyncSession,
    monkeypatch,
    onchain,
    app_id: str,
    *,
    fid: int = 60001,
) -> DeveloperAppBot:
    """Seed an admin-provisioned custody bot (self-serve refuses them)."""
    return await seed_custody_bot(
        db,
        monkeypatch,
        onchain,
        app_id=app_id,
        fid=fid,
        private_key_hex=BOT_KEY_HEX,
        env_var=BOT_KEY_ENV_VAR,
    )


@pytest.mark.asyncio
async def test_create_space_native_requires_bot_fid(client_with_db, db_session):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    # Even though the bot would be valid, the body itself is missing
    # ``host_bot_fid`` → 422.
    _install_fake_room_service()

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Native space", "host": "farcaster"},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_create_space_native_requires_owned_bot(
    client_with_db, db_session, monkeypatch, onchain
):
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    _app_a, secret_a = await _create_app_and_key(client_with_db, fid=OWNER_FID)
    _app_b, secret_b = await _create_app_and_key(client_with_db, fid=OTHER_FID)

    # Bot belongs to A only.
    await _register_bot(db_session, monkeypatch, onchain, _app_a, fid=60010)

    _install_mock_fcsp()
    _install_fake_room_service()

    # B tries to host with A's bot fid → 403.
    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={
            "title": "B steals A's bot",
            "host": "farcaster",
            "host_bot_fid": 60010,
        },
        headers={"X-Juke-Api-Key": secret_b},
    )
    assert response.status_code == 403, response.text


@pytest.mark.asyncio
async def test_create_space_native_happy_path(
    client_with_db, db_session, monkeypatch, onchain
):
    owner = await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_bot(db_session, monkeypatch, onchain, _app_id, fid=60020)

    svc, counters = _install_mock_fcsp(
        farcaster_room_id="dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"
    )
    _install_fake_room_service()

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={
            "title": "Happy native",
            "host": "farcaster",
            "host_bot_fid": 60020,
        },
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["room"]["is_farcaster_native"] is True
    assert body["room"]["farcaster_room_id"] == "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"
    assert body["room"]["host_fid"] == OWNER_FID
    # Native rooms have no Juke LiveKit token surface.
    assert body["livekit_token"] is None
    assert body["livekit_ws_url"] is None

    # Upstream mint + create both happened exactly once.
    assert counters["mints"] == 1
    assert counters["creates"] == 1

    # Persisted Juke row.
    row = (
        await db_session.execute(
            select(Room).where(
                Room.farcaster_room_id == ("dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb")
            )
        )
    ).scalar_one()
    assert row.is_farcaster_native is True
    assert row.host_fid == OWNER_FID
    assert row.created_by_app_id is not None
    # Bot fid stashed in metadata for non-host readers.
    assert row.metadata_["farcaster_host_fid"] == 60020
    # The fake room service was NOT consulted on the native path.


@pytest.mark.asyncio
async def test_create_space_juke_path_unchanged(client_with_db, db_session):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    fake = _install_fake_room_service()
    # No FCSP install — the Juke path must not touch the upstream
    # service at all.

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Plain Juke room"},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["room"]["host_fid"] == OWNER_FID
    assert body["livekit_token"] == "fake-livekit-token"
    # The fake room service was hit once.
    assert len(fake.calls) == 1
    assert fake.calls[0]["title"] == "Plain Juke room"


# ---------------------------------------------------------------------------
# 3. POST /v1/developer/rooms/{room_id}/agent-join — native branch
# ---------------------------------------------------------------------------


async def _seed_native_room(
    db: AsyncSession,
    *,
    host_fid: int,
    app_id: uuid.UUID,
    farcaster_room_id: str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
) -> Room:
    room = Room(
        title="Native room",
        host_fid=host_fid,
        status="active",
        livekit_room_id=None,
        is_farcaster_native=True,
        farcaster_room_id=farcaster_room_id,
        created_by_app_id=app_id,
        allow_agents=True,
        metadata_={"farcaster_host_fid": 60020, "source": "developer-api"},
    )
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return room


@pytest.mark.asyncio
async def test_agent_join_native_returns_livekit_creds(
    client_with_db, db_session, monkeypatch, onchain
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)
    await _register_bot(db_session, monkeypatch, onchain, _app_id, fid=60030)

    app_row = (
        await db_session.execute(
            select(DeveloperApp).where(DeveloperApp.id == uuid.UUID(_app_id))
        )
    ).scalar_one()
    room = await _seed_native_room(
        db_session,
        host_fid=OWNER_FID,
        app_id=app_row.id,
    )

    _install_mock_fcsp(
        join_ws_url="wss://livekit.upstream.example:443",
        join_token="upstream-token-xyz",
    )

    response = await client_with_db.post(
        f"/v1/developer/rooms/{room.id}/agent-join",
        json={
            "agent_name": "concierge",
            "agent_bot_fid": 60030,
        },
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["wsUrl"] == "wss://livekit.upstream.example:443"
    assert body["token"] == "upstream-token-xyz"
    assert body["farcaster_room_id"] == room.farcaster_room_id


def test_agent_join_juke_path_unchanged():
    """A Juke-hosted room — or one called without ``agent_bot_fid`` —
    still goes through the existing session-token + LiveKit flow.

    We verify the branch routing in the handler source rather than
    running the full Juke flow end-to-end: the existing path needs a
    populated Redis SessionService + LiveKit token mint + ``bans``
    table that's out of scope for this scaffolding test. The branch
    routing itself is what changed — the existing tests in
    ``test_developer_keys.py`` already cover the Juke path's runtime
    behavior under their own fixtures.
    """
    import inspect

    from app.routers.developer import partner_agent_join_room

    src = inspect.getsource(partner_agent_join_room)
    # Native branch is gated on BOTH is_farcaster_native AND a non-None
    # agent_bot_fid — falling through otherwise to the existing Juke
    # session-token + LiveKit path.
    assert "room.is_farcaster_native and body.agent_bot_fid is not None" in src
    # Existing Juke gates are still present after the native short-circuit.
    assert 'room.status != "active"' in src
    assert "not room.allow_agents" in src
    # The native helper is called before the Juke gates fire.
    native_idx = src.find("_native_agent_join")
    juke_status_idx = src.find('room.status != "active"')
    assert native_idx != -1 and juke_status_idx != -1
    assert native_idx < juke_status_idx


@pytest.mark.asyncio
async def test_agent_join_native_rejects_unowned_bot(
    client_with_db, db_session, monkeypatch, onchain
):
    """Even on a room owned by app A, an ``agent_bot_fid`` not
    registered to A is rejected with 403."""
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    app_a, secret_a = await _create_app_and_key(client_with_db, fid=OWNER_FID)
    app_b, secret_b = await _create_app_and_key(client_with_db, fid=OTHER_FID)

    # B's bot.
    await _register_bot(db_session, monkeypatch, onchain, app_b, fid=60040)

    app_a_row = (
        await db_session.execute(
            select(DeveloperApp).where(DeveloperApp.id == uuid.UUID(app_a))
        )
    ).scalar_one()
    room = await _seed_native_room(db_session, host_fid=OWNER_FID, app_id=app_a_row.id)

    _install_mock_fcsp()

    # A calls its own room's agent-join with B's bot fid → 403.
    response = await client_with_db.post(
        f"/v1/developer/rooms/{room.id}/agent-join",
        json={"agent_name": "thief", "agent_bot_fid": 60040},
        headers={"X-Juke-Api-Key": secret_a},
    )
    assert response.status_code == 403, response.text


# ---------------------------------------------------------------------------
# 4. FarcasterSpacesService.get_developer_bot_bearer caching
# ---------------------------------------------------------------------------


async def _seed_app(db: AsyncSession, *, owner_fid: int, name: str) -> DeveloperApp:
    app_row = DeveloperApp(owner_fid=owner_fid, name=name)
    db.add(app_row)
    await db.commit()
    await db.refresh(app_row)
    return app_row


@pytest.mark.asyncio
async def test_developer_bot_bearer_cached_per_fid(db_session, monkeypatch, onchain):
    """The (app_id, fid) cache must return the same bearer on a second
    call without re-minting."""
    await _seed_user(db_session)
    app_row = await _seed_app(db_session, owner_fid=OWNER_FID, name="cache-test-app")
    await seed_custody_bot(
        db_session,
        monkeypatch,
        onchain,
        app_id=app_row.id,
        fid=70001,
        private_key_hex=BOT_KEY_HEX,
        env_var=BOT_KEY_ENV_VAR,
    )
    await seed_custody_bot(
        db_session,
        monkeypatch,
        onchain,
        app_id=app_row.id,
        fid=70002,
        private_key_hex=OTHER_BOT_KEY_HEX,
        env_var=OTHER_BOT_KEY_ENV_VAR,
    )

    svc, counters = _install_mock_fcsp()

    first = await svc.get_developer_bot_bearer(app_row.id, 70001, db_session)
    second = await svc.get_developer_bot_bearer(app_row.id, 70001, db_session)
    assert first == second
    assert counters["mints"] == 1

    # Different FID → separate mint, separate cache slot.
    third = await svc.get_developer_bot_bearer(app_row.id, 70002, db_session)
    assert third != first
    assert counters["mints"] == 2

    await svc.aclose()


@pytest.mark.asyncio
async def test_deactivated_bot_refused_even_with_cached_bearer(
    db_session, monkeypatch, onchain
):
    """L8: ``is_active`` is checked BEFORE the bearer cache, so a
    deactivated bot stops minting immediately and its slot is evicted."""
    await _seed_user(db_session)
    app_row = await _seed_app(db_session, owner_fid=OWNER_FID, name="l8-app")
    bot = await seed_custody_bot(
        db_session,
        monkeypatch,
        onchain,
        app_id=app_row.id,
        fid=70003,
        private_key_hex=BOT_KEY_HEX,
        env_var=BOT_KEY_ENV_VAR,
    )
    svc, counters = _install_mock_fcsp()
    await svc.get_developer_bot_bearer(app_row.id, 70003, db_session)
    assert (app_row.id, 70003) in svc._dev_bot_bearer_cache

    bot.is_active = False
    await db_session.commit()
    # No manual cache bust: the cached bearer must not be served.
    with pytest.raises(FarcasterSpacesConfigError):
        await svc.get_developer_bot_bearer(app_row.id, 70003, db_session)
    assert (app_row.id, 70003) not in svc._dev_bot_bearer_cache
    assert counters["mints"] == 1
    await svc.aclose()


@pytest.mark.asyncio
async def test_developer_bot_bearer_rejects_cross_app(db_session, monkeypatch, onchain):
    """Service-layer defense-in-depth: even with an active row, the
    lookup is gated on ``app_id`` so a stale cache or buggy router
    cannot mint for a bot from a different app."""
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)

    app_a = DeveloperApp(owner_fid=OWNER_FID, name="A")
    app_b = DeveloperApp(owner_fid=OTHER_FID, name="B")
    db_session.add_all([app_a, app_b])
    await db_session.commit()
    await db_session.refresh(app_a)
    await db_session.refresh(app_b)

    await seed_custody_bot(
        db_session,
        monkeypatch,
        onchain,
        app_id=app_b.id,
        fid=70010,
        private_key_hex=BOT_KEY_HEX,
        env_var=BOT_KEY_ENV_VAR,
    )

    svc, _counters = _install_mock_fcsp()
    # Asking for fid=70010 under app A's id must fail even though the
    # bot exists under B.
    with pytest.raises(FarcasterSpacesConfigError):
        await svc.get_developer_bot_bearer(app_a.id, 70010, db_session)

    await svc.aclose()


@pytest.mark.asyncio
async def test_custody_key_ref_unsupported_scheme_rejected(db_session):
    """The resolver must refuse unknown schemes (e.g. raw ``0x...``
    accidentally stored as the ref). Defense against a developer
    mistakenly pasting the literal key into the field."""
    svc = FarcasterSpacesService(settings)
    app_id = uuid.uuid4()
    for ref in ("0x" + "11" * 32, "kms:not-implemented-yet", "", "env:", None):
        with pytest.raises(FarcasterSpacesConfigError) as exc:
            svc._resolve_custody_key_ref(ref, app_id=app_id)
        assert str(exc.value) == CUSTODY_KEY_REF_FAILED
    await svc.aclose()


@pytest.mark.asyncio
async def test_custody_key_ref_requires_allowlist_and_prefix(monkeypatch, caplog):
    """C1: a ref resolves only when (app_id, VAR) is allowlisted AND VAR has
    the dedicated prefix. Platform secrets are unreachable even if an admin
    mistakenly allowlists them; every failure is the same opaque error and
    no var name is logged."""
    svc = FarcasterSpacesService(settings)
    app_id = uuid.uuid4()
    other_app = uuid.uuid4()
    monkeypatch.setenv(BOT_KEY_ENV_VAR, BOT_KEY_HEX)
    monkeypatch.setenv("JUKE_TEST_PLATFORM_SECRET", "0x" + "ef" * 32)

    cases = [
        # Not allowlisted at all.
        ("", f"env:{BOT_KEY_ENV_VAR}"),
        # Allowlisted for a different app only.
        (f"{other_app}:{BOT_KEY_ENV_VAR}", f"env:{BOT_KEY_ENV_VAR}"),
        # Allowlisted but missing the mandatory prefix (platform secret).
        (f"{app_id}:JUKE_TEST_PLATFORM_SECRET", "env:JUKE_TEST_PLATFORM_SECRET"),
        (f"{app_id}:JWT_SECRET", "env:JWT_SECRET"),
        # Allowlisted + prefixed but unset in the environment.
        (
            f"{app_id}:JUKE_DEV_BOT_CUSTODY_UNSET",
            "env:JUKE_DEV_BOT_CUSTODY_UNSET",
        ),
    ]
    with caplog.at_level("DEBUG"):
        for allowlist, ref in cases:
            monkeypatch.setattr(settings, "DEVELOPER_CUSTODY_KEY_REFS", allowlist)
            with pytest.raises(FarcasterSpacesConfigError) as exc:
                svc._resolve_custody_key_ref(ref, app_id=app_id)
            assert str(exc.value) == CUSTODY_KEY_REF_FAILED
    for name in (BOT_KEY_ENV_VAR, "JUKE_TEST_PLATFORM_SECRET", "JWT_SECRET"):
        assert name not in caplog.text

    # Malformed entries are skipped; the valid pair still resolves.
    monkeypatch.setattr(
        settings,
        "DEVELOPER_CUSTODY_KEY_REFS",
        f"garbage, {other_app}:X ,{app_id}:{BOT_KEY_ENV_VAR}",
    )
    assert (
        svc._resolve_custody_key_ref(f"env:{BOT_KEY_ENV_VAR}", app_id=app_id)
        == BOT_KEY_HEX
    )
    await svc.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "registered_address,onchain_address",
    [
        # Registered address doesn't match the resolved key.
        (OTHER_BOT_ADDRESS, BOT_ADDRESS),
        # Resolved key isn't the fid's current on-chain custody.
        (BOT_ADDRESS, OTHER_BOT_ADDRESS),
        # Fid has no on-chain custody.
        (BOT_ADDRESS, None),
    ],
)
async def test_custody_key_must_match_registered_and_onchain_custody(
    db_session, monkeypatch, onchain, registered_address, onchain_address
):
    """C1: even an allowlisted key only mints for the fid it actually
    controls (address derived from key == registered == on-chain)."""
    await _seed_user(db_session)
    app_row = await _seed_app(db_session, owner_fid=OWNER_FID, name="match-app")
    monkeypatch.setenv(BOT_KEY_ENV_VAR, BOT_KEY_HEX)
    allowlist_custody_ref(app_row.id, BOT_KEY_ENV_VAR)
    if onchain_address is not None:
        onchain.by_fid[70020] = onchain_address
    db_session.add(
        DeveloperAppBot(
            app_id=app_row.id,
            fid=70020,
            custody_address=registered_address,
            custody_key_ref=BOT_KEY_REF,
            is_active=True,
            auth_mode="custody_env",
        )
    )
    await db_session.commit()

    svc, counters = _install_mock_fcsp()
    with pytest.raises(FarcasterSpacesConfigError) as exc:
        await svc.get_developer_bot_bearer(app_row.id, 70020, db_session)
    assert str(exc.value) == CUSTODY_KEY_REF_FAILED
    assert counters["mints"] == 0
    await svc.aclose()


@pytest.mark.asyncio
async def test_custody_onchain_lookup_failure_is_uniform_error(
    db_session, monkeypatch, onchain
):
    import app.services.farcaster_spaces_service as fcsp_module
    from app.clients.key_gateway import KeyGatewayError

    await _seed_user(db_session)
    app_row = await _seed_app(db_session, owner_fid=OWNER_FID, name="rpc-app")
    await seed_custody_bot(
        db_session,
        monkeypatch,
        onchain,
        app_id=app_row.id,
        fid=70030,
        private_key_hex=BOT_KEY_HEX,
        env_var=BOT_KEY_ENV_VAR,
    )

    async def _boom(_fid, **_kwargs):
        raise KeyGatewayError("rpc down")

    monkeypatch.setattr(fcsp_module.key_gateway, "custody_of", _boom)
    svc, counters = _install_mock_fcsp()
    with pytest.raises(FarcasterSpacesConfigError) as exc:
        await svc.get_developer_bot_bearer(app_row.id, 70030, db_session)
    assert str(exc.value) == CUSTODY_KEY_REF_FAILED
    assert counters["mints"] == 0
    await svc.aclose()
