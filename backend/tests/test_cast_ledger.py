"""Fail-soft and wiring tests for the "casted via Juke" cast ledger."""

import pytest
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.dependencies import get_db
from app.main import app
from app.models.cast_record import CastRecord
from app.models.user import User
from app.services.cast_ledger import record_cast
from tests.hypersnap_write_fakes import install_write_fakes

pytest.importorskip("aiosqlite")

FID = 12345
SIGNER = "12345678-1234-4234-9234-123456789abc"
CAST_HASH = "0x" + "a" * 40


def auth_header(fid: int = FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800, "source": "first_party"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _make_engine():
    return create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


@pytest.fixture
async def ledger_db():
    engine = _make_engine()
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[User.__table__, CastRecord.__table__],
        )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(User(id=1, fid=FID, signer_uuid=SIGNER))
        await db.commit()
        yield db
    await engine.dispose()


@pytest.fixture
async def ledger_client(client, ledger_db):
    async def override_db():
        yield ledger_db

    app.dependency_overrides[get_db] = override_db
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_record_cast_persists_row(ledger_db):
    await record_cast(ledger_db, fid=FID, cast_hash=CAST_HASH, source="composer")

    rows = (await ledger_db.execute(select(CastRecord))).scalars().all()
    assert len(rows) == 1
    assert rows[0].fid == FID
    assert rows[0].cast_hash == CAST_HASH
    assert rows[0].source == "composer"
    assert rows[0].created_at is not None


@pytest.mark.asyncio
async def test_record_cast_ignores_duplicate_hash(ledger_db):
    await record_cast(ledger_db, fid=FID, cast_hash=CAST_HASH, source="composer")
    # Same hash from another surface must not raise; the first row wins.
    await record_cast(ledger_db, fid=FID, cast_hash=CAST_HASH, source="voice_note")

    rows = (await ledger_db.execute(select(CastRecord))).scalars().all()
    assert len(rows) == 1
    assert rows[0].source == "composer"


@pytest.mark.asyncio
async def test_record_cast_skips_missing_hash(ledger_db):
    await record_cast(ledger_db, fid=FID, cast_hash="", source="composer")

    rows = (await ledger_db.execute(select(CastRecord))).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_record_cast_swallows_db_errors():
    engine = _make_engine()
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        # cast_records was never created, so the insert fails at commit —
        # record_cast must swallow the error and leave the session usable.
        await record_cast(db, fid=FID, cast_hash=CAST_HASH, source="composer")
        assert (await db.execute(select(1))).scalar_one() == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_create_cast_records_composer_ledger_row(
    ledger_client, ledger_db, monkeypatch
):
    fakes = install_write_fakes(monkeypatch)
    response = await ledger_client.post(
        "/v1/feed/cast",
        json={"text": "gm"},
        headers=auth_header(),
    )

    assert response.status_code == 200
    # The ledger records the protocol message hash.
    cast_hash = fakes.node.hashes[0]
    assert response.json()["cast"]["hash"] == cast_hash
    rows = (await ledger_db.execute(select(CastRecord))).scalars().all()
    assert len(rows) == 1
    assert rows[0].fid == FID
    assert rows[0].cast_hash == cast_hash
    assert rows[0].source == "composer"
