"""Tests for the local DB-backed auth address status cache.

Mirrors `test_snap_signer_cache.py`.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# In-memory SQLite is used to exercise the cache against a real session.
pytest.importorskip("aiosqlite")

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.dependencies import get_db
from app.main import app
from app.models.auth_address import AuthAddress
from app.services import auth_address_service

ADDRESS = "0x" + "ab" * 20
OWNER_FID = 4242
OTHER_FID = 9999


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
            tables=[AuthAddress.__table__],
        )
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session
    await engine.dispose()


# ---------------------------------------------------------------------------
# Service-layer tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_first_time_call_persists_row(db_session):
    with patch(
        "app.services.auth_address_service.check_auth_address_status",
        new_callable=AsyncMock,
        return_value={
            "address": ADDRESS,
            "status": "pending_approval",
            "fid": OWNER_FID,
            "auth_address_approval_url": "https://warpcast.example/approve",
        },
    ) as mock_check:
        result = await auth_address_service.get_auth_address_status_cached(
            db_session, ADDRESS
        )

    assert mock_check.await_count == 1
    assert result["status"] == "pending_approval"
    assert result["fid"] == OWNER_FID

    row = await db_session.get(AuthAddress, ADDRESS)
    assert row is not None
    assert row.status == "pending_approval"


@pytest.mark.asyncio
async def test_approved_row_skips_neynar(db_session):
    now = datetime.now(timezone.utc)
    db_session.add(
        AuthAddress(
            address=ADDRESS,
            fid=OWNER_FID,
            status="approved",
            registered_at=now,
            last_checked_at=now,
            approved_at=now,
        )
    )
    await db_session.commit()

    with patch(
        "app.services.auth_address_service.check_auth_address_status",
        new_callable=AsyncMock,
    ) as mock_check:
        result = await auth_address_service.get_auth_address_status_cached(
            db_session, ADDRESS
        )

    mock_check.assert_not_called()
    assert result["status"] == "approved"


@pytest.mark.asyncio
async def test_pending_throttles_to_one_call_per_window(db_session):
    now = datetime.now(timezone.utc)
    db_session.add(
        AuthAddress(
            address=ADDRESS,
            fid=OWNER_FID,
            status="pending_approval",
            registered_at=now,
            last_checked_at=now - timedelta(seconds=120),
        )
    )
    await db_session.commit()

    with patch(
        "app.services.auth_address_service.check_auth_address_status",
        new_callable=AsyncMock,
        return_value={
            "address": ADDRESS,
            "status": "pending_approval",
            "fid": OWNER_FID,
        },
    ) as mock_check:
        await auth_address_service.get_auth_address_status_cached(db_session, ADDRESS)
        await auth_address_service.get_auth_address_status_cached(db_session, ADDRESS)
        await auth_address_service.get_auth_address_status_cached(db_session, ADDRESS)

    assert mock_check.await_count == 1


@pytest.mark.asyncio
async def test_mark_revoked_then_read_skips_neynar(db_session):
    now = datetime.now(timezone.utc)
    db_session.add(
        AuthAddress(
            address=ADDRESS,
            fid=OWNER_FID,
            status="approved",
            registered_at=now,
            last_checked_at=now,
            approved_at=now,
        )
    )
    await db_session.commit()

    await auth_address_service.mark_auth_address_revoked(db_session, ADDRESS)

    with patch(
        "app.services.auth_address_service.check_auth_address_status",
        new_callable=AsyncMock,
    ) as mock_check:
        result = await auth_address_service.get_auth_address_status_cached(
            db_session, ADDRESS
        )

    mock_check.assert_not_called()
    assert result["status"] == "revoked"


# ---------------------------------------------------------------------------
# Router-level tests
# ---------------------------------------------------------------------------


def _auth_header(fid: int) -> dict:
    from jose import jwt

    from app.config import settings

    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp()),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def client_with_db(db_session):
    from httpx import ASGITransport, AsyncClient

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.set = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=1)
    mock_redis.expire = AsyncMock()
    mock_redis.delete = AsyncMock()
    mock_redis.pipeline = MagicMock(return_value=AsyncMock())
    app.state.redis = mock_redis

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, mock_redis

    app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_auth_address_status_returns_403_for_non_owner(client_with_db):
    ac, mock_redis = client_with_db
    mock_redis.get = AsyncMock(return_value=str(OWNER_FID).encode())

    response = await ac.get(
        "/v1/auth/auth-address/status",
        params={"address": ADDRESS},
        headers=_auth_header(OTHER_FID),
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_auth_address_invalidate_marks_revoked(client_with_db, db_session):
    ac, mock_redis = client_with_db

    now = datetime.now(timezone.utc)
    db_session.add(
        AuthAddress(
            address=ADDRESS,
            fid=OWNER_FID,
            status="approved",
            registered_at=now,
            last_checked_at=now,
            approved_at=now,
        )
    )
    await db_session.commit()

    mock_redis.get = AsyncMock(return_value=str(OWNER_FID).encode())
    mock_redis.incr = AsyncMock(return_value=1)
    mock_redis.expire = AsyncMock()

    bad = await ac.post(
        "/v1/auth/auth-address/invalidate",
        json={"auth_address": ADDRESS},
        headers=_auth_header(OTHER_FID),
    )
    assert bad.status_code == 403

    good = await ac.post(
        "/v1/auth/auth-address/invalidate",
        json={"auth_address": ADDRESS},
        headers=_auth_header(OWNER_FID),
    )
    assert good.status_code == 204

    with patch(
        "app.services.auth_address_service.check_auth_address_status",
        new_callable=AsyncMock,
    ) as mock_check:
        result = await auth_address_service.get_auth_address_status_cached(
            db_session, ADDRESS
        )
    mock_check.assert_not_called()
    assert result["status"] == "revoked"
