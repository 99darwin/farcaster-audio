import json
from typing import Any
import redis.asyncio as aioredis


class RedisService:
    ROOM_DISCOVERY_CHANNEL = "rooms:events"

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

    # --- Cleanup ---

    async def clear_room_state(self, room_id: str) -> None:
        """Remove all Redis keys for a room."""
        participants = await self.get_all_participants(room_id)

        pipe = self.redis.pipeline()
        pipe.delete(f"room:{room_id}:state")
        pipe.delete(f"room:{room_id}:participants")
        pipe.delete(f"room:{room_id}:hand_queue")
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
