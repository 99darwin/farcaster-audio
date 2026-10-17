"""Tests for the local DB-backed snap signer status cache.

These tests pin down the contract that:
- `revoked` is truly terminal — never triggers a Hypersnap call.
- `approved` is reconciled at most once per 24h — fresh rows skip Hypersnap,
  stale rows refresh (catches on-chain revocations that bypass our flow).
- `pending_approval` triggers at most one Hypersnap call per 30s window.
- A first-time request (no row) triggers exactly one Hypersnap call and persists.
- Invalidate marks the row revoked and subsequent reads stay local.
- The router authorization boundary still rejects callers who don't own
  the public key.
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
from app.models.snap_signer import SnapSigner
from app.services import snap_signer_service

# 0x + 64 hex chars
PUBLIC_KEY = "0x" + "ab" * 32
OWNER_FID = 4242
OTHER_FID = 9999


@pytest.fixture
async def db_session():
    """In-memory SQLite session with the snap_signers table created."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[SnapSigner.__table__],
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
    """Missing row → exactly one Hypersnap call → row persisted."""
    with patch(
        "app.services.snap_signer_service.check_ed25519_signer_status",
        new_callable=AsyncMock,
        return_value={
            "public_key": PUBLIC_KEY,
            "status": "pending_approval",
            "fid": OWNER_FID,
            "signer_approval_url": "https://warpcast.example/approve",
        },
    ) as mock_check:
        result = await snap_signer_service.get_signer_status_cached(
            db_session, PUBLIC_KEY
        )

    assert mock_check.await_count == 1
    assert result["status"] == "pending_approval"
    assert result["fid"] == OWNER_FID

    row = await db_session.get(SnapSigner, PUBLIC_KEY)
    assert row is not None
    assert row.status == "pending_approval"
    assert row.fid == OWNER_FID


@pytest.mark.asyncio
async def test_fresh_approved_row_skips_neynar(db_session):
    """A FRESH `approved` row (within the 24h window) must NOT call Hypersnap."""
    now = datetime.now(timezone.utc)
    db_session.add(
        SnapSigner(
            public_key=PUBLIC_KEY,
            fid=OWNER_FID,
            status="approved",
            registered_at=now,
            last_checked_at=now,
            approved_at=now,
        )
    )
    await db_session.commit()

    with patch(
        "app.services.snap_signer_service.check_ed25519_signer_status",
        new_callable=AsyncMock,
    ) as mock_check:
        result = await snap_signer_service.get_signer_status_cached(
            db_session, PUBLIC_KEY
        )

    mock_check.assert_not_called()
    assert result["status"] == "approved"
    assert result["fid"] == OWNER_FID


@pytest.mark.asyncio
async def test_stale_approved_row_reconciles_with_hypersnap(db_session):
    """A STALE `approved` row (>24h old) re-checks Hypersnap so on-chain
    revocations that bypass our invalidate flow eventually surface."""
    now = datetime.now(timezone.utc)
    db_session.add(
        SnapSigner(
            public_key=PUBLIC_KEY,
            fid=OWNER_FID,
            status="approved",
            registered_at=now - timedelta(days=2),
            last_checked_at=now - timedelta(hours=25),
            approved_at=now - timedelta(days=2),
        )
    )
    await db_session.commit()

    with patch(
        "app.services.snap_signer_service.check_ed25519_signer_status",
        new_callable=AsyncMock,
        return_value={
            "public_key": PUBLIC_KEY,
            "status": "pending_approval",
            "fid": OWNER_FID,
        },
    ) as mock_check:
        result = await snap_signer_service.get_signer_status_cached(
            db_session, PUBLIC_KEY
        )

    assert mock_check.await_count == 1
    # An approved key no longer listed on-chain was removed: terminal
    # revoked, surfaced to the caller and persisted to the row.
    assert result["status"] == "revoked"
    row = await db_session.get(SnapSigner, PUBLIC_KEY)
    assert row.status == "revoked"


@pytest.mark.asyncio
async def test_pending_throttles_to_one_call_per_window(db_session):
    """Pending status only re-checks once per 30s window."""
    now = datetime.now(timezone.utc)
    db_session.add(
        SnapSigner(
            public_key=PUBLIC_KEY,
            fid=OWNER_FID,
            status="pending_approval",
            registered_at=now,
            # Stale by exactly the recheck interval to force a refresh on
            # the first call.
            last_checked_at=now - timedelta(seconds=120),
        )
    )
    await db_session.commit()

    with patch(
        "app.services.snap_signer_service.check_ed25519_signer_status",
        new_callable=AsyncMock,
        return_value={
            "public_key": PUBLIC_KEY,
            "status": "pending_approval",
            "fid": OWNER_FID,
        },
    ) as mock_check:
        # First call: stale → refreshes (1 Hypersnap call).
        await snap_signer_service.get_signer_status_cached(db_session, PUBLIC_KEY)
        # Second call within the 30s window: must hit DB only.
        await snap_signer_service.get_signer_status_cached(db_session, PUBLIC_KEY)
        # Third call still within the window.
        await snap_signer_service.get_signer_status_cached(db_session, PUBLIC_KEY)

    assert mock_check.await_count == 1


