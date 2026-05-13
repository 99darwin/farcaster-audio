import base64
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from jose import jwt

pytest.importorskip("aiosqlite")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.dependencies import get_db, require_developer_api_key
from app.main import app
from app.models.developer import DeveloperApiKey, DeveloperApp, DeveloperApplication
from app.models.room import Room
from app.models.user import User
from app.routers.developer import get_developer_room_service
from app.middleware.auth import get_admin_user
from app.schemas.auth import UserResponse
from app.schemas.room import RoomCreateResponse, RoomResponse
from app.services.developer_key_service import verify_developer_api_key

OWNER_FID = 1111
OTHER_FID = 2222


def _auth_header(fid: int) -> dict:
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp()),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    # The conftest JWT helper short-circuits /v1/auth/login, so it never marks
    # SIWN in Redis. Step-up-protected routes (rotate/revoke/reveal/delete-app)
    # check has_recent_siwn(fid). We mark every fresh JWT here so the existing
    # test suite keeps passing on those routes — the dedicated step-up tests
    # below clear the marker first to exercise the failure path explicitly.
    _mark_siwn_sync(fid)
    return {"Authorization": f"Bearer {token}"}


def _siwn_store_for(redis) -> dict:
    """Return (and lazily wire up) the SIWN sidecar dict on this mock redis.

    AsyncMock auto-creates any attribute on access, so getattr-with-default
    can't be used to test for the sidecar's existence. We track wiring with
    a `__siwn_wired__` flag stored in the mock's __dict__ directly.
    """
    if not redis.__dict__.get("__siwn_wired__"):
        store: dict[str, str] = {}
        redis.__dict__["__siwn_wired__"] = True
        redis.__dict__["__siwn_store__"] = store

        async def _exists(key, *args, **kwargs):
            if isinstance(key, str) and key.startswith("siwn:") and key in store:
                return 1
            return 0

        # AsyncMock attribute assignment goes through __setattr__ which
        # records the assignment; just put the override on the instance.
        redis.exists = _exists
    return redis.__dict__["__siwn_store__"]


def _mark_siwn_sync(fid: int) -> None:
    """Mark SIWN for `fid` so step-up routes accept the next request."""
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    _siwn_store_for(redis)[f"siwn:{fid}"] = "1"


def _clear_siwn(fid: int) -> None:
    redis = getattr(app.state, "redis", None)
    if redis is None:
        return
    _siwn_store_for(redis).pop(f"siwn:{fid}", None)


@pytest.fixture(autouse=True)
def developer_key_settings(monkeypatch):
    monkeypatch.setattr(settings, "JUKE_API_KEY_PEPPER", "test-pepper")
    monkeypatch.setattr(
        settings,
        "JUKE_API_KEY_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(b"0" * 32).decode(),
    )


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
        app.dependency_overrides.pop(get_admin_user, None)
        app.dependency_overrides.pop(get_developer_room_service, None)


async def _seed_user(
    db: AsyncSession,
    *,
    fid: int = OWNER_FID,
    developer_access_status: str = "approved",
    is_admin: bool = False,
) -> User:
    user = User(
        fid=fid,
        signer_uuid=f"signer-{fid}",
        username=f"user{fid}",
        developer_access_status=developer_access_status,
        is_admin=is_admin,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest.mark.asyncio
async def test_approved_developer_can_create_app_and_key_once_reveal(
    client_with_db, db_session
):
    await _seed_user(db_session)

    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={
            "name": "Test app",
            "description": "SDK client",
            "website_url": "https://example.com",
            "allowed_origins": ["https://example.com", "https://app.example.com"],
        },
        headers=_auth_header(OWNER_FID),
    )
    assert create_app.status_code == 201
    app_payload = create_app.json()
    app_id = app_payload["id"]
    assert app_payload["website_url"] == "https://example.com"
    assert app_payload["allowed_origins"] == [
        "https://example.com",
        "https://app.example.com",
    ]

    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    assert create_key.status_code == 201
    key_payload = create_key.json()
    assert key_payload["public_key"].startswith("jk_pub_live_")
    assert key_payload["secret_key"].startswith(f"jk_sec_live_{key_payload['key_id']}_")
    assert key_payload["reveal_token"]

    key_row = (
        await db_session.execute(
            select(DeveloperApiKey).where(
                DeveloperApiKey.key_id == key_payload["key_id"]
            )
        )
    ).scalar_one()
    assert key_row.secret_key_hash != key_payload["secret_key"]
    assert key_row.public_key_hash != key_payload["public_key"]
    assert key_row.encrypted_secret_once is not None

    reveal = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key_payload['key_id']}/reveal",
        json={"reveal_token": key_payload["reveal_token"]},
        headers=_auth_header(OWNER_FID),
    )
    assert reveal.status_code == 200
    assert reveal.json()["secret_key"] == key_payload["secret_key"]
    await db_session.refresh(key_row)
    assert key_row.encrypted_secret_once is None
    assert key_row.revealed_at is not None

    second_reveal = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key_payload['key_id']}/reveal",
        json={"reveal_token": key_payload["reveal_token"]},
        headers=_auth_header(OWNER_FID),
    )
    assert second_reveal.status_code == 410


