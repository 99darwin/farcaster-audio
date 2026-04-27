from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    # Mock Redis since lifespan doesn't run in test transport
    mock_redis = AsyncMock()
    mock_redis.ping = AsyncMock(return_value=True)
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.set = AsyncMock()
    mock_redis.hset = AsyncMock()
    mock_redis.hget = AsyncMock(return_value=None)
    mock_redis.hgetall = AsyncMock(return_value={})
    mock_redis.hlen = AsyncMock(return_value=0)
    mock_redis.lrange = AsyncMock(return_value=[])
    mock_redis.rpush = AsyncMock()
    mock_redis.lrem = AsyncMock()
    mock_redis.llen = AsyncMock(return_value=0)
    mock_redis.zadd = AsyncMock()
    mock_redis.zrem = AsyncMock()
    mock_redis.zrevrange = AsyncMock(return_value=[])
    mock_redis.hdel = AsyncMock()
    mock_redis.delete = AsyncMock()
    mock_redis.publish = AsyncMock()
    mock_redis.close = AsyncMock()
    # Redis pipeline used for rate limiting (incr + expire then execute).
    # incr/expire are sync on a real pipeline; execute() returns the list of
    # results — give back (1, True) so rate limit checks see count=1.
    mock_pipeline = MagicMock()
    mock_pipeline.incr = MagicMock()
    mock_pipeline.expire = MagicMock()
    mock_pipeline.execute = AsyncMock(return_value=[1, True])
    mock_redis.pipeline = MagicMock(return_value=mock_pipeline)
    app.state.redis = mock_redis

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
