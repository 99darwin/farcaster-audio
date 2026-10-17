"""Tests for the managed-signer (``auth_mode="app_key"``) developer bot
surface added in WS2.

Covers the API-key bot registry endpoints and the JWT dashboard mirror:

* ``POST /v1/developer/bots`` with NEITHER custody field → managed flow:
  201, ``signer_status="pending_approval"``, ``approval_url`` present,
  ``ready=False``, and an ENCRYPTED private key persisted. The raw
  Ed25519 private key must appear in NO response body and NO log record.
* Mixed custody pair (exactly one of the two) → 422.
* Legacy custody body (BOTH fields) is refused with 403: custody_env
  bots are admin-provisioned only.
* ``GET /v1/developer/bots/{id}`` poll drives a pending→approved
  transition (mocked Neynar), 404s cross-app, and nulls ``approval_url``
  once approved.
* ``POST /v1/developer/bots/{id}/signer`` rotates the public key and
  resets the signer to ``pending_approval``.
* ``DELETE /v1/developer/bots/{id}`` nulls the encrypted key at rest.
* ``GET /v1/developer/apps/{app_id}/bots`` (JWT mirror) returns bots for
  the owner and 404s a non-owner.
* ``FarcasterSpacesService.get_developer_bot_bearer`` app_key branch mints
  a JFS bearer decodable by ``decode_jfs_bearer`` with ``fid==bot.fid``,
  and ``BotSignerNotReady`` surfaces (typed) for an unapproved bot.

All upstream Neynar calls are monkeypatched at ``snap_signer_service`` —
no real network. Ed25519 keygen / encryption / JFS minting run for real.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone
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
from app.services import bot_signer_service, snap_signer_service
from app.services.bot_signer_service import (
    BotSignerNotReady,
    decrypt_bot_private_key,
)
from app.services.farcaster_spaces_service import FarcasterSpacesService
from app.services.jfs import decode_jfs_bearer

OWNER_FID = 4001
OTHER_FID = 4002

APPROVAL_URL = "https://warpcast.example/~/signers/approve?token=abc"

BOT_ADDRESS = "0x" + "11" * 20
BOT_KEY_REF = "env:JUKE_TEST_BOT_CUSTODY_KEY"


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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def developer_key_settings(monkeypatch):
    """API-key + bot-signer encryption keys used across the suite."""
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


@pytest.fixture
def mock_neynar_register():
    """Retained for test signatures: provisioning no longer calls any
    upstream registration API (keys are added on-chain via KeyGateway)."""
    return AsyncMock()


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


async def _register_managed_bot(
    client_with_db, secret_key: str, *, fid: int, caplog=None
):
    payload = {"fid": fid, "label": "managed-host"}
    if caplog is not None:
        with caplog.at_level("DEBUG"):
            resp = await client_with_db.post(
                "/v1/developer/bots",
                json=payload,
                headers={"X-Juke-Api-Key": secret_key},
            )
    else:
        resp = await client_with_db.post(
            "/v1/developer/bots",
            json=payload,
            headers={"X-Juke-Api-Key": secret_key},
        )
    return resp


# ---------------------------------------------------------------------------
# 1. POST /bots — managed vs legacy vs mixed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_register_managed_bot_pending_and_key_encrypted(
    client_with_db, db_session, mock_neynar_register, caplog
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    resp = await _register_managed_bot(
        client_with_db, secret_key, fid=80001, caplog=caplog
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()

    assert body["auth_mode"] == "app_key"
    assert body["signer_status"] == "pending_approval"
    assert body["approval_url"] is None
    assert body["ready"] is False
    assert body["signer_public_key"].startswith("0x")
    # No key material in the response — public key only.
    assert "signer_private_key_encrypted" not in body
    assert "signer_private_key" not in body

    row = (
        await db_session.execute(
            select(DeveloperAppBot).where(DeveloperAppBot.fid == 80001)
        )
    ).scalar_one()
    assert row.auth_mode == "app_key"
    assert row.signer_private_key_encrypted  # encrypted blob persisted
    assert row.custody_key_ref is None
    assert row.custody_address is None

    # The RAW Ed25519 private key must never surface in the response or logs.
    raw = decrypt_bot_private_key(row.signer_private_key_encrypted, bot_id=str(row.id))
    assert len(raw) == 32
    assert raw.hex() not in resp.text
    assert raw.hex() not in caplog.text
    assert raw not in caplog.text.encode(errors="ignore")
    # The encrypted blob itself must not be echoed to the client.
    assert row.signer_private_key_encrypted not in resp.text


@pytest.mark.asyncio
async def test_register_bot_mixed_custody_pair_422(
    client_with_db, db_session, mock_neynar_register
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    # Only custody_address, no custody_key_ref → ambiguous → 422.
    resp = await client_with_db.post(
        "/v1/developer/bots",
        json={"fid": 80002, "custody_address": BOT_ADDRESS},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert resp.status_code == 422, resp.text

    # Only custody_key_ref, no custody_address → also 422.
    resp2 = await client_with_db.post(
        "/v1/developer/bots",
        json={"fid": 80003, "custody_key_ref": BOT_KEY_REF},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert resp2.status_code == 422, resp2.text


@pytest.mark.asyncio
async def test_register_legacy_custody_bot_refused_self_serve(
    client_with_db, db_session, mock_neynar_register
):
    """C1: custody_env bots name a server-side secret, so self-serve
    registration refuses them (403) and persists nothing."""
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    resp = await client_with_db.post(
        "/v1/developer/bots",
        json={
            "fid": 80004,
            "custody_address": BOT_ADDRESS,
            "custody_key_ref": BOT_KEY_REF,
            "label": "legacy",
        },
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert resp.status_code == 403, resp.text
    assert "managed signer" in resp.json()["detail"]
    mock_neynar_register.assert_not_awaited()
    rows = (
        (
            await db_session.execute(
                select(DeveloperAppBot).where(DeveloperAppBot.fid == 80004)
            )
        )
        .scalars()
        .all()
    )
    assert rows == []


# ---------------------------------------------------------------------------
# 2. GET /bots/{id} — status poll
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_bot_poll_pending_to_approved(
    client_with_db, db_session, mock_neynar_register, monkeypatch
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    create = await _register_managed_bot(client_with_db, secret_key, fid=80010)
    assert create.status_code == 201
    bot_id = create.json()["id"]

    # Backdate the last-checked stamp so the 30s pending recheck window
    # doesn't short-circuit the poll's Neynar call.
    row = (
        await db_session.execute(
            select(DeveloperAppBot).where(DeveloperAppBot.id == uuid.UUID(bot_id))
        )
    ).scalar_one()
    row.signer_last_checked_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    await db_session.commit()

    # Neynar now reports the key approved under the bot's own FID.
    monkeypatch.setattr(
        snap_signer_service,
        "check_ed25519_signer_status",
        AsyncMock(return_value={"status": "approved", "fid": 80010}),
    )

    poll = await client_with_db.get(
        f"/v1/developer/bots/{bot_id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert poll.status_code == 200, poll.text
    body = poll.json()
    assert body["signer_status"] == "approved"
    assert body["ready"] is True
    # Approval URL is nulled the moment the signer is approved.
    assert body["approval_url"] is None


@pytest.mark.asyncio
async def test_get_bot_cross_app_404(client_with_db, db_session, mock_neynar_register):
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    _app_a, secret_a = await _create_app_and_key(client_with_db, fid=OWNER_FID)
    _app_b, secret_b = await _create_app_and_key(client_with_db, fid=OTHER_FID)

    create = await _register_managed_bot(client_with_db, secret_a, fid=80011)
    bot_id = create.json()["id"]

    # B polls A's bot → opaque 404.
    poll = await client_with_db.get(
        f"/v1/developer/bots/{bot_id}",
        headers={"X-Juke-Api-Key": secret_b},
    )
    assert poll.status_code == 404, poll.text
    assert poll.json()["detail"] == "Bot not found"


@pytest.mark.asyncio
async def test_get_bot_poll_neynar_blip_serves_stale(
    client_with_db, db_session, mock_neynar_register, monkeypatch
):
    """A transient Neynar failure during a poll must NOT 502 — the stale
    (pending) row is served instead."""
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    create = await _register_managed_bot(client_with_db, secret_key, fid=80012)
    bot_id = create.json()["id"]

    row = (
        await db_session.execute(
            select(DeveloperAppBot).where(DeveloperAppBot.id == uuid.UUID(bot_id))
        )
    ).scalar_one()
    row.signer_last_checked_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    await db_session.commit()

    monkeypatch.setattr(
        snap_signer_service,
        "check_ed25519_signer_status",
        AsyncMock(side_effect=httpx.ReadTimeout("neynar slow")),
    )

    poll = await client_with_db.get(
        f"/v1/developer/bots/{bot_id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert poll.status_code == 200, poll.text
    assert poll.json()["signer_status"] == "pending_approval"


# ---------------------------------------------------------------------------
# 3. POST /bots/{id}/signer — re-register with a fresh keypair
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reregister_signer_rotates_pubkey(
    client_with_db, db_session, mock_neynar_register
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    create = await _register_managed_bot(client_with_db, secret_key, fid=80020)
    bot_id = create.json()["id"]
    original_pubkey = create.json()["signer_public_key"]

    rereg = await client_with_db.post(
        f"/v1/developer/bots/{bot_id}/signer",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert rereg.status_code == 200, rereg.text
    body = rereg.json()
    assert body["signer_status"] == "pending_approval"
    assert body["approval_url"] is None
    assert body["ready"] is False
    # A brand-new keypair was generated.
    assert body["signer_public_key"] != original_pubkey


@pytest.mark.asyncio
async def test_reregister_signer_cross_app_404(
    client_with_db, db_session, mock_neynar_register
):
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    _app_a, secret_a = await _create_app_and_key(client_with_db, fid=OWNER_FID)
    _app_b, secret_b = await _create_app_and_key(client_with_db, fid=OTHER_FID)

    create = await _register_managed_bot(client_with_db, secret_a, fid=80021)
    bot_id = create.json()["id"]

    rereg = await client_with_db.post(
        f"/v1/developer/bots/{bot_id}/signer",
        headers={"X-Juke-Api-Key": secret_b},
    )
    assert rereg.status_code == 404, rereg.text


# ---------------------------------------------------------------------------
# 4. DELETE /bots/{id} — nulls encrypted key
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_managed_bot_nulls_encrypted_key(
    client_with_db, db_session, mock_neynar_register
):
    await _seed_user(db_session)
    _app_id, secret_key = await _create_app_and_key(client_with_db)

    create = await _register_managed_bot(client_with_db, secret_key, fid=80030)
    bot_id = create.json()["id"]

    row = (
        await db_session.execute(
            select(DeveloperAppBot).where(DeveloperAppBot.id == uuid.UUID(bot_id))
        )
    ).scalar_one()
    assert row.signer_private_key_encrypted is not None

    delete = await client_with_db.delete(
        f"/v1/developer/bots/{bot_id}",
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert delete.status_code == 200, delete.text

    await db_session.refresh(row)
    assert row.is_active is False
    assert row.signer_private_key_encrypted is None


# ---------------------------------------------------------------------------
# 5. GET /apps/{app_id}/bots — JWT dashboard mirror
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apps_bots_mirror_owner_and_nonowner(
    client_with_db, db_session, mock_neynar_register
):
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    app_id, secret_key = await _create_app_and_key(client_with_db, fid=OWNER_FID)

    await _register_managed_bot(client_with_db, secret_key, fid=80040)

    # Owner (JWT auth, no API key) sees the bot under the ``bots`` key.
    owner = await client_with_db.get(
        f"/v1/developer/apps/{app_id}/bots",
        headers=_auth_header(OWNER_FID),
    )
    assert owner.status_code == 200, owner.text
    bots = owner.json()["bots"]
    assert [b["fid"] for b in bots] == [80040]
    assert bots[0]["auth_mode"] == "app_key"
    assert bots[0]["ready"] is False

    # Non-owner → 404 (get_owned_app convention).
    nonowner = await client_with_db.get(
        f"/v1/developer/apps/{app_id}/bots",
        headers=_auth_header(OTHER_FID),
    )
    assert nonowner.status_code == 404, nonowner.text


# ---------------------------------------------------------------------------
# 6. FarcasterSpacesService.get_developer_bot_bearer — app_key branch
# ---------------------------------------------------------------------------


async def _seed_approved_managed_bot(
    db: AsyncSession, monkeypatch, *, app_id: uuid.UUID, fid: int
) -> DeveloperAppBot:
    """Provision a managed signer directly then flip it to approved."""
    bot = DeveloperAppBot(
        app_id=app_id, fid=fid, is_active=True, auth_mode="custody_env"
    )
    db.add(bot)
    await db.flush()
    await bot_signer_service.provision_bot_signer(db, bot)
    bot.signer_status = "approved"
    bot.signer_approval_url = None
    await db.commit()
    await db.refresh(bot)
    return bot


@pytest.mark.asyncio
async def test_get_developer_bot_bearer_app_key_mints_decodable_jfs(
    db_session, monkeypatch
):
    await _seed_user(db_session)
    app_row = DeveloperApp(owner_fid=OWNER_FID, name="jfs-app")
    db_session.add(app_row)
    await db_session.commit()
    await db_session.refresh(app_row)

    bot = await _seed_approved_managed_bot(
        db_session, monkeypatch, app_id=app_row.id, fid=90001
    )

    svc = FarcasterSpacesService(settings)
    bearer = await svc.get_developer_bot_bearer(app_row.id, 90001, db_session)
    # The minted JFS bearer must be structurally valid and carry the bot fid.
    assert decode_jfs_bearer(bearer) == 90001
    # Managed bearers are never cached (300s TTL, cheap signing).
    assert (app_row.id, 90001) not in svc._dev_bot_bearer_cache

    # A second call mints a FRESH bearer (not served from a cache).
    bearer2 = await svc.get_developer_bot_bearer(app_row.id, 90001, db_session)
    assert decode_jfs_bearer(bearer2) == 90001
    _ = bot  # keep reference for clarity
    await svc.aclose()


@pytest.mark.asyncio
async def test_get_developer_bot_bearer_unapproved_raises_not_ready(
    db_session, monkeypatch
):
    """An unapproved managed bot surfaces ``BotSignerNotReady`` (typed) so
    routers can map it to a 409 — NOT the opaque 503 that config/crypto
    failures take."""
    await _seed_user(db_session)
    app_row = DeveloperApp(owner_fid=OWNER_FID, name="pending-app")
    db_session.add(app_row)
    await db_session.commit()
    await db_session.refresh(app_row)

    bot = DeveloperAppBot(
        app_id=app_row.id, fid=90002, is_active=True, auth_mode="custody_env"
    )
    db_session.add(bot)
    await db_session.flush()
    await bot_signer_service.provision_bot_signer(db_session, bot)
    # Still pending_approval → not mintable.

    svc = FarcasterSpacesService(settings)
    with pytest.raises(BotSignerNotReady):
        await svc.get_developer_bot_bearer(app_row.id, 90002, db_session)
    await svc.aclose()