@pytest.mark.asyncio
async def test_unapproved_developer_cannot_create_app(client_with_db, db_session):
    await _seed_user(db_session, developer_access_status="pending")

    response = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Blocked app"},
        headers=_auth_header(OWNER_FID),
    )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_suspended_owner_cannot_use_existing_api_key(client_with_db, db_session):
    user = await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]

    verified = await verify_developer_api_key(db_session, raw_secret_key=secret_key)
    assert verified.fid == OWNER_FID

    user.developer_access_status = "suspended"
    await db_session.commit()

    with pytest.raises(Exception) as exc_info:
        await verify_developer_api_key(db_session, raw_secret_key=secret_key)
    # All verify_developer_api_key failures collapse to 401 to avoid
    # leaking which check (user status, ownership, hash) tripped.
    assert getattr(exc_info.value, "status_code", None) == 401


@pytest.mark.asyncio
async def test_api_key_owner_is_derived_from_key_not_bearer(
    client_with_db, db_session
):
    """The key alone determines the owning fid; no bearer JWT is consulted."""
    await _seed_user(db_session)
    await _seed_user(db_session, fid=OTHER_FID)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]

    # The verified owner is derived from the key, irrespective of who
    # presents the secret. A mismatching JWT used to fail at the JWT-AND-key
    # check; now the JWT is simply not consulted.
    verified = await verify_developer_api_key(db_session, raw_secret_key=secret_key)
    assert verified.fid == OWNER_FID


@pytest.mark.asyncio
async def test_rotation_revokes_old_key_and_clears_first_reveal_secret(
    client_with_db, db_session
):
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    old_key_id = create_key.json()["key_id"]

    rotate = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{old_key_id}/rotate",
        json={"name": "Rotated"},
        headers=_auth_header(OWNER_FID),
    )
    assert rotate.status_code == 201
    assert rotate.json()["rotated_from_key_id"] == old_key_id

    old_key = (
        await db_session.execute(
            select(DeveloperApiKey).where(DeveloperApiKey.key_id == old_key_id)
        )
    ).scalar_one()
    assert old_key.revoked_at is not None
    assert old_key.encrypted_secret_once is None
    assert old_key.reveal_token_hash is None


@pytest.mark.asyncio
async def test_developer_application_is_persisted_and_admin_can_approve(
    client_with_db, db_session
):
    await _seed_user(db_session, developer_access_status="none")
    await _seed_user(db_session, fid=9999, is_admin=True)

    submit = await client_with_db.post(
        "/v1/developer/application",
        json={
            "project_name": "Launch app",
            "website_url": "https://launch.example",
            "use_case": "Embed Juke spaces in a launch page.",
        },
        headers=_auth_header(OWNER_FID),
    )
    assert submit.status_code == 200
    assert submit.json()["developer_access_status"] == "pending"
    assert submit.json()["application"]["project_name"] == "Launch app"

    application = (
        await db_session.execute(
            select(DeveloperApplication).where(DeveloperApplication.fid == OWNER_FID)
        )
    ).scalar_one()
    assert application.website_url == "https://launch.example"
    assert application.use_case == "Embed Juke spaces in a launch page."

    async def _admin_override():
        return 9999

    app.dependency_overrides[get_admin_user] = _admin_override
    approve = await client_with_db.post(
        f"/v1/developer/admin/access/{OWNER_FID}",
        json={"status": "approved"},
        headers=_auth_header(9999),
    )
    assert approve.status_code == 200
    assert approve.json()["developer_access_status"] == "approved"
    assert approve.json()["application"]["status"] == "approved"

    status_response = await client_with_db.get(
        "/v1/developer/status", headers=_auth_header(OWNER_FID)
    )
    assert status_response.status_code == 200
    assert status_response.json()["application"]["project_name"] == "Launch app"


@pytest.mark.asyncio
async def test_revoke_returns_updated_key_preserving_metadata(client_with_db, db_session):
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    key_id = create_key.json()["key_id"]

    revoke = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key_id}/revoke",
        headers=_auth_header(OWNER_FID),
    )
    assert revoke.status_code == 200
    revoked = revoke.json()
    assert revoked["key_id"] == key_id
    assert revoked["name"] == "Primary"
    assert revoked["revoked_at"] is not None
    assert revoked["secret_key"] is None
    assert revoked["reveal_token"] is None


class _FakeDeveloperRoomService:
    def __init__(self):
        self.calls = []

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
                id="00000000-0000-0000-0000-000000000123",
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
            livekit_ws_url="wss://livekit.example",
            expires_at=datetime.now(timezone.utc).isoformat(),
        )


@pytest.mark.asyncio
async def test_developer_spaces_works_with_key_only_no_jwt(
    client_with_db, db_session
):
    """/v1/developer/spaces is a machine endpoint. Key alone is sufficient."""
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]
    fake_service = _FakeDeveloperRoomService()

    async def _room_service_override():
        yield fake_service

    app.dependency_overrides[get_developer_room_service] = _room_service_override

    # No Authorization header at all — only X-Juke-Api-Key.
    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Key-only request"},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    assert response.json()["room"]["host_fid"] == OWNER_FID
    assert fake_service.calls[-1]["fid"] == OWNER_FID
    assert fake_service.calls[-1]["title"] == "Key-only request"

    # Missing the API key entirely still 401s, with the collapsed error string.
    missing_key = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "No key"},
        headers=_auth_header(OWNER_FID),
    )
    assert missing_key.status_code == 401
    assert missing_key.json()["detail"] == "Invalid Juke API key."


