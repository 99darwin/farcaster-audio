import json
from typing import Any
import redis.asyncio as aioredis


class RedisService:
    ROOM_DISCOVERY_CHANNEL = "rooms:events"
    ANONYMOUS_LISTENER_TTL_SECONDS = 20 * 60

    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    # --- Room State ---

    async def set_room_state(self, room_id: str, state: dict) -> None:
        await self.redis.set(f"room:{room_id}:state", json.dumps(state))

    async def get_room_state(self, room_id: str) -> dict | None:
        data = await self.redis.get(f"room:{room_id}:state")
        return json.loads(data) if data else None

    async def delete_room_state(self, room_id: str) -> None:
        await self.redis.delete(f"room:{room_id}:state")

    # --- Participants ---

    async def set_participant(self, room_id: str, fid: int, data: dict) -> None:
        await self.redis.hset(
            f"room:{room_id}:participants", str(fid), json.dumps(data)
        )

    async def get_participant(self, room_id: str, fid: int) -> dict | None:
        data = await self.redis.hget(f"room:{room_id}:participants", str(fid))
        return json.loads(data) if data else None

    async def remove_participant(self, room_id: str, fid: int) -> None:
        await self.redis.hdel(f"room:{room_id}:participants", str(fid))

    async def get_all_participants(self, room_id: str) -> list[dict]:
        data = await self.redis.hgetall(f"room:{room_id}:participants")
        return [json.loads(v) for v in data.values()]

    async def get_participant_count(self, room_id: str) -> int:
        return await self.redis.hlen(f"room:{room_id}:participants")

    async def get_speaker_count(self, room_id: str) -> int:
        participants = await self.get_all_participants(room_id)
        return sum(
            1 for p in participants if p.get("role") in ("host", "co_host", "speaker")
        )

    async def get_listener_count(self, room_id: str) -> int:
        participants = await self.get_all_participants(room_id)
        return sum(1 for p in participants if p.get("role") == "listener")

    # --- LiveKit grant revocations ---
    #
    # Kick/ban/demote only change the *live* LiveKit connection. A
    # previously issued join token stays valid until it expires, so we
    # record the revocation for (at least) the token lifetime and the
    # ``participant_joined`` webhook enforces it if the stale token is
    # replayed after the user's Redis participant row is gone.

    LIVEKIT_REVOCATION_REMOVED = "removed"
    LIVEKIT_REVOCATION_LISTENER = "listener"

    def livekit_revocation_key(self, room_id: str, fid: int) -> str:
        return f"room:{room_id}:lk_revoked:{fid}"

    async def mark_livekit_revocation(
        self, room_id: str, fid: int, kind: str, ttl_seconds: int
    ) -> None:
        await self.redis.set(
            self.livekit_revocation_key(room_id, fid), kind, ex=ttl_seconds
        )

    async def clear_livekit_revocation(self, room_id: str, fid: int) -> None:
        await self.redis.delete(self.livekit_revocation_key(room_id, fid))

    async def get_livekit_revocation(self, room_id: str, fid: int) -> str | None:
        value = await self.redis.get(self.livekit_revocation_key(room_id, fid))
        if isinstance(value, bytes):
            value = value.decode()
        return value if isinstance(value, str) else None

    def anonymous_listener_key(self, room_id: str) -> str:
        return f"room:{room_id}:anonymous_listeners"

    async def remove_anonymous_listener(self, room_id: str, session_id: str) -> None:
        await self.redis.zrem(self.anonymous_listener_key(room_id), session_id)

    async def get_anonymous_listener_count(self, room_id: str, now: float) -> int:
        key = self.anonymous_listener_key(room_id)
        cutoff = now - self.ANONYMOUS_LISTENER_TTL_SECONDS
        pipe = self.redis.pipeline()
        pipe.zremrangebyscore(key, 0, cutoff)
        pipe.zcard(key)
        results = await pipe.execute()
        count = results[1] if len(results) > 1 else 0
        return count if isinstance(count, int) and not isinstance(count, bool) else 0

    async def get_room_participant_counts(
        self, room_ids: list[str]
    ) -> dict[str, tuple[int, int]]:
        """Return speaker/listener counts for many rooms in one Redis pipeline."""
        if not room_ids:
            return {}
        pipe = self.redis.pipeline()
        for room_id in room_ids:
            pipe.hgetall(f"room:{room_id}:participants")
        rows = await pipe.execute()
        counts: dict[str, tuple[int, int]] = {}
        for room_id, data in zip(room_ids, rows):
            participants = [json.loads(v) for v in data.values()]
            speakers = sum(
                1
                for p in participants
                if p.get("role") in ("host", "co_host", "speaker")
            )
            listeners = sum(1 for p in participants if p.get("role") == "listener")
            counts[room_id] = (speakers, listeners)
        return counts

    # --- Hand Queue ---

    async def add_to_hand_queue(self, room_id: str, fid: int) -> int:
        """Add fid to hand queue. Returns queue position (1-based)."""
        key = f"room:{room_id}:hand_queue"
        # Check if already in queue
        queue = await self.redis.lrange(key, 0, -1)
        if str(fid) in queue:
            return queue.index(str(fid)) + 1
        await self.redis.rpush(key, str(fid))
        return await self.redis.llen(key)

    async def remove_from_hand_queue(self, room_id: str, fid: int) -> None:
        await self.redis.lrem(f"room:{room_id}:hand_queue", 0, str(fid))

    async def get_hand_queue(self, room_id: str) -> list[int]:
        queue = await self.redis.lrange(f"room:{room_id}:hand_queue", 0, -1)
        return [int(fid) for fid in queue]

    # --- Active Rooms (Sorted Set) ---

    async def add_active_room(self, room_id: str, started_at_timestamp: float) -> None:
        await self.redis.zadd("active_rooms", {room_id: started_at_timestamp})

    async def remove_active_room(self, room_id: str) -> None:
        await self.redis.zrem("active_rooms", room_id)

    async def get_active_rooms(self, limit: int = 20, offset: int = 0) -> list[str]:
        """Get active room IDs sorted by started_at descending."""
        return await self.redis.zrevrange("active_rooms", offset, offset + limit - 1)

    # --- User Active Room ---

    async def set_user_active_room(self, fid: int, room_id: str) -> None:
        await self.redis.set(f"user:{fid}:active_room", room_id)

    async def get_user_active_room(self, fid: int) -> str | None:
        return await self.redis.get(f"user:{fid}:active_room")

    async def clear_user_active_room(self, fid: int) -> None:
        await self.redis.delete(f"user:{fid}:active_room")

    # --- Pub/Sub ---

    async def publish_room_event(self, room_id: str, event: dict) -> None:
        await self.redis.publish(f"room:{room_id}:events", json.dumps(event))

    async def publish_room_discovery_event(self, event: dict[str, Any]) -> None:
        await self.redis.publish(self.ROOM_DISCOVERY_CHANNEL, json.dumps(event))

    PARTICIPANTS_EVENT_THROTTLE_SECONDS = 2

    async def try_mark_participants_event(
        self, room_id: str, window_seconds: int = PARTICIPANTS_EVENT_THROTTLE_SECONDS
    ) -> bool:
        """Leading-edge throttle for participant-change discovery pings.

        Returns ``True`` at most once per ``window_seconds`` per room — the
        caller should publish a ``participants_changed`` discovery event only
        when this returns ``True``. Subsequent calls within the window return
        ``False`` so a burst of joins/leaves on a busy room coalesces into a
        single discovery event instead of a storm. The 30s discovery poll is
        the backstop for changes that land inside a throttle window.
        """
        key = f"room:{room_id}:pc_ping"
        was_set = await self.redis.set(key, "1", nx=True, ex=window_seconds)
        return bool(was_set)

    # --- Recent SIWN Step-Up ---
    #
    # Set a short-lived marker after a successful SIWN login so dangerous
    # developer-key mutations (rotate, revoke, reveal, delete-app) can
    # require a recent re-authentication. The marker is NOT touched on
    # refresh — a stale, long-lived session must SIWN again to mutate.

    SIWN_RECENT_TTL_SECONDS = 5 * 60

    @staticmethod
    def _siwn_key(fid: int) -> str:
        return f"siwn:{fid}"

    async def mark_siwn(
        self, fid: int, ttl_seconds: int = SIWN_RECENT_TTL_SECONDS
    ) -> None:
        """Record that `fid` just completed SIWN. TTL bounds the step-up window."""
        await self.redis.set(self._siwn_key(fid), "1", ex=ttl_seconds)

    async def has_recent_siwn(self, fid: int) -> bool:
        """True iff `fid` has SIWN'd within the configured window."""
        exists = await self.redis.exists(self._siwn_key(fid))
        try:
            return int(exists) > 0
        except (TypeError, ValueError):
            return bool(exists)

    # --- Rate Limiting ---

    async def check_rate_limit(
        self, key: str, limit: int, window_seconds: int
    ) -> tuple[bool, int]:
        """Backwards-compatible 2-tuple wrapper around ``check_rate_limit_status``.

        Returns ``(allowed, retry_after_seconds)``. New callers that want
        ``remaining`` / ``reset_in_seconds`` for response headers should use
        ``check_rate_limit_status`` directly.
        """
        status = await self.check_rate_limit_status(key, limit, window_seconds)
        return status[0], status[1]

    async def check_rate_limit_status(
        self, key: str, limit: int, window_seconds: int
    ) -> tuple[bool, int, int, int]:
        """Atomic increment + return full bucket state.

        Returns ``(allowed, retry_after_seconds, remaining, reset_in_seconds)``.

        - ``allowed``: True if the request is within ``limit`` for the window
        - ``retry_after_seconds``: ≥1 when blocked, 0 when allowed
        - ``remaining``: how many further calls fit in the current window
          (clamped to ≥0)
        - ``reset_in_seconds``: TTL on the bucket key — when the counter
          resets to 0
        """
        pipe = self.redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, window_seconds)
        count, _ = await pipe.execute()
        try:
            attempts = int(count)
        except (TypeError, ValueError):
            # In tests where Redis is mocked, a non-int response means the
            # rate limiter isn't actually wired up — fail open.
            return True, 0, limit, window_seconds
        ttl = await self.redis.ttl(key)
        try:
            ttl_int = int(ttl)
        except (TypeError, ValueError):
            ttl_int = window_seconds
        reset_in_seconds = ttl_int if ttl_int > 0 else window_seconds
        remaining = max(0, limit - attempts)
        if attempts <= limit:
            return True, 0, remaining, reset_in_seconds
        retry_after = max(1, reset_in_seconds)
        return False, retry_after, 0, reset_in_seconds

    # --- Cleanup ---

    async def clear_room_state(self, room_id: str) -> None:
        """Remove all Redis keys for a room."""
        participants = await self.get_all_participants(room_id)

        pipe = self.redis.pipeline()
        pipe.delete(f"room:{room_id}:state")
        pipe.delete(f"room:{room_id}:participants")
        pipe.delete(f"room:{room_id}:hand_queue")
        pipe.delete(self.anonymous_listener_key(room_id))
        pipe.zrem("active_rooms", room_id)
        await pipe.execute()

        # Clear user active room for all participants
        if participants:
            pipe = self.redis.pipeline()
            for p in participants:
                fid = p.get("fid")
                if fid:
                    pipe.delete(f"user:{fid}:active_room")
            await pipe.execute()
