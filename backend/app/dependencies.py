from typing import AsyncGenerator

import redis.asyncio as aioredis
from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.middleware.auth import get_admin_user, get_agent_or_user, get_current_user, get_optional_current_user  # re-export


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session, closing it on exit."""
    async with async_session() as session:
        yield session


async def get_redis(request: Request) -> aioredis.Redis:
    """Return the shared Redis connection pool attached to app state."""
    return request.app.state.redis


__all__ = ["get_db", "get_redis", "get_current_user", "get_admin_user", "get_agent_or_user", "get_optional_current_user"]