@pytest.mark.asyncio
async def test_developer_spaces_ignores_bearer_fid_mismatch_with_key(
    client_with_db, db_session
):
    """Sending a key for fid A and a JWT for fid B yields a room owned by A.

    The JWT is not consulted on /spaces; the owning fid comes from the key.
    """
    await _seed_user(db_session)
    await _seed_user(db_session, fid=OTHER_FID)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]
    fake_service = _FakeDeveloperRoomService()

    async def _room_service_override():
        yield fake_service

    app.dependency_overrides[get_developer_room_service] = _room_service_override

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Bearer/key mismatch"},
        # Bearer is OTHER_FID; key belongs to OWNER_FID. Room owner == OWNER_FID.
        headers={**_auth_header(OTHER_FID), "X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    assert response.json()["room"]["host_fid"] == OWNER_FID
    assert fake_service.calls[-1]["fid"] == OWNER_FID


@pytest.mark.asyncio
async def test_developer_spaces_rejects_host_fid_override(client_with_db, db_session):
    """The body cannot smuggle an alternate host_fid past the key auth."""
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]
    fake_service = _FakeDeveloperRoomService()

    async def _room_service_override():
        yield fake_service

    app.dependency_overrides[get_developer_room_service] = _room_service_override

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Smuggled owner", "host_fid": OTHER_FID},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 422
    assert fake_service.calls == []


@pytest.mark.asyncio
async def test_developer_spaces_rejects_suspended_owner(client_with_db, db_session):
    owner = await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]

    owner.developer_access_status = "suspended"
    await db_session.commit()
    suspended = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Suspended"},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert suspended.status_code == 401
    assert suspended.json()["detail"] == "Invalid Juke API key."


@pytest.mark.asyncio
async def test_allowed_origins_rejects_invalid_entries(client_with_db, db_session):
    """field_validator should normalize/reject malformed allowed_origins."""
    await _seed_user(db_session)

    bad_payloads = [
        ["*"],
        ["null"],
        ["ftp://example.com"],
        ["https://example.com/path"],
        ["https://example.com?x=1"],
        ["not-a-url"],
        ["https://"],
        # Cap at 20 entries
        [f"https://app-{i}.example.com" for i in range(21)],
    ]
    for payload in bad_payloads:
        response = await client_with_db.post(
            "/v1/developer/apps",
            json={"name": "X", "allowed_origins": payload},
            headers=_auth_header(OWNER_FID),
        )
        assert response.status_code == 422, payload


@pytest.mark.asyncio
async def test_allowed_origins_strips_whitespace_and_drops_empty(
    client_with_db, db_session
):
    await _seed_user(db_session)
    response = await client_with_db.post(
        "/v1/developer/apps",
        json={
            "name": "Trim test",
            "allowed_origins": [
                "  https://example.com  ",
                "",
                "https://app.example.com",
            ],
        },
        headers=_auth_header(OWNER_FID),
    )
    assert response.status_code == 201
    assert response.json()["allowed_origins"] == [
        "https://example.com",
        "https://app.example.com",
    ]


@pytest.mark.asyncio
async def test_origin_header_must_match_allowed_origins(client_with_db, db_session):
    """Browser-style requests (with Origin) are rejected if not in allow-list."""
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={
            "name": "Test app",
            "allowed_origins": ["https://allowed.example.com"],
        },
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]
    fake_service = _FakeDeveloperRoomService()

    async def _room_service_override():
        yield fake_service

    app.dependency_overrides[get_developer_room_service] = _room_service_override

    # Wrong Origin -> 401 (collapsed error string)
    wrong_origin = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={
            **_auth_header(OWNER_FID),
            "X-Juke-Api-Key": secret_key,
            "Origin": "https://evil.example.com",
        },
    )
    assert wrong_origin.status_code == 401
    assert fake_service.calls == []

    # Allowed Origin -> 201
    allowed = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={
            **_auth_header(OWNER_FID),
            "X-Juke-Api-Key": secret_key,
            "Origin": "https://allowed.example.com",
        },
    )
    assert allowed.status_code == 201

    # No Origin (server-to-server) -> 201
    no_origin = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={**_auth_header(OWNER_FID), "X-Juke-Api-Key": secret_key},
    )
    assert no_origin.status_code == 201


@pytest.mark.asyncio
async def test_resubmitting_application_does_not_auto_approve(
    client_with_db, db_session
):
    """Even an approved developer's resubmission must be marked pending."""
    await _seed_user(db_session, developer_access_status="approved")
    response = await client_with_db.post(
        "/v1/developer/application",
        json={
            "project_name": "Round 2",
            "website_url": "https://r2.example",
            "use_case": "Resubmitted application",
        },
        headers=_auth_header(OWNER_FID),
    )
    assert response.status_code == 200
    # User row's access status is preserved...
    assert response.json()["developer_access_status"] == "approved"
    # ...but the new application record is pending.
    assert response.json()["application"]["status"] == "pending"