@pytest.mark.asyncio
async def test_mark_revoked_then_read_skips_neynar(db_session):
    """`mark_signer_revoked` must make subsequent reads terminal."""
    now = datetime.now(timezone.utc)
    db_session.add(
        SnapSigner(
            public_key=PUBLIC_KEY,
            fid=OWNER_FID,
            status="approved",
            registered_at=now,
            last_checked_at=now,
            approved_at=now,
        )
    )
    await db_session.commit()

    await snap_signer_service.mark_signer_revoked(db_session, PUBLIC_KEY)

    with patch(
        "app.services.snap_signer_service.check_ed25519_signer_status",
        new_callable=AsyncMock,
    ) as mock_check:
        result = await snap_signer_service.get_signer_status_cached(
            db_session, PUBLIC_KEY
        )

    mock_check.assert_not_called()
    assert result["status"] == "revoked"


# ---------------------------------------------------------------------------
# Router-level tests (with DB dep override + Redis mock from conftest)
# ---------------------------------------------------------------------------


def _auth_header(fid: int) -> dict:
    from datetime import timedelta as _td
    from jose import jwt
    from app.config import settings

    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + _td(hours=24)).timestamp()),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


async def _seed_row(db_session, fid: int, status: str = "pending_approval"):
    now = datetime.now(timezone.utc)
    db_session.add(
        SnapSigner(
            public_key=PUBLIC_KEY,
            fid=fid,
            status=status,
            registered_at=now,
            last_checked_at=now,
            approved_at=now if status == "approved" else None,
        )
    )
    await db_session.commit()


@pytest.fixture
async def client_with_db(db_session):
    """`client` fixture variant that wires get_db to the in-memory session."""
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
async def test_signer_status_returns_403_for_non_owner(client_with_db, db_session):
    """Caller fid != stored owner returns 403 from /signer-status."""
    ac, mock_redis = client_with_db
    await _seed_row(db_session, OWNER_FID)
    # A stale Redis claim naming the caller must not grant access.
    mock_redis.get = AsyncMock(return_value=str(OTHER_FID).encode())

    response = await ac.get(
        "/v1/snaps/signer-status",
        params={"public_key": PUBLIC_KEY},
        headers=_auth_header(OTHER_FID),
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_signer_invalidate_marks_revoked_and_blocks_non_owner(
    client_with_db, db_session
):
    """Happy path + 403 boundary for the invalidate endpoint."""
    ac, mock_redis = client_with_db

    # Seed an approved row.
    now = datetime.now(timezone.utc)
    db_session.add(
        SnapSigner(
            public_key=PUBLIC_KEY,
            fid=OWNER_FID,
            status="approved",
            registered_at=now,
            last_checked_at=now,
            approved_at=now,
        )
    )
    await db_session.commit()

    # Non-owner first: the row belongs to OWNER_FID; caller is OTHER_FID.
    # A Redis value naming the caller is ignored (ownership is the DB row).
    mock_redis.get = AsyncMock(return_value=str(OTHER_FID).encode())
    # Pipeline mock for the rate-limit incr.
    pipe = AsyncMock()
    pipe.__aenter__ = AsyncMock(return_value=pipe)
    pipe.__aexit__ = AsyncMock(return_value=False)
    pipe.incr = MagicMock(return_value=pipe)
    pipe.expire = MagicMock(return_value=pipe)
    pipe.execute = AsyncMock(return_value=[1, True])
    mock_redis.pipeline = MagicMock(return_value=pipe)

    bad = await ac.post(
        "/v1/snaps/signer-invalidate",
        json={"public_key": PUBLIC_KEY},
        headers=_auth_header(OTHER_FID),
    )
    assert bad.status_code == 403

    # Owner: should succeed.
    good = await ac.post(
        "/v1/snaps/signer-invalidate",
        json={"public_key": PUBLIC_KEY},
        headers=_auth_header(OWNER_FID),
    )
    assert good.status_code == 204

    # Subsequent read returns revoked WITHOUT a Hypersnap call.
    with patch(
        "app.services.snap_signer_service.check_ed25519_signer_status",
        new_callable=AsyncMock,
    ) as mock_check:
        result = await snap_signer_service.get_signer_status_cached(
            db_session, PUBLIC_KEY
        )
    mock_check.assert_not_called()
    assert result["status"] == "revoked"
