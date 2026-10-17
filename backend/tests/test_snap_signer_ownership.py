"""M11: snap signer ownership is the Postgres row, never overwritten on claim."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.clients.hypersnap import HypersnapError
from app.config import settings
from app.database import Base
from app.dependencies import get_db
from app.main import app
from app.models.snap_signer import SnapSigner
from app.services import snap_signer_service
from app.services.snap_signer_service import (
    SnapSignerOwnershipConflict,
    upsert_signer_from_registration,
)

PUBLIC_KEY = "0x" + "cd" * 32
OWNER_FID = 4242
ATTACKER_FID = 9999
ACTIVE_CHECK = "app.services.signer_registry.is_ed25519_signer_active"


@pytest.fixture
async def db_session():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=[SnapSigner.__table__])
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _seed(db_session, fid: int, status: str) -> None:
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


async def _row(db_session) -> SnapSigner:
    db_session.expire_all()
    return await db_session.scalar(
        select(SnapSigner).where(SnapSigner.public_key == PUBLIC_KEY)
    )


async def _register(db_session, fid: int) -> SnapSigner:
    return await upsert_signer_from_registration(
        db=db_session,
        public_key=PUBLIC_KEY,
        fid=fid,
        status="pending_approval",
        approval_url=None,
    )


# --- service ---------------------------------------------------------------


async def test_first_registration_records_caller_as_owner(db_session):
    row = await _register(db_session, OWNER_FID)
    assert (row.fid, row.status) == (OWNER_FID, "pending_approval")


async def test_claim_of_another_fids_key_is_refused_without_onchain_proof(
    db_session,
):
    await _seed(db_session, OWNER_FID, "approved")
    with patch(ACTIVE_CHECK, AsyncMock(return_value=False)) as active:
        with pytest.raises(SnapSignerOwnershipConflict):
            await _register(db_session, ATTACKER_FID)
    active.assert_awaited_once_with(ATTACKER_FID, PUBLIC_KEY)
    await db_session.rollback()
    row = await _row(db_session)
    assert (row.fid, row.status) == (OWNER_FID, "approved")


async def test_key_moves_only_when_onchain_for_the_caller(db_session):
    # E.g. a squatter recorded the key first; the real owner then adds it
    # on-chain and re-registers.
    await _seed(db_session, ATTACKER_FID, "pending_approval")
    with patch(ACTIVE_CHECK, AsyncMock(return_value=True)):
        row = await _register(db_session, OWNER_FID)
    assert (row.fid, row.status) == (OWNER_FID, "approved")


async def test_same_fid_reregistration_keeps_terminal_status(db_session):
    await _seed(db_session, OWNER_FID, "revoked")
    with patch(ACTIVE_CHECK, AsyncMock()) as active:
        row = await _register(db_session, OWNER_FID)
    active.assert_not_awaited()
    assert (row.fid, row.status) == (OWNER_FID, "revoked")


async def test_concurrent_first_insert_falls_back_to_ownership_check(db_session):
    """An IntegrityError from a racing insert re-runs the flow once."""
    calls = {"n": 0}
    real = snap_signer_service._upsert_signer

    async def racing(db, public_key, fid, status, approval_url):
        calls["n"] += 1
        if calls["n"] == 1:
            # Simulate the other request winning the insert.
            await _seed(db, OWNER_FID, "pending_approval")
            from sqlalchemy.exc import IntegrityError

            raise IntegrityError("insert", {}, Exception("duplicate key"))
        return await real(db, public_key, fid, status, approval_url)

    with patch.object(snap_signer_service, "_upsert_signer", racing):
        with patch(ACTIVE_CHECK, AsyncMock(return_value=False)):
            with pytest.raises(SnapSignerOwnershipConflict):
                await _register(db_session, ATTACKER_FID)
    assert calls["n"] == 2


# --- router ----------------------------------------------------------------


def _auth(fid: int) -> dict:
    token = jwt.encode(
        {"fid": fid, "exp": int(datetime.now(timezone.utc).timestamp()) + 3600},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def client(db_session):
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    pipe = AsyncMock()
    pipe.__aenter__ = AsyncMock(return_value=pipe)
    pipe.__aexit__ = AsyncMock(return_value=False)
    pipe.incr = MagicMock(return_value=pipe)
    pipe.expire = MagicMock(return_value=pipe)
    pipe.execute = AsyncMock(return_value=[1, True])
    redis = AsyncMock()
    redis.pipeline = MagicMock(return_value=pipe)
    # Legacy Redis ownership claims must be irrelevant to authorization.
    redis.get = AsyncMock(return_value=str(ATTACKER_FID).encode())
    app.state.redis = redis
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac
    app.dependency_overrides.pop(get_db, None)


async def test_register_route_returns_409_and_keeps_victim_row(client, db_session):
    await _seed(db_session, OWNER_FID, "approved")
    with patch(ACTIVE_CHECK, AsyncMock(return_value=False)):
        response = await client.post(
            "/v1/snaps/register-signer",
            json={"public_key": PUBLIC_KEY},
            headers=_auth(ATTACKER_FID),
        )
    assert response.status_code == 409
    row = await _row(db_session)
    assert (row.fid, row.status) == (OWNER_FID, "approved")


async def test_register_route_maps_hypersnap_failure_to_502(client, db_session):
    await _seed(db_session, OWNER_FID, "approved")
    with patch(
        ACTIVE_CHECK,
        AsyncMock(side_effect=HypersnapError("down", path="/v1/signersByFid")),
    ):
        response = await client.post(
            "/v1/snaps/register-signer",
            json={"public_key": PUBLIC_KEY},
            headers=_auth(ATTACKER_FID),
        )
    assert response.status_code == 502
    assert (await _row(db_session)).fid == OWNER_FID


async def test_register_route_creates_row_for_new_key(client, db_session):
    response = await client.post(
        "/v1/snaps/register-signer",
        json={"public_key": PUBLIC_KEY},
        headers=_auth(OWNER_FID),
    )
    assert response.status_code == 200
    assert response.json()["status"] == "pending_approval"
    assert (await _row(db_session)).fid == OWNER_FID


async def test_register_route_surfaces_db_failure(client):
    with patch(
        "app.routers.snaps.upsert_signer_from_registration",
        AsyncMock(side_effect=RuntimeError("db down")),
    ):
        with pytest.raises(RuntimeError):
            await client.post(
                "/v1/snaps/register-signer",
                json={"public_key": PUBLIC_KEY},
                headers=_auth(OWNER_FID),
            )


async def test_status_route_403_without_row_even_with_redis_claim(client):
    response = await client.get(
        "/v1/snaps/signer-status",
        params={"public_key": PUBLIC_KEY},
        headers=_auth(ATTACKER_FID),
    )
    assert response.status_code == 403


async def test_invalidate_by_non_owner_leaves_row_untouched(client, db_session):
    await _seed(db_session, OWNER_FID, "approved")
    response = await client.post(
        "/v1/snaps/signer-invalidate",
        json={"public_key": PUBLIC_KEY},
        headers=_auth(ATTACKER_FID),
    )
    assert response.status_code == 403
    assert (await _row(db_session)).status == "approved"