@pytest.mark.asyncio
async def test_rotate_failure_leaves_old_key_intact(
    client_with_db, db_session, monkeypatch
):
    """If create_api_key raises during rotation, the old key stays active."""
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    old_key_id = create_key.json()["key_id"]

    # Force create_api_key to blow up partway through rotation.
    import app.routers.developer as developer_module

    async def _boom(*args, **kwargs):
        raise RuntimeError("simulated insert failure")

    monkeypatch.setattr(developer_module, "create_api_key", _boom)

    # ASGITransport re-raises uncaught app exceptions by default; either way
    # the contract is the same — the request did not produce a 2xx, and the
    # transaction should have rolled back.
    with pytest.raises(RuntimeError):
        await client_with_db.post(
            f"/v1/developer/apps/{app_id}/keys/{old_key_id}/rotate",
            json={"name": "Rotated"},
            headers=_auth_header(OWNER_FID),
        )

    # Old key must remain unrevoked because the transaction rolled back.
    old_key = (
        await db_session.execute(
            select(DeveloperApiKey).where(DeveloperApiKey.key_id == old_key_id)
        )
    ).scalar_one()
    assert old_key.revoked_at is None
    assert old_key.encrypted_secret_once is not None


# ---------------------------------------------------------------------------
# IDOR / cross-tenant authorization tests
#
# Two approved developers (A=OWNER_FID, B=OTHER_FID). Every developer-scoped
# route must hide the existence of A's resources from B by returning 404
# (not 403) so the response can't be used as an existence oracle.
# ---------------------------------------------------------------------------


APP_NOT_FOUND_DETAIL = "Developer app not found."


async def _seed_two_approved_developers(db_session):
    """Seed A and B as approved developers and return (a_fid, b_fid)."""
    await _seed_user(db_session, fid=OWNER_FID)
    await _seed_user(db_session, fid=OTHER_FID)
    return OWNER_FID, OTHER_FID


async def _create_app_as(client_with_db, fid: int, name: str = "A's app") -> str:
    resp = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": name},
        headers=_auth_header(fid),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _create_key_as(
    client_with_db, fid: int, app_id: str, name: str = "Primary"
) -> dict:
    resp = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": name},
        headers=_auth_header(fid),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_idor_get_app_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)

    response = await client_with_db.get(
        f"/v1/developer/apps/{app_id}",
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_idor_patch_app_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)

    response = await client_with_db.patch(
        f"/v1/developer/apps/{app_id}",
        json={"name": "Hijacked"},
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_idor_delete_app_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)

    response = await client_with_db.delete(
        f"/v1/developer/apps/{app_id}",
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL

    # Confirm the app was not soft-deleted by B's request.
    app_row = (
        await db_session.execute(
            select(DeveloperApp).where(DeveloperApp.id == uuid.UUID(app_id))
        )
    ).scalar_one()
    assert app_row.status == "active"


@pytest.mark.asyncio
async def test_idor_list_keys_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)

    response = await client_with_db.get(
        f"/v1/developer/apps/{app_id}/keys",
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_idor_create_key_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)

    response = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "x"},
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_idor_rotate_key_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)
    a_key = await _create_key_as(client_with_db, a_fid, app_id)

    response = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{a_key['key_id']}/rotate",
        json={"name": "Rotated by B"},
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL

    # A's key remains unrevoked.
    key_row = (
        await db_session.execute(
            select(DeveloperApiKey).where(DeveloperApiKey.key_id == a_key["key_id"])
        )
    ).scalar_one()
    assert key_row.revoked_at is None


@pytest.mark.asyncio
async def test_idor_revoke_key_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)
    a_key = await _create_key_as(client_with_db, a_fid, app_id)

    response = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{a_key['key_id']}/revoke",
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL

    # A's key must NOT be revoked by B's failed attempt.
    key_row = (
        await db_session.execute(
            select(DeveloperApiKey).where(DeveloperApiKey.key_id == a_key["key_id"])
        )
    ).scalar_one()
    assert key_row.revoked_at is None


@pytest.mark.asyncio
async def test_idor_reveal_key_other_developer_returns_404(client_with_db, db_session):
    a_fid, b_fid = await _seed_two_approved_developers(db_session)
    app_id = await _create_app_as(client_with_db, a_fid)
    a_key = await _create_key_as(client_with_db, a_fid, app_id)

    response = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{a_key['key_id']}/reveal",
        json={"reveal_token": a_key["reveal_token"]},
        headers=_auth_header(b_fid),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == APP_NOT_FOUND_DETAIL

    # The reveal token must still be usable by A (i.e., B's request didn't
    # silently burn it).
    owner_reveal = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{a_key['key_id']}/reveal",
        json={"reveal_token": a_key["reveal_token"]},
        headers=_auth_header(a_fid),
    )
    assert owner_reveal.status_code == 200
    assert owner_reveal.json()["secret_key"] == a_key["secret_key"]


# ---------------------------------------------------------------------------
# Key-lifecycle vs /spaces — verify revoked / rotated secrets cannot be used.
# ---------------------------------------------------------------------------


def _install_fake_room_service():
    fake_service = _FakeDeveloperRoomService()

    async def _override():
        yield fake_service

    app.dependency_overrides[get_developer_room_service] = _override
    return fake_service


