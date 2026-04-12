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

import redis.asyncio as aioredis

from app.config import settings

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
    ) -> tuple[str, AgentSession]:
        """Create a new agent session. Returns (token, session)."""
        agent_fid = await self._allocate_fid()
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
            json.dumps({
                "agent_fid": session.agent_fid,
                "room_id": session.room_id,
                "agent_name": session.agent_name,
                "agent_pfp_url": session.agent_pfp_url,
                "joined_at": session.joined_at,
                "payer_address": session.payer_address,
            }),
            ex=ttl_seconds,
        )

        return token, session

    async def verify_session(self, token: str, room_id: str | None = None) -> AgentSession | None:
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

    async def _allocate_fid(self) -> int:
        """Allocate the next synthetic FID using a Redis counter."""
        counter = await self.redis.incr("agent_fid_counter")
        return settings.AGENT_FID_START + counter

    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()
