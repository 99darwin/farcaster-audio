"""L12: an Expo push token belongs to exactly one fid (latest wins)."""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.device_token import DeviceToken
from app.services.push_service import REDIS_ACTIVE_FIDS_KEY, PushService

TOKEN = "ExponentPushToken[device-a]"
VICTIM_FID = 100
ATTACKER_FID = 200


@pytest.fixture
async def db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=[DeviceToken.__table__])
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _service(db) -> PushService:
    service = PushService(db=db, redis=AsyncMock())
    service._sync_webhook_fids = AsyncMock()  # type: ignore[method-assign]
    return service


async def _rows(db) -> list[tuple[int, str, bool]]:
    result = await db.execute(
        select(DeviceToken.fid, DeviceToken.expo_push_token, DeviceToken.is_active)
    )
    return sorted(result.all())


async def test_token_is_globally_unique_and_latest_registration_wins(db):
    service = _service(db)
    await service.register_token(VICTIM_FID, TOKEN)
    await service.register_token(ATTACKER_FID, TOKEN)

    # One row, now owned by the latest registrant: the device can never be
    # bound to two fids at once.
    assert await _rows(db) == [(ATTACKER_FID, TOKEN, True)]
    # The previous owner had no other device, so it leaves the active set.
    service.redis.srem.assert_awaited_with(REDIS_ACTIVE_FIDS_KEY, str(VICTIM_FID))


async def test_reassignment_keeps_previous_owner_active_with_other_devices(db):
    service = _service(db)
    await service.register_token(VICTIM_FID, TOKEN)
    await service.register_token(VICTIM_FID, "ExponentPushToken[device-b]")
    await service.register_token(ATTACKER_FID, TOKEN)

    assert await _rows(db) == [
        (VICTIM_FID, "ExponentPushToken[device-b]", True),
        (ATTACKER_FID, TOKEN, True),
    ]
    service.redis.srem.assert_not_awaited()


async def test_reregistering_own_token_is_idempotent(db):
    service = _service(db)
    await service.register_token(VICTIM_FID, TOKEN, device_id="d1")
    await service.unregister_token(VICTIM_FID, TOKEN)
    await service.register_token(VICTIM_FID, TOKEN, device_id="d2")

    assert await _rows(db) == [(VICTIM_FID, TOKEN, True)]
    device_id = await db.scalar(select(DeviceToken.device_id))
    assert device_id == "d2"


async def test_unregister_cannot_touch_another_fids_token(db):
    service = _service(db)
    await service.register_token(VICTIM_FID, TOKEN)
    await service.unregister_token(ATTACKER_FID, TOKEN)
    assert await _rows(db) == [(VICTIM_FID, TOKEN, True)]


def test_model_declares_token_unique_constraint():
    constraints = {
        tuple(c.name for c in constraint.columns)
        for constraint in DeviceToken.__table__.constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    }
    assert ("expo_push_token",) in constraints
    assert ("fid", "expo_push_token") not in constraints