@pytest.mark.asyncio
async def test_revoked_key_cannot_call_spaces_endpoint(client_with_db, db_session):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)
    key = await _create_key_as(client_with_db, OWNER_FID, app_id)
    secret_key = key["secret_key"]

    revoke = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/revoke",
        headers=_auth_header(OWNER_FID),
    )
    assert revoke.status_code == 200

    _install_fake_room_service()
    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "After revoke"},
        headers={**_auth_header(OWNER_FID), "X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid Juke API key."


@pytest.mark.asyncio
async def test_rotated_key_old_secret_cannot_call_spaces_endpoint(
    client_with_db, db_session
):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)
    old_key = await _create_key_as(client_with_db, OWNER_FID, app_id)
    old_secret = old_key["secret_key"]

    rotate = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{old_key['key_id']}/rotate",
        json={"name": "Rotated"},
        headers=_auth_header(OWNER_FID),
    )
    assert rotate.status_code == 201

    _install_fake_room_service()
    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Using old secret"},
        headers={**_auth_header(OWNER_FID), "X-Juke-Api-Key": old_secret},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid Juke API key."


# ---------------------------------------------------------------------------
# /reveal expiry semantics: returns 410 and clears the encrypted blob.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reveal_endpoint_410_after_expiry(client_with_db, db_session):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)
    key = await _create_key_as(client_with_db, OWNER_FID, app_id)

    # Backdate reveal_expires_at so the window has closed.
    key_row = (
        await db_session.execute(
            select(DeveloperApiKey).where(DeveloperApiKey.key_id == key["key_id"])
        )
    ).scalar_one()
    assert key_row.encrypted_secret_once is not None
    key_row.reveal_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    first = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/reveal",
        json={"reveal_token": key["reveal_token"]},
        headers=_auth_header(OWNER_FID),
    )
    assert first.status_code == 410
    assert first.json()["detail"] == "Secret is no longer revealable."

    # The encrypted blob must be cleared after the expiry sweep so a future
    # AES-key compromise can't decrypt it from a DB dump.
    await db_session.refresh(key_row)
    assert key_row.encrypted_secret_once is None
    assert key_row.reveal_token_hash is None

    second = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/reveal",
        json={"reveal_token": key["reveal_token"]},
        headers=_auth_header(OWNER_FID),
    )
    assert second.status_code == 410


# ---------------------------------------------------------------------------
# Rate-limit tests — install a stateful Redis pipeline fake so the limiter
# actually counts, and monkeypatch the configured limit down so the test
# loop stays short.
# ---------------------------------------------------------------------------


class _StatefulRatePipeline:
    """Minimal stand-in for a Redis pipeline used by check_rate_limit.

    Shares a single counter dict with siblings so successive pipeline()
    instances see the same key counts.
    """

    def __init__(self, store: dict):
        self._store = store
        self._key: str | None = None

    def incr(self, key):
        self._key = key
        return self

    def expire(self, key, ttl):
        return self

    async def execute(self):
        assert self._key is not None
        self._store[self._key] = self._store.get(self._key, 0) + 1
        return [self._store[self._key], True]


def _install_stateful_rate_limiter():
    """Swap conftest's no-op pipeline for one that actually increments."""
    store: dict[str, int] = {}
    pipeline_factory = MagicMock(side_effect=lambda: _StatefulRatePipeline(store))
    app.state.redis.pipeline = pipeline_factory
    # check_rate_limit reads TTL on overflow to populate Retry-After.
    app.state.redis.ttl = AsyncMock(return_value=60)
    return store


@pytest.mark.asyncio
async def test_rate_limit_create_key_returns_429(
    client_with_db, db_session, monkeypatch
):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)

    # Bring the limit down to keep the loop short; the prior subagent set
    # the production value to 20/hr.
    import app.routers.developer as developer_module

    monkeypatch.setattr(developer_module, "_MUTATION_RATE_LIMIT", 3)
    _install_stateful_rate_limiter()

    successes = 0
    saw_429 = False
    # Loop one beyond the limit; we expect exactly `limit` 201s and then 429.
    for i in range(developer_module._MUTATION_RATE_LIMIT + 1):
        resp = await client_with_db.post(
            f"/v1/developer/apps/{app_id}/keys",
            json={"name": f"key-{i}"},
            headers=_auth_header(OWNER_FID),
        )
        if resp.status_code == 201:
            successes += 1
            continue
        if resp.status_code == 429:
            saw_429 = True
            assert resp.json()["detail"] == "Rate limit exceeded. Try again later."
            assert "retry-after" in {h.lower() for h in resp.headers.keys()}
            break
        pytest.fail(f"unexpected status on attempt {i}: {resp.status_code} {resp.text}")

    assert saw_429, "expected a 429 once the limit was exceeded"
    assert successes == developer_module._MUTATION_RATE_LIMIT


@pytest.mark.asyncio
async def test_rate_limit_application_returns_429(
    client_with_db, db_session, monkeypatch
):
    await _seed_user(db_session, developer_access_status="none")

    import app.routers.developer as developer_module

    monkeypatch.setattr(developer_module, "_APPLICATION_RATE_LIMIT", 2)
    _install_stateful_rate_limiter()

    payload = {
        "project_name": "Round X",
        "website_url": "https://x.example",
        "use_case": "Stress test the rate limiter.",
    }
    saw_429 = False
    successes = 0
    for i in range(developer_module._APPLICATION_RATE_LIMIT + 1):
        resp = await client_with_db.post(
            "/v1/developer/application",
            json=payload,
            headers=_auth_header(OWNER_FID),
        )
        if resp.status_code == 200:
            successes += 1
            continue
        if resp.status_code == 429:
            saw_429 = True
            assert resp.json()["detail"] == "Rate limit exceeded. Try again later."
            break
        pytest.fail(f"unexpected status on attempt {i}: {resp.status_code} {resp.text}")

    assert saw_429
    assert successes == developer_module._APPLICATION_RATE_LIMIT


