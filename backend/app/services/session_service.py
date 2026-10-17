"""Redis-backed agent session tokens.

An agent session is created when an agent pays via x402 to join a room.
The session token is scoped to one agent + one room and expires when the
room ends.

Redis key: agent_session:{token_hash} -> JSON {agent_fid, room_id, joined_at}
Counter key: agent_fid_counter -> auto-incrementing synthetic FID allocator
"""

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import redis.asyncio as aioredis

from app.config import settings

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

# Session tokens are prefixed for easy identification.
SESSION_TOKEN_PREFIX = "jk_sess_"

# Default TTL: 24 hours. Rooms rarely last longer.
DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60


@dataclass
class AgentSession:
    agent_fid: int
    room_id: str
    agent_name: str
    agent_pfp_url: str | None
    joined_at: str
    payer_address: str | None = None


class SessionService:
    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    async def create_session(
        self,
        room_id: str,
        agent_name: str,
        agent_pfp_url: str | None = None,
        payer_address: str | None = None,
        ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
        db: "AsyncSession | None" = None,
    ) -> tuple[str, AgentSession]:
        """Create a new agent session. Returns (token, session).

        Pass ``db`` to enable durable FID-collision checks against the
        User table. Without it, the Redis counter is trusted blindly —
        safe in steady-state but fragile after a Redis flush/restore.
        Callers in production paths should always pass it.
        """
        agent_fid = await self._allocate_fid(db=db)
        token = SESSION_TOKEN_PREFIX + secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc).isoformat()

        session = AgentSession(
            agent_fid=agent_fid,
            room_id=room_id,
            agent_name=agent_name,
            agent_pfp_url=agent_pfp_url,
            joined_at=now,
            payer_address=payer_address,
        )

        token_hash = self._hash_token(token)
        await self.redis.set(
            f"agent_session:{token_hash}",
            json.dumps(
                {
                    "agent_fid": session.agent_fid,
                    "room_id": session.room_id,
                    "agent_name": session.agent_name,
                    "agent_pfp_url": session.agent_pfp_url,
                    "joined_at": session.joined_at,
                    "payer_address": session.payer_address,
                }
            ),
            ex=ttl_seconds,
        )

        return token, session

    async def verify_session(
        self, token: str, room_id: str | None = None
    ) -> AgentSession | None:
        """Verify a session token. Optionally check room scope."""
        token_hash = self._hash_token(token)
        data = await self.redis.get(f"agent_session:{token_hash}")
        if not data:
            return None

        parsed = json.loads(data)
        session = AgentSession(**parsed)

        if room_id and session.room_id != room_id:
            return None

        return session

    async def expire_session(self, token: str) -> None:
        """Immediately expire a session token."""
        token_hash = self._hash_token(token)
        await self.redis.delete(f"agent_session:{token_hash}")

    async def expire_sessions_for_room(self, room_id: str) -> int:
        """Expire all agent sessions for a room. Returns count of expired sessions.

        Uses SCAN to find matching keys — safe for production Redis.
        """
        pattern = "agent_session:*"
        expired = 0
        async for key in self.redis.scan_iter(match=pattern, count=100):
            data = await self.redis.get(key)
            if data:
                parsed = json.loads(data)
                if parsed.get("room_id") == room_id:
                    await self.redis.delete(key)
                    expired += 1
        return expired

    async def _allocate_fid(self, db: "AsyncSession | None" = None) -> int:
        """Allocate the next synthetic FID for an agent.

        The counter lives in Redis (``agent_fid_counter``) and increments
        monotonically. When ``db`` is provided we additionally verify the
        allocated fid has no existing ``User`` row — defends against the
        Redis-flush / restored-snapshot scenario where the counter resets
        and the next mint would silently overwrite a previously-issued
        agent identity. On collision we keep INCR'ing until a free fid
        falls out (bounded to 1,000 attempts to avoid an unbounded loop
        in pathological DB state; raises if exhausted).
        """
        from app.models.user import User as _UserModel
        from sqlalchemy import select as _select

        for _ in range(1000):
            counter = await self.redis.incr("agent_fid_counter")
            fid = settings.AGENT_FID_START + counter
            if db is None:
                return fid
            result = await db.execute(_select(_UserModel).where(_UserModel.fid == fid))
            existing = result.scalar_one_or_none()
            if existing is None:
                return fid
            # Only tolerate collision when the existing row is a Juke-issued
            # agent — i.e. ``is_agent=True`` and ``signer_uuid`` matches our
            # synthetic pattern. Any other shape (a real user, or an
            # agent row from a different signer convention) means we've
            # genuinely wrapped into occupied space and must skip.
            if existing.is_agent and existing.signer_uuid == f"agent:{fid}":
                # Stale row from a prior session for the same synthetic
                # fid: fine to reuse since we know it was ours.
                return fid
        raise RuntimeError(
            "Failed to allocate a unique agent fid after 1000 attempts; "
            "agent_fid_counter may be wrapping into populated User space"
        )

    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()
