"""
Push notification service — device token management, preference lookup,
and Expo push delivery.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import unquote, urlparse

import httpx
import redis.asyncio as aioredis
from sqlalchemy import distinct, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.config import settings
from app.models.device_token import DeviceToken
from app.models.miniapp_notification import MiniAppNotification
from app.models.notification_preference import NotificationPreference
from app.models.room import Room
from app.models.room_rsvp import RoomRsvp
from app.schemas.push import NotificationPreferencesResponse, RoomLiveNotifyResponse
from app.services.spam_service import SpamService

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
REDIS_ACTIVE_FIDS_KEY = "push:active_fids"
REDIS_PREFS_PREFIX = "push:prefs:"
PREFS_CACHE_TTL = 300  # 5 minutes
MAX_TOKENS_PER_USER = 10


def _preview(text: str, max_len: int = 140) -> str:
    """Collapse whitespace and truncate a cast preview for push bodies."""
    clean = " ".join((text or "").split())
    if len(clean) <= max_len:
        return clean
    return clean[: max_len - 1].rstrip() + "…"


PFP_CACHE_PREFIX = "push:pfp:"
PFP_CACHE_TTL = 86400  # 24h, including null sentinel for users without a PFP
THREAD_ROOT_AUTHOR_CACHE_PREFIX = "push:thread-root-author:"
THREAD_ROOT_AUTHOR_CACHE_TTL = 60 * 60 * 24 * 7
SPACE_LIVE_IDEMPOTENCY_PREFIX = "push:space_live:"
SPACE_LIVE_IDEMPOTENCY_TTL = 60 * 60 * 24 * 30
JUKE_WEB_BASE_URL = "https://juke.audio"
MINIAPP_NOTIFICATION_HOSTS = {
    "api.warpcast.com",
    "api.warpcast.xyz",
    "notifs.warpcast.com",
}
# Image CDNs Farcaster profile pictures are actually served from. Matching
# is exact host or subdomain. These are shared, high-volume CDNs, so a
# request there does not tell any one profile owner who was notified.
PUSH_IMAGE_HOSTS = frozenset(
    {
        "imagedelivery.net",  # Cloudflare Images (Warpcast uploads)
        "wrpcd.net",  # Warpcast image proxy
        "i.imgur.com",
        "res.cloudinary.com",
        "i.seadn.io",  # OpenSea NFT pfps
        "openseauserdata.com",
        "lh3.googleusercontent.com",
        "pbs.twimg.com",
    }
)
# Path/query markers of an image proxy fetching another origin (checked
# after percent-decoding, to catch ``https%3A%2F%2F`` and double encoding).
PROXIED_FETCH_MARKERS = ("http:", "https:", "//", "/image/fetch/")
PROXY_DECODE_ROUNDS = 3


def _is_safe_image_url(url: str | None) -> bool:
    """Validate that ``url`` is safe to hand to Expo's richContent.image.

    pfp_urls flow from Neynar webhook payloads (HMAC-verified) but ultimately
    come from user-controlled Farcaster profiles. Without scheme validation,
    a malicious profile could:
      - point at ``data:`` or ``http://`` URLs that waste NSE bandwidth on
        every recipient device
      - point at an attacker-owned tracking pixel and learn which FIDs
        received pushes (correlation/surveillance vector)
      - point at internal/private hosts (SSRF-adjacent — NSE tries to fetch)

    Only https URLs on a known image CDN (:data:`PUSH_IMAGE_HOSTS`, or a
    subdomain of one) pass; anything else degrades to a text-only push, so
    an arbitrary attacker host never learns who received a notification.
    """
    if not url:
        return False
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "https" or port not in (None, 443):
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return False
    if not any(
        host == allowed or host.endswith("." + allowed) for allowed in PUSH_IMAGE_HOSTS
    ):
        return False
    return not _is_proxied_fetch(parsed.path, parsed.query)


def _is_proxied_fetch(path: str, query: str) -> bool:
    """True when an allowlisted CDN URL would fetch another origin.

    Image proxies on allowlisted hosts (``wrpcd.net/cdn-cgi/image/<opts>/
    https%3A%2F%2F…``, Cloudinary ``/image/fetch/<url>``) would let an
    attacker-chosen origin see each delivery on a cache miss, so they are
    treated as untrusted.
    """
    decoded = f"{path}?{query}"
    for _ in range(PROXY_DECODE_ROUNDS):
        decoded = unquote(decoded)
    decoded = decoded.lower()
    return any(marker in decoded for marker in PROXIED_FETCH_MARKERS)


def _is_safe_miniapp_notification_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme == "https" and parsed.hostname in MINIAPP_NOTIFICATION_HOSTS


def _dialect_insert(db: AsyncSession):
    """``insert`` with ON CONFLICT support for the session's dialect."""
    if db.bind is not None and db.bind.dialect.name == "sqlite":
        return sqlite_insert
    return pg_insert