# ---------------------------------------------------------------------------
# Origin header enforcement on /spaces — explicit positive/negative cases.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_origin_header_blocks_unlisted_origin(client_with_db, db_session):
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "App", "allowed_origins": ["https://example.com"]},
        headers=_auth_header(OWNER_FID),
    )
    assert create_app.status_code == 201
    app_id = create_app.json()["id"]
    key = await _create_key_as(client_with_db, OWNER_FID, app_id)
    secret_key = key["secret_key"]

    _install_fake_room_service()

    # Unlisted Origin -> 401, collapsed error string.
    blocked = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={
            **_auth_header(OWNER_FID),
            "X-Juke-Api-Key": secret_key,
            "Origin": "https://attacker.example",
        },
    )
    assert blocked.status_code == 401
    assert blocked.json()["detail"] == "Invalid Juke API key."

    # Allowed Origin -> 201.
    allowed = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={
            **_auth_header(OWNER_FID),
            "X-Juke-Api-Key": secret_key,
            "Origin": "https://example.com",
        },
    )
    assert allowed.status_code == 201

    # No Origin (server-to-server) -> 201.
    no_origin = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={**_auth_header(OWNER_FID), "X-Juke-Api-Key": secret_key},
    )
    assert no_origin.status_code == 201


@pytest.mark.asyncio
async def test_origin_header_no_enforcement_when_allowed_origins_empty(
    client_with_db, db_session
):
    """With an empty allow-list, any Origin (or none) is accepted."""
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "App"},  # allowed_origins defaults to []
        headers=_auth_header(OWNER_FID),
    )
    assert create_app.status_code == 201
    assert create_app.json()["allowed_origins"] == []
    app_id = create_app.json()["id"]
    key = await _create_key_as(client_with_db, OWNER_FID, app_id)
    secret_key = key["secret_key"]

    _install_fake_room_service()

    # Arbitrary Origin -> 201.
    resp_with_origin = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={
            **_auth_header(OWNER_FID),
            "X-Juke-Api-Key": secret_key,
            "Origin": "https://anything.example.test",
        },
    )
    assert resp_with_origin.status_code == 201

    # No Origin -> 201.
    resp_no_origin = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Hello"},
        headers={**_auth_header(OWNER_FID), "X-Juke-Api-Key": secret_key},
    )
    assert resp_no_origin.status_code == 201


# ---------------------------------------------------------------------------
# Step-up (recent SIWN) on dangerous key-mutation routes:
#   - POST /apps/{id}/keys/{kid}/rotate
#   - POST /apps/{id}/keys/{kid}/revoke
#   - POST /apps/{id}/keys/{kid}/reveal
#   - DELETE /apps/{id}
#
# Each must return 401 "Recent sign-in required." + WWW-Authenticate: ReAuth
# when the SIWN marker is missing, and must proceed normally once the marker
# is (re-)set. List/get/create-app/create-key remain on the standard JWT
# dependency without step-up.
# ---------------------------------------------------------------------------


REAUTH_DETAIL = "Recent sign-in required."


def _seed_marker_and_clear(fid: int) -> None:
    """Ensure SIWN tracking is wired up, then clear it for this fid.

    `_auth_header` marks SIWN automatically; this helper is for tests that
    need to exercise the no-recent-SIWN failure path.
    """
    _mark_siwn_sync(fid)
    _clear_siwn(fid)


def _bearer_only(fid: int) -> dict:
    """Build a JWT-only header that does NOT mark SIWN.

    `_auth_header(fid)` records a fresh SIWN marker as a side effect (so the
    existing test suite passes on step-up routes); step-up tests need to
    explicitly clear the marker, so they must bypass that helper.
    """
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp()),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_rotate_requires_recent_siwn(client_with_db, db_session):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)
    key = await _create_key_as(client_with_db, OWNER_FID, app_id)

    bearer_only = _bearer_only(OWNER_FID)
    _seed_marker_and_clear(OWNER_FID)

    no_siwn = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/rotate",
        json={"name": "Rotated"},
        headers=bearer_only,
    )
    assert no_siwn.status_code == 401
    assert no_siwn.json()["detail"] == REAUTH_DETAIL
    assert no_siwn.headers.get("www-authenticate") == "ReAuth"

    # After (re-)marking SIWN, rotate succeeds.
    _mark_siwn_sync(OWNER_FID)
    success = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/rotate",
        json={"name": "Rotated"},
        headers=bearer_only,
    )
    assert success.status_code == 201, success.text


