"""
Push notification service — device token management, preference lookup,
and Expo push delivery.
"""

import json
import logging
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.device_token import DeviceToken
from app.models.notification_preference import NotificationPreference
from app.schemas.push import NotificationPreferencesResponse

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
NEYNAR_BASE = "https://api.neynar.com/v2"
REDIS_ACTIVE_FIDS_KEY = "push:active_fids"
REDIS_PREFS_PREFIX = "push:prefs:"
PREFS_CACHE_TTL = 300  # 5 minutes
MAX_TOKENS_PER_USER = 10


class PushService:
    def __init__(self, db: AsyncSession, redis: aioredis.Redis):
        self.db = db
        self.redis = redis

    # ------------------------------------------------------------------
    # Device token management
    # ------------------------------------------------------------------

    async def register_token(
        self, fid: int, expo_push_token: str, device_id: str | None = None
    ) -> None:
        """Upsert a device token and add the FID to the active set."""
        # Enforce per-user token limit — deactivate oldest if at cap
        from sqlalchemy import func as sa_func
        count_result = await self.db.execute(
            select(sa_func.count()).where(DeviceToken.fid == fid, DeviceToken.is_active.is_(True))
        )
        active_count = count_result.scalar() or 0
        if active_count >= MAX_TOKENS_PER_USER:
            oldest = await self.db.execute(
                select(DeviceToken.id)
                .where(DeviceToken.fid == fid, DeviceToken.is_active.is_(True))
                .order_by(DeviceToken.updated_at.asc())
                .limit(active_count - MAX_TOKENS_PER_USER + 1)
            )
            old_ids = [row[0] for row in oldest.all()]
            if old_ids:
                await self.db.execute(
                    update(DeviceToken).where(DeviceToken.id.in_(old_ids)).values(is_active=False)
                )

        stmt = pg_insert(DeviceToken).values(
            fid=fid,
            expo_push_token=expo_push_token,
            device_id=device_id,
            is_active=True,
            updated_at=datetime.now(timezone.utc),
        )
        stmt = stmt.on_conflict_do_update(
            constraint="uq_device_tokens_fid_token",
            set_={
                "is_active": True,
                "device_id": device_id,
                "updated_at": datetime.now(timezone.utc),
            },
        )
        await self.db.execute(stmt)
        await self.db.commit()

        await self.redis.sadd(REDIS_ACTIVE_FIDS_KEY, str(fid))
        await self._sync_webhook_fids()

    async def unregister_token(self, fid: int, expo_push_token: str) -> None:
        """Deactivate a device token. Remove FID from active set if no tokens remain."""
        await self.db.execute(
            update(DeviceToken)
            .where(
                DeviceToken.fid == fid,
                DeviceToken.expo_push_token == expo_push_token,
            )
            .values(is_active=False, updated_at=datetime.now(timezone.utc))
        )
        await self.db.commit()

        # Check if user still has active tokens
        result = await self.db.execute(
            select(DeviceToken.id)
            .where(DeviceToken.fid == fid, DeviceToken.is_active.is_(True))
            .limit(1)
        )
        if not result.scalar_one_or_none():
            await self.redis.srem(REDIS_ACTIVE_FIDS_KEY, str(fid))
            await self._sync_webhook_fids()

    async def unregister_all_tokens(self, fid: int) -> None:
        """Deactivate all tokens for a user (e.g., on logout)."""
        await self.db.execute(
            update(DeviceToken)
            .where(DeviceToken.fid == fid)
            .values(is_active=False, updated_at=datetime.now(timezone.utc))
        )
        await self.db.commit()
        await self.redis.srem(REDIS_ACTIVE_FIDS_KEY, str(fid))
        await self._sync_webhook_fids()

    # ------------------------------------------------------------------
    # Notification preferences
    # ------------------------------------------------------------------

    async def get_preferences(self, fid: int) -> NotificationPreferencesResponse:
        """Fetch preferences, creating defaults if absent. Uses Redis cache."""
        cached = await self.redis.get(f"{REDIS_PREFS_PREFIX}{fid}")
        if cached:
            return NotificationPreferencesResponse.model_validate_json(cached)

        result = await self.db.execute(
            select(NotificationPreference).where(NotificationPreference.fid == fid)
        )
        pref = result.scalar_one_or_none()

        if not pref:
            pref = NotificationPreference(fid=fid)
            self.db.add(pref)
            await self.db.commit()
            await self.db.refresh(pref)

        response = NotificationPreferencesResponse(
            follows_enabled=pref.follows_enabled,
            likes_enabled=pref.likes_enabled,
            replies_enabled=pref.replies_enabled,
            recasts_enabled=pref.recasts_enabled,
            space_started_enabled=pref.space_started_enabled,
            space_invited_enabled=pref.space_invited_enabled,
            hand_raised_enabled=pref.hand_raised_enabled,
            miniapp_enabled=pref.miniapp_enabled,
        )
        await self.redis.set(
            f"{REDIS_PREFS_PREFIX}{fid}",
            response.model_dump_json(),
            ex=PREFS_CACHE_TTL,
        )
        return response

    async def update_preferences(
        self, fid: int, updates: dict
    ) -> NotificationPreferencesResponse:
        """Partial update of notification preferences."""
        # Ensure row exists
        await self.get_preferences(fid)

        if updates:
            updates["updated_at"] = datetime.now(timezone.utc)
            await self.db.execute(
                update(NotificationPreference)
                .where(NotificationPreference.fid == fid)
                .values(**updates)
            )
            await self.db.commit()

        # Invalidate cache
        await self.redis.delete(f"{REDIS_PREFS_PREFIX}{fid}")
        prefs = await self.get_preferences(fid)

        # Sync webhook target_fids: remove FID if all types disabled, re-add if any enabled
        has_active_tokens = await self.redis.sismember(REDIS_ACTIVE_FIDS_KEY, str(fid))
        fids_changed = False
        if has_active_tokens:
            any_enabled = self._any_enabled(prefs)
            if not any_enabled:
                await self.redis.srem(REDIS_ACTIVE_FIDS_KEY, str(fid))
                fids_changed = True
        else:
            # Check if user has tokens but was removed due to all-disabled
            token_result = await self.db.execute(
                select(DeviceToken.id)
                .where(DeviceToken.fid == fid, DeviceToken.is_active.is_(True))
                .limit(1)
            )
            if token_result.scalar_one_or_none() and self._any_enabled(prefs):
                await self.redis.sadd(REDIS_ACTIVE_FIDS_KEY, str(fid))
                fids_changed = True

        if fids_changed:
            await self._sync_webhook_fids()

        return prefs

    @staticmethod
    def _any_enabled(prefs: NotificationPreferencesResponse) -> bool:
        """Return True if at least one notification type is enabled."""
        return any([
            prefs.follows_enabled,
            prefs.likes_enabled,
            prefs.replies_enabled,
            prefs.recasts_enabled,
            prefs.space_started_enabled,
            prefs.space_invited_enabled,
            prefs.hand_raised_enabled,
        ])

    async def is_enabled(self, fid: int, notification_type: str) -> bool:
        """Check if a specific notification type is enabled for a user."""
        prefs = await self.get_preferences(fid)
        field_map = {
            "follows": prefs.follows_enabled,
            "likes": prefs.likes_enabled,
            "reply": prefs.replies_enabled,
            "mention": prefs.replies_enabled,
            "recasts": prefs.recasts_enabled,
            "space_started": prefs.space_started_enabled,
            "space_invited": prefs.space_invited_enabled,
            "hand_raised": prefs.hand_raised_enabled,
        }
        return field_map.get(notification_type, False)

    # ------------------------------------------------------------------
    # Push delivery
    # ------------------------------------------------------------------

    async def send_push(
        self,
        fid: int,
        title: str,
        body: str,
        data: dict | None = None,
    ) -> None:
        """Send a push notification to all active devices for a user."""
        result = await self.db.execute(
            select(DeviceToken.expo_push_token).where(
                DeviceToken.fid == fid, DeviceToken.is_active.is_(True)
            )
        )
        tokens = [row[0] for row in result.all()]
        if not tokens:
            return

        messages = [
            {
                "to": token,
                "title": title,
                "body": body,
                "sound": "default",
                "data": data or {},
            }
            for token in tokens
        ]

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    EXPO_PUSH_URL,
                    json=messages,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                    },
                    timeout=10.0,
                )
                resp.raise_for_status()
                result_data = resp.json().get("data", [])
                logger.info("Expo push tickets for fid=%s: %s", fid, result_data)

                # Handle invalid tokens
                for i, ticket in enumerate(result_data):
                    if ticket.get("status") == "error" and ticket.get("details", {}).get("error") == "DeviceNotRegistered":
                        logger.info("Deactivating expired push token for fid=%s", fid)
                        await self.db.execute(
                            update(DeviceToken)
                            .where(DeviceToken.expo_push_token == tokens[i])
                            .values(is_active=False)
                        )
                await self.db.commit()

        except Exception as e:
            logger.error("Failed to send push notification to fid=%s: %s", fid, e)

    # ------------------------------------------------------------------
    # Neynar webhook event handling
    # ------------------------------------------------------------------

    async def handle_notification_event(
        self, event_type: str, payload: dict
    ) -> None:
        """Process an incoming Neynar webhook event and send push notifications."""
        logger.info("handle_notification_event: type=%s", event_type)
        target_fid: int | None = None
        title = ""
        body = ""
        data: dict = {}
        notification_type = ""

        if event_type == "cast.created":
            cast_data = payload.get("data", {})
            parent_author_fid = cast_data.get("parent_author", {}).get("fid")
            author = cast_data.get("author", {})
            author_name = author.get("display_name") or author.get("username", "Someone")
            cast_hash = cast_data.get("hash", "")

            # Check for mentions
            mentioned_fids = [
                m.get("fid")
                for m in cast_data.get("mentioned_profiles", [])
                if m.get("fid")
            ]

            if parent_author_fid:
                target_fid = parent_author_fid
                notification_type = "reply"
                title = "New Reply"
                body = f"{author_name} replied to your cast"
                data = {"type": "reply", "url": f"/cast/{cast_hash}"}

            # Send mention notifications (separate from reply)
            for mfid in mentioned_fids:
                if mfid == author.get("fid"):
                    continue  # Don't notify self-mentions
                is_active = await self.redis.sismember(REDIS_ACTIVE_FIDS_KEY, str(mfid))
                if not is_active:
                    continue
                if await self.is_enabled(mfid, "mention"):
                    await self.send_push(
                        fid=mfid,
                        title="You were mentioned",
                        body=f"{author_name} mentioned you in a cast",
                        data={"type": "mention", "url": f"/cast/{cast_hash}"},
                    )

        elif event_type == "reaction.created":
            reaction_data = payload.get("data", {})
            reaction_type = reaction_data.get("reaction_type")
            cast = reaction_data.get("cast", {})
            cast_author = cast.get("author")
            logger.info("reaction cast.author type=%s value=%s", type(cast_author).__name__, cast_author)
            target_fid = cast_author.get("fid") if isinstance(cast_author, dict) else cast_author
            reactor = reaction_data.get("user", {})
            reactor_name = reactor.get("display_name") or reactor.get("username", "Someone")
            cast_hash = cast.get("hash", "")

            if reaction_type in ("like", 1):
                notification_type = "likes"
                title = "New Like"
                body = f"{reactor_name} liked your cast"
                data = {"type": "like", "url": f"/cast/{cast_hash}"}
            elif reaction_type in ("recast", 2):
                notification_type = "recasts"
                title = "New Recast"
                body = f"{reactor_name} recasted your cast"
                data = {"type": "recast", "url": f"/cast/{cast_hash}"}

        elif event_type == "follow.created":
            follow_data = payload.get("data", {})
            target_fid = follow_data.get("user", {}).get("fid")
            follower = follow_data.get("follower", {})
            follower_name = follower.get("display_name") or follower.get("username", "Someone")
            follower_fid = follower.get("fid")

            notification_type = "follows"
            title = "New Follower"
            body = f"{follower_name} followed you"
            data = {"type": "follow", "url": f"/profile/{follower_fid}"}

        if not target_fid or not notification_type:
            logger.info("Skipping event %s: no target_fid or notification_type", event_type)
            return

        # Don't notify yourself
        actor_fid = payload.get("data", {}).get("author", {}).get("fid") or \
                    payload.get("data", {}).get("user", {}).get("fid") or \
                    payload.get("data", {}).get("follower", {}).get("fid")
        if actor_fid == target_fid:
            logger.info("Skipping self-notification for fid=%s", target_fid)
            return

        # Check if target is an active Juke user
        is_active = await self.redis.sismember(REDIS_ACTIVE_FIDS_KEY, str(target_fid))
        if not is_active:
            logger.info("Skipping fid=%s (target): not in active_fids set", target_fid)
            return

        # Check notification preference
        if not await self.is_enabled(target_fid, notification_type):
            logger.info("Skipping fid=%s: %s notifications disabled", target_fid, notification_type)
            return

        logger.info("Sending %s push to fid=%s from fid=%s", notification_type, target_fid, actor_fid)
        await self.send_push(fid=target_fid, title=title, body=body, data=data)

    # ------------------------------------------------------------------
    # Space event push notifications (called from room_service)
    # ------------------------------------------------------------------

    async def notify_hand_raised(
        self, host_fid: int, raiser_name: str, room_id: str
    ) -> None:
        """Notify the space host that someone raised their hand."""
        is_active = await self.redis.sismember(REDIS_ACTIVE_FIDS_KEY, str(host_fid))
        if not is_active:
            return
        if not await self.is_enabled(host_fid, "hand_raised"):
            return
        await self.send_push(
            fid=host_fid,
            title="Hand Raised",
            body=f"{raiser_name} wants to speak",
            data={"type": "hand_raised", "url": f"/space/{room_id}"},
        )

    async def notify_invited_to_speak(
        self, target_fid: int, inviter_name: str, room_id: str, room_title: str
    ) -> None:
        """Notify a user they've been invited to speak in a space."""
        is_active = await self.redis.sismember(REDIS_ACTIVE_FIDS_KEY, str(target_fid))
        if not is_active:
            return
        if not await self.is_enabled(target_fid, "space_invited"):
            return
        await self.send_push(
            fid=target_fid,
            title="Invited to Speak",
            body=f"{inviter_name} invited you to speak in \"{room_title}\"",
            data={"type": "space_invite", "url": f"/space/{room_id}"},
        )

    # ------------------------------------------------------------------
    # Neynar webhook target_fids sync
    # ------------------------------------------------------------------

    async def _sync_webhook_fids(self) -> None:
        """Update all Neynar notification webhooks with the current active FID list."""
        webhook_url = f"{settings.API_BASE_URL}/v1/webhooks/neynar/notifications"

        # Each webhook type uses different subscription filter keys.
        # - cast.created: parent_author_fids (replies) + mentioned_fids (mentions)
        #   These are OR'd by Neynar, so we get both.
        # - reaction.created: target_fids (person whose cast was liked/recasted)
        # - follow.created: target_fids (person being followed)
        webhooks = [
            {
                "webhook_id": settings.NEYNAR_WEBHOOK_ID_CAST,
                "name": "juke-push-cast",
                "event_key": "cast.created",
                "fid_keys": ["parent_author_fids", "mentioned_fids"],
            },
            {
                "webhook_id": settings.NEYNAR_WEBHOOK_ID_REACTION,
                "name": "juke-push-reaction",
                "event_key": "reaction.created",
                "fid_keys": ["target_fids"],
            },
            {
                "webhook_id": settings.NEYNAR_WEBHOOK_ID_FOLLOW,
                "name": "juke-push-follow",
                "event_key": "follow.created",
                "fid_keys": ["target_fids"],
            },
        ]
        webhooks = [w for w in webhooks if w["webhook_id"]]
        if not webhooks:
            logger.warning("No NEYNAR_WEBHOOK_ID_* env vars set — skipping sync")
            return

        # Get all active FIDs from Redis
        raw_fids = await self.redis.smembers(REDIS_ACTIVE_FIDS_KEY)
        fid_list = [int(f) for f in raw_fids]

        if not fid_list:
            logger.info("No active FIDs — clearing webhook filters")

        try:
            async with httpx.AsyncClient() as client:
                for wh in webhooks:
                    filters = {key: fid_list for key in wh["fid_keys"]}
                    subscription = {wh["event_key"]: filters}
                    resp = await client.put(
                        f"{NEYNAR_BASE}/farcaster/webhook",
                        json={
                            "webhook_id": wh["webhook_id"],
                            "name": wh["name"],
                            "url": webhook_url,
                            "subscription": subscription,
                        },
                        headers={"x-api-key": settings.NEYNAR_API_KEY},
                        timeout=15.0,
                    )
                    if resp.status_code >= 400:
                        logger.error(
                            "Neynar webhook sync failed for %s: %s %s",
                            wh["webhook_id"], resp.status_code, resp.text,
                        )
                        continue
                    logger.info(
                        "Synced webhook %s with %d target FIDs",
                        wh["webhook_id"], len(fid_list),
                    )
        except Exception as e:
            logger.error("Failed to sync webhook target_fids: %s", e)