def _redis_bool(value) -> bool:
    return value in (True, 1, b"1", "1")


def _extract_actor(event_type: str, payload: dict) -> tuple[int | None, dict | None]:
    """Return (actor_fid, actor_user_object) for a webhook payload.

    The "actor" is whoever triggered the notification — author for cast.created,
    reactor for reaction.created, follower for follow.created. The user object
    lets SpamService score a FID it has no cached or stored verdict for.
    """
    data = payload.get("data") or {}
    if event_type == "cast.created":
        actor = data.get("author") or {}
    elif event_type == "reaction.created":
        actor = data.get("user") or {}
    elif event_type == "follow.created":
        actor = data.get("follower") or {}
    else:
        return (None, None)
    fid = actor.get("fid")
    return (fid if isinstance(fid, int) else None, actor)


class PushService:
    def __init__(self, db: AsyncSession, redis: aioredis.Redis):
        self.db = db
        self.redis = redis

    async def _resolve_pfp_url(self, fid: int | None) -> str | None:
        """Resolve a user's pfp_url, falling back to Hypersnap user/bulk if needed.

        Neynar webhook payloads include a skinny actor object (fid + username
        only — no pfp_url), so we have to enrich on the push path. Cache the
        result for 24h, including a null sentinel ("") for users without a PFP
        so we don't re-call the API for every notification they trigger.
        """
        if not fid:
            return None
        cache_key = f"{PFP_CACHE_PREFIX}{fid}"
        cached = await self.redis.get(cache_key)
        if cached is not None:
            return cached or None

        pfp: str | None = None
        try:
            users = (await hypersnap.get("/user/bulk", {"fids": str(fid)})).get(
                "users", []
            )
        except hypersnap.HypersnapError as e:
            logger.warning("Hypersnap pfp lookup failed for fid=%s: %s", fid, e)
            return None
        if users:
            candidate = users[0].get("pfp_url")
            if isinstance(candidate, str) and candidate:
                pfp = candidate

        await self.redis.set(cache_key, pfp or "", ex=PFP_CACHE_TTL)
        return pfp

    async def _resolve_thread_root_author_fid(
        self, thread_hash: str | None
    ) -> int | None:
        """Resolve the original author for a reply thread.

        Neynar's ``cast.created`` webhook identifies only the immediate parent
        author. For replies-to-replies we also notify the original poster, so
        resolve the canonical thread cast by hash and cache its author. A
        lookup failure is deliberately soft: the immediate parent still gets
        their notification and Neynar can retry future events normally.
        """
        if not thread_hash:
            return None

        cache_key = f"{THREAD_ROOT_AUTHOR_CACHE_PREFIX}{thread_hash}"
        cached = await self.redis.get(cache_key)
        if cached is not None:
            try:
                cached_fid = int(cached)
            except (TypeError, ValueError):
                return None
            return cached_fid if cached_fid > 0 else None

        try:
            data = await hypersnap.get(
                "/cast", {"identifier": thread_hash, "type": "hash"}
            )
            author_fid = data.get("cast", {}).get("author", {}).get("fid")
        except hypersnap.HypersnapError as exc:
            logger.warning(
                "Hypersnap thread-root lookup failed for hash=%s: %s",
                thread_hash,
                exc,
            )
            return None

        if not isinstance(author_fid, int) or author_fid <= 0:
            return None
        await self.redis.set(
            cache_key,
            str(author_fid),
            ex=THREAD_ROOT_AUTHOR_CACHE_TTL,
        )
        return author_fid

    async def _send_event_push_if_eligible(
        self,
        *,
        target_fid: int | None,
        actor_fid: int | None,
        notification_type: str,
        title: str,
        body: str,
        data: dict,
        image_url: str | None,
    ) -> bool:
        """Apply self/registration/preference gates, then deliver one event."""
        if not isinstance(target_fid, int) or target_fid <= 0:
            return False
        if actor_fid == target_fid:
            logger.info("Skipping self-notification for fid=%s", target_fid)
            return False
        is_active = await self.redis.sismember(REDIS_ACTIVE_FIDS_KEY, str(target_fid))
        if not is_active:
            logger.info("Skipping fid=%s (target): not in active_fids set", target_fid)
            return False
        if not await self.is_enabled(target_fid, notification_type):
            logger.info(
                "Skipping fid=%s: %s notifications disabled",
                target_fid,
                notification_type,
            )
            return False
        logger.info(
            "Sending %s push to fid=%s from fid=%s",
            notification_type,
            target_fid,
            actor_fid,
        )
        await self.send_push(
            fid=target_fid,
            title=title,
            body=body,
            data=data,
            image_url=image_url,
        )
        return True

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
            select(sa_func.count()).where(
                DeviceToken.fid == fid, DeviceToken.is_active.is_(True)
            )
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
                    update(DeviceToken)
                    .where(DeviceToken.id.in_(old_ids))
                    .values(is_active=False)
                )

        # An Expo token identifies one device, so it belongs to exactly one
        # fid: the latest to register it (the account signed in on that
        # device now). Re-registering moves it rather than adding a second
        # binding, so a device that switched accounts stops receiving the
        # previous account's pushes. (Expo tokens are bearer identifiers:
        # this does not prove device possession.)
        previous_owner = await self.db.scalar(
            select(DeviceToken.fid).where(
                DeviceToken.expo_push_token == expo_push_token
            )
        )
        now = datetime.now(timezone.utc)
        stmt = _dialect_insert(self.db)(DeviceToken).values(
            fid=fid,
            expo_push_token=expo_push_token,
            device_id=device_id,
            is_active=True,
            updated_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[DeviceToken.expo_push_token],
            set_={
                "fid": fid,
                "is_active": True,
                "device_id": device_id,
                "updated_at": now,
            },
        )
        await self.db.execute(stmt)
        await self.db.commit()

        await self.redis.sadd(REDIS_ACTIVE_FIDS_KEY, str(fid))
        if previous_owner is not None and previous_owner != fid:
            await self._drop_from_active_set_if_no_tokens(previous_owner)
        await self._sync_webhook_fids()

    async def _drop_from_active_set_if_no_tokens(self, fid: int) -> None:
        result = await self.db.execute(
            select(DeviceToken.id)
            .where(DeviceToken.fid == fid, DeviceToken.is_active.is_(True))
            .limit(1)
        )
        if result.scalar_one_or_none() is None:
            await self.redis.srem(REDIS_ACTIVE_FIDS_KEY, str(fid))

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
        return any(
            [
                prefs.follows_enabled,
                prefs.likes_enabled,
                prefs.replies_enabled,
                prefs.recasts_enabled,
                prefs.space_started_enabled,
                prefs.space_invited_enabled,
                prefs.hand_raised_enabled,
            ]
        )

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
            "miniapp": prefs.miniapp_enabled,
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
        image_url: str | None = None,
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

        # Only attach richContent when the URL passes scheme/host validation.
        # An invalid pfp_url (http://, data:, internal host, etc.) silently
        # degrades to a text-only push rather than blocking delivery.
        attach_image = bool(image_url) and _is_safe_image_url(image_url)
        if image_url and not attach_image:
            # The URL itself is user-controlled profile data; don't log it.
            logger.info("Push image skipped fid=%s: host not allowlisted", fid)
        messages: list[dict] = []
        for token in tokens:
            message_data = dict(data or {})
            message: dict = {
                "to": token,
                "title": title,
                "body": body,
                "sound": "default",
                "data": message_data,
            }
            if attach_image:
                message["richContent"] = {"image": image_url}
                message["mutableContent"] = True
                message_data["pfp_url"] = image_url
            messages.append(message)

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
                    if (
                        ticket.get("status") == "error"
                        and ticket.get("details", {}).get("error")
                        == "DeviceNotRegistered"
                    ):
                        logger.info("Deactivating expired push token for fid=%s", fid)
                        await self.db.execute(
                            update(DeviceToken)
                            .where(DeviceToken.expo_push_token == tokens[i])
                            .values(is_active=False)
                        )
                await self.db.commit()

        except Exception as e:
            logger.error("Failed to send push notification to fid=%s: %s", fid, e)

    async def _send_miniapp_notification(
        self,
        fid: int,
        title: str,
        body: str,
        target_url: str,
        notification_id: str,
    ) -> bool:
        result = await self.db.execute(
            select(MiniAppNotification).where(
                MiniAppNotification.fid == fid,
                MiniAppNotification.is_active.is_(True),
            )
        )
        registration = result.scalar_one_or_none()
        if not registration:
            return False
        if not _is_safe_miniapp_notification_url(registration.notification_url):
            logger.warning(
                "Deactivating unsafe miniapp notification URL for fid=%s", fid
            )
            registration.is_active = False
            await self.db.commit()
            return False

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    registration.notification_url,
                    json={
                        "notificationId": notification_id,
                        "title": title,
                        "body": body,
                        "targetUrl": target_url,
                        "tokens": [registration.notification_token],
                    },
                    headers={
                        "Authorization": f"Bearer {registration.notification_token}",
                        "Content-Type": "application/json",
                    },
                    timeout=10.0,
                )
                if resp.status_code in (400, 404, 410):
                    logger.info(
                        "Deactivating invalid miniapp notification for fid=%s status=%s",
                        fid,
                        resp.status_code,
                    )
                    registration.is_active = False
                    await self.db.commit()
                    return False
                resp.raise_for_status()
                return True
        except Exception as e:
            logger.error("Failed to send miniapp notification to fid=%s: %s", fid, e)
            return False

    async def _has_native_target(self, fid: int) -> bool:
        result = await self.db.execute(
            select(DeviceToken.id)
            .where(DeviceToken.fid == fid, DeviceToken.is_active.is_(True))
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def _has_miniapp_target(self, fid: int) -> bool:
        result = await self.db.execute(
            select(MiniAppNotification.id)
            .where(
                MiniAppNotification.fid == fid,
                MiniAppNotification.is_active.is_(True),
            )
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def _mark_delivery_once(self, room_id: str, campaign: str, fid: int) -> bool:
        key = f"{SPACE_LIVE_IDEMPOTENCY_PREFIX}{campaign}:{room_id}"
        try:
            added = _redis_bool(await self.redis.sadd(key, str(fid)))
            if added:
                await self.redis.expire(key, SPACE_LIVE_IDEMPOTENCY_TTL)
            return added
        except Exception as e:
            logger.warning(
                "Space live idempotency check failed room_id=%s campaign=%s fid=%s: %s",
                room_id,
                campaign,
                fid,
                e,
            )
            return True

    async def _active_reachable_fids(self) -> list[int]:
        native_result = await self.db.execute(
            select(distinct(DeviceToken.fid)).where(DeviceToken.is_active.is_(True))
        )
        miniapp_result = await self.db.execute(
            select(distinct(MiniAppNotification.fid)).where(
                MiniAppNotification.is_active.is_(True)
            )
        )
        fids = {int(row[0]) for row in native_result.all()}
        fids.update(int(row[0]) for row in miniapp_result.all())
        return sorted(fids)

    async def _rsvp_fids(self, room_uuid) -> list[int]:
        result = await self.db.execute(
            select(RoomRsvp.fid).where(RoomRsvp.room_id == room_uuid)
        )
        return [int(row[0]) for row in result.all()]

    async def notify_space_started_rsvps(
        self,
        room_id: str,
        room_uuid,
        title: str,
        host_fid: int,
    ) -> RoomLiveNotifyResponse:
        """Send regular go-live notifications to RSVP'd users.

        This path respects ``space_started_enabled`` and skips the host. It sends
        both native and miniapp channels when the user has active registrations.
        """
        return await self._notify_room_live(
            room_id=room_id,
            room_uuid=room_uuid,
            title=title,
            host_fid=host_fid,
            target="rsvps",
            dry_run=False,
            campaign="space_started_rsvp",
            bypass_preferences=False,
        )

    async def admin_notify_room_live(
        self,
        room_id: str,
        target: Literal["rsvps", "all_active"],
        dry_run: bool,
    ) -> RoomLiveNotifyResponse:
        """Admin-triggered live-room broadcast.

        ``all_active`` intentionally bypasses ``space_started_enabled`` for the
        current low-user-count phase and sends to every active native/miniapp
        notification target.
        """
        try:
            room_uuid = uuid.UUID(room_id)
        except ValueError:
            from fastapi import HTTPException

            raise HTTPException(status_code=404, detail="Room not found")

        result = await self.db.execute(select(Room).where(Room.id == room_uuid))
        room = result.scalar_one_or_none()
        if room is None:
            from fastapi import HTTPException

            raise HTTPException(status_code=404, detail="Room not found")
        if room.status != "active":
            from fastapi import HTTPException

            raise HTTPException(status_code=400, detail="Room must be active")

        campaign = f"admin_live_{target}"
        bypass_preferences = target == "all_active"
        if bypass_preferences:
            logger.info(
                "Admin live-room broadcast bypassing space_started_enabled "
                "room_id=%s target=%s dry_run=%s",
                room_id,
                target,
                dry_run,
            )

        return await self._notify_room_live(
            room_id=room_id,
            room_uuid=room.id,
            title=room.title,
            host_fid=room.host_fid,
            target=target,
            dry_run=dry_run,
            campaign=campaign,
            bypass_preferences=bypass_preferences,
        )

    async def _notify_room_live(
        self,
        room_id: str,
        room_uuid,
        title: str,
        host_fid: int,
        target: Literal["rsvps", "all_active"],
        dry_run: bool,
        campaign: str,
        bypass_preferences: bool,
    ) -> RoomLiveNotifyResponse:
        if target == "all_active":
            candidate_fids = await self._active_reachable_fids()
        else:
            candidate_fids = await self._rsvp_fids(room_uuid)

        summary = RoomLiveNotifyResponse(
            room_id=room_id,
            target=target,
            dry_run=dry_run,
            campaign=campaign,
            users_considered=len(candidate_fids),
            users_eligible=0,
            users_sent=0,
            preference_bypass=bypass_preferences,
        )
        message_title = "Space is Live"
        message_body = f'"{title}" is now live — join now!'
        data = {"type": "space_live", "url": f"/space/{room_id}"}

        for target_fid in candidate_fids:
            if target != "all_active" and target_fid == host_fid:
                summary.users_skipped_self += 1
                continue
            if not bypass_preferences and not await self.is_enabled(
                target_fid, "space_started"
            ):
                summary.users_skipped_preferences += 1
                continue

            has_native = await self._has_native_target(target_fid)
            has_miniapp = await self._has_miniapp_target(target_fid)
            if (
                has_miniapp
                and not bypass_preferences
                and not await self.is_enabled(target_fid, "miniapp")
            ):
                has_miniapp = False
            if not has_native and not has_miniapp:
                continue

            summary.users_eligible += 1
            if dry_run:
                summary.native_targets += 1 if has_native else 0
                summary.miniapp_targets += 1 if has_miniapp else 0
                continue
            if not await self._mark_delivery_once(room_id, campaign, target_fid):
                summary.users_skipped_idempotent += 1
                continue

            sent_any = False
            if has_native:
                await self.send_push(
                    fid=target_fid,
                    title=message_title,
                    body=message_body,
                    data=data,
                )
                summary.native_targets += 1
                sent_any = True
            if has_miniapp:
                sent_any = (
                    await self._send_miniapp_notification(
                        fid=target_fid,
                        title=message_title,
                        body=message_body,
                        target_url=f"{JUKE_WEB_BASE_URL}/space/{room_id}",
                        notification_id=f"{campaign}:{room_id}:{target_fid}",
                    )
                    or sent_any
                )
                summary.miniapp_targets += 1
            if sent_any:
                summary.users_sent += 1

        return summary

    # ------------------------------------------------------------------
    # Neynar webhook event handling
    # ------------------------------------------------------------------

    async def handle_notification_event(self, event_type: str, payload: dict) -> None:
        """Process an incoming Neynar webhook event and send push notifications."""
        logger.info("handle_notification_event: type=%s", event_type)

        # Drop the entire event if the actor is flagged as probable spam.
        # Otherwise the user receives a push, taps it, and finds the cast hidden
        # by feed/thread filtering — a confusing dead end. SpamService is
        # Redis-cached so this is a hot-path-safe check.
        actor_fid_check, actor_check = _extract_actor(event_type, payload)
        if actor_fid_check is not None:
            spam_service = SpamService(self.db, self.redis)
            if await spam_service.is_spam(actor_fid_check, actor_check):
                logger.info(
                    "Skipping %s push: actor fid=%s flagged as spam",
                    event_type,
                    actor_fid_check,
                )
                return

        target_fid: int | None = None
        title = ""
        body = ""
        data: dict = {}
        notification_type = ""
        actor_pfp_url: str | None = None

        if event_type == "cast.created":
            cast_data = payload.get("data", {})
            parent_author_fid = cast_data.get("parent_author", {}).get("fid")
            author = cast_data.get("author", {})
            author_name = author.get("display_name") or author.get(
                "username", "Someone"
            )
            actor_pfp_url = author.get("pfp_url") or await self._resolve_pfp_url(
                author.get("fid")
            )
            cast_hash = cast_data.get("hash", "")

            # Build a thread-aware URL so the client opens the full conversation
            # with the triggering cast focused. Mirrors NotificationItem logic.
            thread_hash = (
                cast_data.get("thread_hash")
                or cast_data.get("parent_hash")
                or cast_hash
            )
            if thread_hash and thread_hash != cast_hash:
                # Open the triggering reply itself so replies deeper than the
                # client's fetch threshold cannot be buried/missing. The root
                # remains available through an explicit context link.
                cast_url = f"/cast/{cast_hash}?contextHash={thread_hash}"
            else:
                cast_url = f"/cast/{cast_hash}"
            cast_route_data = {
                "cast_hash": cast_hash,
                "thread_hash": thread_hash or cast_hash,
                "focus_hash": cast_hash,
            }

            # Check for mentions
            mentioned_fids = [
                m.get("fid")
                for m in cast_data.get("mentioned_profiles", [])
                if m.get("fid")
            ]

            actor_fid = author.get("fid")
            reply_target_fids: list[int] = []
            if isinstance(parent_author_fid, int) and parent_author_fid > 0:
                reply_target_fids.append(parent_author_fid)

            # Replies to replies should also reach the original poster. Only
            # perform the lookup when the immediate parent is not the root.
            parent_hash = cast_data.get("parent_hash")
            if (
                reply_target_fids
                and thread_hash
                and parent_hash
                and thread_hash != parent_hash
            ):
                root_author_fid = await self._resolve_thread_root_author_fid(
                    thread_hash
                )
                if (
                    root_author_fid is not None
                    and root_author_fid not in reply_target_fids
                ):
                    reply_target_fids.append(root_author_fid)

            preview = _preview(cast_data.get("text", ""))
            reply_body = (
                f"{author_name}: {preview}"
                if preview
                else f"{author_name} replied in your conversation"
            )
            reply_data = {
                "type": "reply",
                "url": cast_url,
                **cast_route_data,
            }
            for reply_target_fid in reply_target_fids:
                await self._send_event_push_if_eligible(
                    target_fid=reply_target_fid,
                    actor_fid=actor_fid,
                    notification_type="reply",
                    title="New Reply",
                    body=reply_body,
                    data=reply_data,
                    image_url=actor_pfp_url,
                )

            # Send mention notifications (separate from reply)
            for mfid in mentioned_fids:
                # One event should not produce both reply + mention pushes for
                # the same person.
                if mfid in reply_target_fids:
                    continue
                mention_body = (
                    f"{author_name} mentioned you: {preview}"
                    if preview
                    else f"{author_name} mentioned you in a cast"
                )
                await self._send_event_push_if_eligible(
                    target_fid=mfid,
                    actor_fid=actor_fid,
                    notification_type="mention",
                    title="You were mentioned",
                    body=mention_body,
                    data={
                        "type": "mention",
                        "url": cast_url,
                        **cast_route_data,
                    },
                    image_url=actor_pfp_url,
                )

            # cast.created may fan out to parent + root + mentions, so it is
            # fully handled here rather than falling through the single-target
            # delivery path used by reactions/follows.
            return

        elif event_type == "reaction.created":
            reaction_data = payload.get("data", {})
            reaction_type = reaction_data.get("reaction_type")
            cast = reaction_data.get("cast", {})
            cast_author = cast.get("author")
            logger.debug(
                "reaction cast.author type=%s value=%s",
                type(cast_author).__name__,
                cast_author,
            )
            target_fid = (
                cast_author.get("fid") if isinstance(cast_author, dict) else cast_author
            )
            reactor = reaction_data.get("user", {})
            reactor_name = reactor.get("display_name") or reactor.get(
                "username", "Someone"
            )
            actor_pfp_url = reactor.get("pfp_url") or await self._resolve_pfp_url(
                reactor.get("fid")
            )
            cast_hash = cast.get("hash", "")

            cast_preview = _preview(cast.get("text", ""))
            if reaction_type in ("like", 1):
                notification_type = "likes"
                title = "New Like"
                body = (
                    f"{reactor_name} liked: {cast_preview}"
                    if cast_preview
                    else f"{reactor_name} liked your cast"
                )
                data = {
                    "type": "like",
                    "url": f"/cast/{cast_hash}",
                    "cast_hash": cast_hash,
                }
            elif reaction_type in ("recast", 2):
                notification_type = "recasts"
                title = "New Recast"
                body = (
                    f"{reactor_name} recasted: {cast_preview}"
                    if cast_preview
                    else f"{reactor_name} recasted your cast"
                )
                data = {
                    "type": "recast",
                    "url": f"/cast/{cast_hash}",
                    "cast_hash": cast_hash,
                }

        elif event_type == "follow.created":
            follow_data = payload.get("data", {})
            target_fid = follow_data.get("user", {}).get("fid")
            follower = follow_data.get("follower", {})
            follower_name = follower.get("display_name") or follower.get(
                "username", "Someone"
            )
            follower_fid = follower.get("fid")
            actor_pfp_url = follower.get("pfp_url") or await self._resolve_pfp_url(
                follower_fid
            )

            notification_type = "follows"
            title = "New Follower"
            body = f"{follower_name} followed you"
            data = {
                "type": "follow",
                "url": f"/profile/{follower_fid}",
                "profile_fid": str(follower_fid),
            }

        if not target_fid or not notification_type:
            logger.info(
                "Skipping event %s: no target_fid or notification_type", event_type
            )
            return

        # Don't notify yourself
        actor_fid = actor_fid_check
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
            logger.info(
                "Skipping fid=%s: %s notifications disabled",
                target_fid,
                notification_type,
            )
            return

        logger.info(
            "Sending %s push to fid=%s from fid=%s",
            notification_type,
            target_fid,
            actor_fid,
        )
        await self.send_push(
            fid=target_fid,
            title=title,
            body=body,
            data=data,
            image_url=actor_pfp_url,
        )

    # ------------------------------------------------------------------
    # Space event push notifications (called from room_service)
    # ------------------------------------------------------------------

    async def notify_hand_raised(
        self,
        host_fid: int,
        raiser_name: str,
        room_id: str,
        raiser_pfp_url: str | None = None,
        raiser_fid: int | None = None,
    ) -> None:
        """Notify the space host that someone raised their hand."""
        is_active = await self.redis.sismember(REDIS_ACTIVE_FIDS_KEY, str(host_fid))
        if not is_active:
            return
        if not await self.is_enabled(host_fid, "hand_raised"):
            return
        data: dict[str, Any] = {"type": "hand_raised", "url": f"/space/{room_id}"}
        if raiser_fid is not None:
            data["raiser_fid"] = raiser_fid
        await self.send_push(
            fid=host_fid,
            title="Hand Raised",
            body=f"{raiser_name} wants to speak",
            data=data,
            image_url=raiser_pfp_url,
        )

    async def notify_invited_to_speak(
        self,
        target_fid: int,
        inviter_name: str,
        room_id: str,
        room_title: str,
        inviter_pfp_url: str | None = None,
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
            body=f'{inviter_name} invited you to speak in "{room_title}"',
            data={"type": "space_invite", "url": f"/space/{room_id}"},
            image_url=inviter_pfp_url,
        )

    # ------------------------------------------------------------------
    # Hypersnap webhook target_fids sync
    # ------------------------------------------------------------------

    async def _sync_webhook_fids(self) -> None:
        """Point the Hypersnap push webhooks at the current active FID set."""
        from app.services.hypersnap_webhook_service import sync_push_webhooks

        raw_fids = await self.redis.smembers(REDIS_ACTIVE_FIDS_KEY)
        await sync_push_webhooks([int(f) for f in raw_fids])