@pytest.mark.asyncio
async def test_revoke_requires_recent_siwn(client_with_db, db_session):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)
    key = await _create_key_as(client_with_db, OWNER_FID, app_id)
    bearer_only = _bearer_only(OWNER_FID)

    _seed_marker_and_clear(OWNER_FID)
    no_siwn = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/revoke",
        headers=bearer_only,
    )
    assert no_siwn.status_code == 401
    assert no_siwn.json()["detail"] == REAUTH_DETAIL
    assert no_siwn.headers.get("www-authenticate") == "ReAuth"

    _mark_siwn_sync(OWNER_FID)
    success = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/revoke",
        headers=bearer_only,
    )
    assert success.status_code == 200


@pytest.mark.asyncio
async def test_reveal_requires_recent_siwn(client_with_db, db_session):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)
    key = await _create_key_as(client_with_db, OWNER_FID, app_id)
    bearer_only = _bearer_only(OWNER_FID)

    _seed_marker_and_clear(OWNER_FID)
    no_siwn = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/reveal",
        json={"reveal_token": key["reveal_token"]},
        headers=bearer_only,
    )
    assert no_siwn.status_code == 401
    assert no_siwn.json()["detail"] == REAUTH_DETAIL
    assert no_siwn.headers.get("www-authenticate") == "ReAuth"

    _mark_siwn_sync(OWNER_FID)
    success = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys/{key['key_id']}/reveal",
        json={"reveal_token": key["reveal_token"]},
        headers=bearer_only,
    )
    assert success.status_code == 200
    assert success.json()["secret_key"] == key["secret_key"]


@pytest.mark.asyncio
async def test_delete_app_requires_recent_siwn(client_with_db, db_session):
    await _seed_user(db_session)
    app_id = await _create_app_as(client_with_db, OWNER_FID)
    bearer_only = _bearer_only(OWNER_FID)

    _seed_marker_and_clear(OWNER_FID)
    no_siwn = await client_with_db.delete(
        f"/v1/developer/apps/{app_id}",
        headers=bearer_only,
    )
    assert no_siwn.status_code == 401
    assert no_siwn.json()["detail"] == REAUTH_DETAIL
    assert no_siwn.headers.get("www-authenticate") == "ReAuth"

    # App was NOT soft-deleted while step-up failed.
    app_row = (
        await db_session.execute(
            select(DeveloperApp).where(DeveloperApp.id == uuid.UUID(app_id))
        )
    ).scalar_one()
    assert app_row.status == "active"

    _mark_siwn_sync(OWNER_FID)
    success = await client_with_db.delete(
        f"/v1/developer/apps/{app_id}",
        headers=bearer_only,
    )
    assert success.status_code == 200


@pytest.mark.asyncio
async def test_create_app_does_not_require_recent_siwn(client_with_db, db_session):
    """List/get/create-app/create-key are intentionally NOT step-up-protected."""
    await _seed_user(db_session)
    bearer_only = _bearer_only(OWNER_FID)

    _seed_marker_and_clear(OWNER_FID)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=bearer_only,
    )
    assert create_app.status_code == 201, create_app.text

    list_apps = await client_with_db.get(
        "/v1/developer/apps", headers=bearer_only
    )
    assert list_apps.status_code == 200


# ---------------------------------------------------------------------------
# Per-app embed policy (#148 follow-up): rooms created via /v1/developer/spaces
# carry their owning app's id so the embed iframe's CSP can be tightened to
# that app's allowed_origins.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_developer_spaces_passes_app_id_to_room_service(
    client_with_db, db_session
):
    """The verified key's app_id must flow into RoomService.create_room."""
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Test app"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = create_app.json()["id"]
    create_key = await client_with_db.post(
        f"/v1/developer/apps/{app_id}/keys",
        json={"name": "Primary"},
        headers=_auth_header(OWNER_FID),
    )
    secret_key = create_key.json()["secret_key"]

    fake_service = _FakeDeveloperRoomService()

    async def _room_service_override():
        yield fake_service

    app.dependency_overrides[get_developer_room_service] = _room_service_override

    response = await client_with_db.post(
        "/v1/developer/spaces",
        json={"title": "Tagged with app_id"},
        headers={"X-Juke-Api-Key": secret_key},
    )
    assert response.status_code == 201, response.text
    last = fake_service.calls[-1]
    assert str(last["created_by_app_id"]) == app_id


async def _seed_room_with_app(
    db_session, *, host_fid: int, app_id, room_id=None
) -> Room:
    """Insert an active room owned by host_fid and tagged with app_id."""
    room = Room(
        id=room_id or uuid.uuid4(),
        title="Test room",
        host_fid=host_fid,
        status="active",
        created_by_app_id=app_id,
    )
    db_session.add(room)
    await db_session.commit()
    await db_session.refresh(room)
    return room


@pytest.mark.asyncio
async def test_embed_policy_returns_app_allowed_origins(
    client_with_db, db_session
):
    """Rooms tagged with an app expose that app's allowed_origins."""
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={
            "name": "Test app",
            "allowed_origins": ["https://example.com", "https://app.example.com"],
        },
        headers=_auth_header(OWNER_FID),
    )
    app_id = uuid.UUID(create_app.json()["id"])
    room = await _seed_room_with_app(db_session, host_fid=OWNER_FID, app_id=app_id)

    res = await client_with_db.get(f"/v1/rooms/{room.id}/embed-policy")
    assert res.status_code == 200
    body = res.json()
    assert body["allowed_origins"] == [
        "https://example.com",
        "https://app.example.com",
    ]
    # Aggressive caching is safe: the room → app linkage is immutable.
    assert "max-age" in res.headers.get("cache-control", "")


@pytest.mark.asyncio
async def test_embed_policy_returns_null_for_unlinked_room(
    client_with_db, db_session
):
    """Rooms without an owning app fall back to the permissive default policy."""
    await _seed_user(db_session)
    room = await _seed_room_with_app(db_session, host_fid=OWNER_FID, app_id=None)
    res = await client_with_db.get(f"/v1/rooms/{room.id}/embed-policy")
    assert res.status_code == 200
    assert res.json()["allowed_origins"] is None


@pytest.mark.asyncio
async def test_embed_policy_blocks_inactive_app_with_empty_list(
    client_with_db, db_session
):
    """Soft-deleting the owning app must BLOCK embedding, not relax it.

    Previously this returned `null` (treated as permissive by the
    middleware), meaning a suspended developer's existing rooms became
    *more* permissive than the admin intended. The contract is now an
    empty list — the middleware reads `[]` as an explicit block.
    """
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "Doomed app", "allowed_origins": ["https://example.com"]},
        headers=_auth_header(OWNER_FID),
    )
    app_id = uuid.UUID(create_app.json()["id"])
    room = await _seed_room_with_app(db_session, host_fid=OWNER_FID, app_id=app_id)

    # Soft-delete the app via the API.
    delete_res = await client_with_db.delete(
        f"/v1/developer/apps/{app_id}",
        headers=_auth_header(OWNER_FID),
    )
    assert delete_res.status_code == 200

    res = await client_with_db.get(f"/v1/rooms/{room.id}/embed-policy")
    assert res.status_code == 200
    assert res.json()["allowed_origins"] == []


@pytest.mark.asyncio
async def test_embed_policy_returns_null_for_unknown_room(client_with_db):
    """Unknown UUIDs return null rather than 404 — avoids a room-existence oracle."""
    random_id = uuid.uuid4()
    res = await client_with_db.get(f"/v1/rooms/{random_id}/embed-policy")
    assert res.status_code == 200
    assert res.json()["allowed_origins"] is None


@pytest.mark.asyncio
async def test_embed_policy_returns_404_for_malformed_id(client_with_db):
    """Non-UUID room id is rejected at the route layer."""
    res = await client_with_db.get("/v1/rooms/not-a-uuid/embed-policy")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_embed_policy_returns_empty_list_for_app_without_origins(
    client_with_db, db_session
):
    """An app with no `allowed_origins` yields `[]`, distinct from `null`.

    `[]` means \"the app is owned but the developer hasn't configured a
    list yet\"; `null` means \"no owning app at all\". The middleware
    treats both as permissive but the distinction is preserved for any
    future tooling that wants to surface it.
    """
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={"name": "App without origins"},
        headers=_auth_header(OWNER_FID),
    )
    app_id = uuid.UUID(create_app.json()["id"])
    room = await _seed_room_with_app(db_session, host_fid=OWNER_FID, app_id=app_id)

    res = await client_with_db.get(f"/v1/rooms/{room.id}/embed-policy")
    assert res.status_code == 200
    assert res.json()["allowed_origins"] == []


# ---------------------------------------------------------------------------
# Stream A: embed-policy cache headers — TTL was reduced from the original
# aggressive value so suspension / origin changes propagate to the edge
# in well under 2 minutes worst-case. Pin the exact Cache-Control value so
# we get a regression alarm if someone bumps it back up by accident.
# ---------------------------------------------------------------------------


EMBED_POLICY_CACHE_CONTROL = (
    "public, max-age=30, s-maxage=60, stale-while-revalidate=120"
)


@pytest.mark.asyncio
async def test_embed_policy_cache_headers_reflect_reduced_ttl(
    client_with_db, db_session
):
    """All three embed-policy branches emit the reduced Cache-Control header.

    The cache TTL was deliberately tightened to ~2 min worst-case so that
    revoked/suspended apps (which return `[]`) stop being embeddable at the
    edge in a timely manner. Pin the exact header value across:
      - normal app-linked room (allowed_origins=[...])
      - app present but no origins configured (allowed_origins=[])
      - room with no owning app (allowed_origins=null)
    """
    await _seed_user(db_session)
    create_app = await client_with_db.post(
        "/v1/developer/apps",
        json={
            "name": "Cache header app",
            "allowed_origins": ["https://example.com"],
        },
        headers=_auth_header(OWNER_FID),
    )
    app_id = uuid.UUID(create_app.json()["id"])

    # Linked room with origins.
    room_with_origins = await _seed_room_with_app(
        db_session, host_fid=OWNER_FID, app_id=app_id
    )
    res = await client_with_db.get(
        f"/v1/rooms/{room_with_origins.id}/embed-policy"
    )
    assert res.status_code == 200
    assert res.headers.get("cache-control") == EMBED_POLICY_CACHE_CONTROL

    # Unlinked room → null branch.
    room_no_app = await _seed_room_with_app(
        db_session, host_fid=OWNER_FID, app_id=None
    )
    res = await client_with_db.get(f"/v1/rooms/{room_no_app.id}/embed-policy")
    assert res.status_code == 200
    assert res.json()["allowed_origins"] is None
    assert res.headers.get("cache-control") == EMBED_POLICY_CACHE_CONTROL
