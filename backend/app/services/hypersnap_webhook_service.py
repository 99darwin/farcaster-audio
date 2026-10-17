"""Juke's Hypersnap webhooks: provisioning, filter sync, payload normalization.

Juke owns a bounded set of webhooks on the app FID (at most the 25-per-FID
cap), identified by name:

* ``juke-room-replies`` — ONE global webhook for replies to live rooms'
  announcement casts. Its ``parent_hashes`` filter is re-synced from the DB
  whenever a room starts or ends (replaces Neynar's webhook-per-room design,
  which broke past 25 live rooms).
* ``juke-push-*`` — push-notification streams filtered to active Juke FIDs.
  Hypersnap ANDs filter fields, so cast replies and cast mentions need two
  webhooks (Neynar OR'd them in one). A filter array holds at most 1024
  entries, so each stream is sharded across up to
  :data:`PUSH_SHARDS_PER_STREAM` webhooks (``juke-push-follow``,
  ``juke-push-follow-1``, ...). Shards of a stream share one secret env var
  (comma-separated values).

Hypersnap treats an empty filter array as "no restriction", so an empty set
is never sent: a sentinel that cannot match is used instead.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import re
import secrets
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

from app.clients import hypersnap
from app.clients.hypersnap_webhooks import (
    MAX_FILTER_ENTRIES,
    MAX_WEBHOOKS_PER_FID,
    HypersnapWebhookClient,
    active_secret,
    app_webhook_signer,
    is_app_signer_configured,
    parse_secrets,
)
from app.config import settings
from app.models.room import Room

logger = logging.getLogger(__name__)

ROOM_REPLY_ROUTE = "/v1/webhooks/hypersnap"
NOTIFICATIONS_ROUTE = "/v1/webhooks/hypersnap/notifications"

EVENT_CAST_CREATED = "cast.created"
EVENT_REACTION_CREATED = "reaction.created"
EVENT_FOLLOW_CREATED = "follow.created"

# FID 0 is never registered and the zero hash is never a real cast, so these
# keep a filter non-empty (= restrictive) without ever matching.
SENTINEL_FID = 0
SENTINEL_CAST_HASH = "0x" + "00" * 20
_CAST_HASH_RE = re.compile(r"^(0x)?[0-9a-fA-F]{40}$")

# Coalesced room-reply sync: callers mark the set dirty; one lock holder
# (across workers) drains it, so concurrent starts/ends never lose a hash.
ROOM_SYNC_PENDING_KEY = "hypersnap:webhook:room_replies:pending"
ROOM_SYNC_LOCK_KEY = "hypersnap:webhook:room_replies:lock"
ROOM_SYNC_LOCK_TTL_SECONDS = 60
ROOM_SYNC_PENDING_TTL_SECONDS = 300


@dataclass(frozen=True)
class ManagedWebhook:
    """One Juke-owned Hypersnap webhook."""

    name: str
    route: str
    secret_setting: str
    # Event type delivered by this webhook (the envelope's ``type``).
    event_type: str
    # Builds the subscription from the current FID / hash set.
    build_subscription: Callable[[list[Any]], dict[str, Any]]
    # Never-matching filter value (an empty array would match everything).
    sentinel: Any

    @property
    def url(self) -> str:
        return settings.API_BASE_URL.rstrip("/") + self.route

    def secrets(self) -> list[str]:
        return parse_secrets(getattr(settings, self.secret_setting, "") or "")


def _cast_filter(key: str) -> Callable[[list[Any]], dict[str, Any]]:
    return lambda values: {"cast_created": {key: values}}


ROOM_REPLY_WEBHOOK = ManagedWebhook(
    name="juke-room-replies",
    route=ROOM_REPLY_ROUTE,
    secret_setting="HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY",
    event_type=EVENT_CAST_CREATED,
    build_subscription=_cast_filter("parent_hashes"),
    sentinel=SENTINEL_CAST_HASH,
)
PUSH_WEBHOOKS: tuple[ManagedWebhook, ...] = (
    ManagedWebhook(
        name="juke-push-cast-reply",
        route=NOTIFICATIONS_ROUTE,
        secret_setting="HYPERSNAP_WEBHOOK_SECRET_CAST",
        event_type=EVENT_CAST_CREATED,
        build_subscription=_cast_filter("parent_author_fids"),
        sentinel=SENTINEL_FID,
    ),
    ManagedWebhook(
        name="juke-push-cast-mention",
        route=NOTIFICATIONS_ROUTE,
        secret_setting="HYPERSNAP_WEBHOOK_SECRET_MENTION",
        event_type=EVENT_CAST_CREATED,
        build_subscription=_cast_filter("mentioned_fids"),
        sentinel=SENTINEL_FID,
    ),
    ManagedWebhook(
        name="juke-push-reaction",
        route=NOTIFICATIONS_ROUTE,
        secret_setting="HYPERSNAP_WEBHOOK_SECRET_REACTION",
        event_type=EVENT_REACTION_CREATED,
        build_subscription=lambda fids: {"reaction_created": {"target_fids": fids}},
        sentinel=SENTINEL_FID,
    ),
    ManagedWebhook(
        name="juke-push-follow",
        route=NOTIFICATIONS_ROUTE,
        secret_setting="HYPERSNAP_WEBHOOK_SECRET_FOLLOW",
        event_type=EVENT_FOLLOW_CREATED,
        build_subscription=lambda fids: {"follow_created": {"target_fids": fids}},
        sentinel=SENTINEL_FID,
    ),
)
ALL_WEBHOOKS: tuple[ManagedWebhook, ...] = (ROOM_REPLY_WEBHOOK, *PUSH_WEBHOOKS)

# The per-FID cap minus the room-reply webhook, split evenly across streams.
PUSH_SHARDS_PER_STREAM = (MAX_WEBHOOKS_PER_FID - 1) // len(PUSH_WEBHOOKS)
PUSH_FID_CAPACITY = PUSH_SHARDS_PER_STREAM * MAX_FILTER_ENTRIES
# Setup provisions enough shards for this many more FIDs before a re-run.
PUSH_SHARD_HEADROOM_FIDS = 256
# Webhook ids are re-listed this often so shards added elsewhere are seen.
WEBHOOK_ID_CACHE_TTL_SECONDS = 300


def shard_name(webhook: ManagedWebhook, index: int) -> str:
    """Shard 0 keeps the stream's base name; later shards get ``-<index>``."""
    return webhook.name if index == 0 else f"{webhook.name}-{index}"


def shard_names(webhook: ManagedWebhook) -> list[str]:
    return [shard_name(webhook, i) for i in range(PUSH_SHARDS_PER_STREAM)]


MANAGED_WEBHOOK_NAMES = frozenset(
    [ROOM_REPLY_WEBHOOK.name, *(n for w in PUSH_WEBHOOKS for n in shard_names(w))]
)


class WebhookCapacityError(Exception):
    """Provisioning would exceed the per-FID webhook cap."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def normalize_cast_hash(value: object) -> str | None:
    """Canonical ``0x`` + lowercase 40-hex form, or ``None`` if malformed."""
    if not isinstance(value, str) or not _CAST_HASH_RE.match(value):
        return None
    return "0x" + value.lower().removeprefix("0x")


def _capped(values: Sequence[Any], label: str, sentinel: Any) -> list[Any]:
    if not values:
        return [sentinel]
    if len(values) > MAX_FILTER_ENTRIES:
        logger.error(
            "Hypersnap %s filter has %d entries; truncating to %d",
            label,
            len(values),
            MAX_FILTER_ENTRIES,
        )
    return list(values[:MAX_FILTER_ENTRIES])


def room_reply_subscription(cast_hashes: Sequence[str]) -> dict[str, Any]:
    hashes = sorted({h for h in map(normalize_cast_hash, cast_hashes) if h})
    capped = _capped(hashes, "room parent_hashes", ROOM_REPLY_WEBHOOK.sentinel)
    return ROOM_REPLY_WEBHOOK.build_subscription(capped)


def push_subscription(webhook: ManagedWebhook, fids: Sequence[int]) -> dict:
    unique = sorted({fid for fid in fids if fid > 0})
    return webhook.build_subscription(_capped(unique, webhook.name, webhook.sentinel))


def shards_needed(fid_count: int, headroom: int = 0) -> int:
    """Shards per push stream for ``fid_count`` FIDs (1..max per stream)."""
    needed = math.ceil((fid_count + headroom) / MAX_FILTER_ENTRIES)
    return min(max(needed, 1), PUSH_SHARDS_PER_STREAM)


def _shard_order(fid: int) -> bytes:
    return hashlib.sha256(fid.to_bytes(8, "big")).digest()


def partition_fids(fids: Iterable[int], shard_count: int) -> list[list[int]]:
    """Split FIDs into ``shard_count`` filters of at most 1024 entries.

    FIDs are placed in hash order, so if they exceed total capacity the
    unsubscribed overflow is spread pseudo-randomly rather than always
    being the newest (highest) FIDs.
    """
    ordered = sorted({fid for fid in fids if fid > 0}, key=_shard_order)
    return [
        sorted(ordered[i * MAX_FILTER_ENTRIES : (i + 1) * MAX_FILTER_ENTRIES])
        for i in range(shard_count)
    ]


# Managed webhook ids by name, from one signed list call, cached per process.
# Re-listed after the TTL, when a base webhook is missing, or after a 404.
_webhook_ids: dict[str, str] = {}
_webhook_ids_listed_at: float | None = None


async def _resolve_webhook_ids(client: HypersnapWebhookClient) -> dict[str, str]:
    global _webhook_ids_listed_at
    is_stale = (
        _webhook_ids_listed_at is None
        or time.monotonic() - _webhook_ids_listed_at > WEBHOOK_ID_CACHE_TTL_SECONDS
    )
    if is_stale or any(w.name not in _webhook_ids for w in ALL_WEBHOOKS):
        records = await client.list()
        _webhook_ids.clear()
        for record in records:
            title = record.get("title")
            if title in MANAGED_WEBHOOK_NAMES and record.get("webhook_id"):
                _webhook_ids[title] = str(record["webhook_id"])
        _webhook_ids_listed_at = time.monotonic()
    return _webhook_ids


def _warn_not_provisioned(name: str) -> None:
    logger.warning(
        "Hypersnap webhook %s is not provisioned; run POST /v1/admin/setup-webhooks",
        name,
    )


async def _update_subscription(
    client: HypersnapWebhookClient,
    name: str,
    webhook_id: str,
    subscription: dict[str, Any],
) -> None:
    try:
        await client.update(webhook_id, subscription=subscription, active=True)
    except hypersnap.HypersnapNotFound:
        _webhook_ids.pop(name, None)
        raise


def _default_client() -> HypersnapWebhookClient | None:
    if not is_app_signer_configured():
        logger.debug("App custody signer not configured; skipping webhook sync")
        return None
    return HypersnapWebhookClient(app_webhook_signer())


# ---------------------------------------------------------------------------
# Room-reply webhook sync
# ---------------------------------------------------------------------------


async def active_room_cast_hashes(db) -> list[str]:
    """Announcement cast hashes of live Juke-hosted rooms (DB is truth)."""
    result = await db.execute(
        select(Room.cast_hash).where(
            Room.status == "active",
            Room.cast_hash.is_not(None),
            Room.is_farcaster_native.is_(False),
        )
    )
    return [row for row in result.scalars().all() if row]


async def push_room_reply_hashes(
    db, client: HypersnapWebhookClient | None = None
) -> bool:
    """Replace the global webhook's ``parent_hashes`` with live rooms' hashes."""
    client = client or _default_client()
    if client is None:
        return False
    hashes = await active_room_cast_hashes(db)
    name = ROOM_REPLY_WEBHOOK.name
    webhook_id = (await _resolve_webhook_ids(client)).get(name)
    if webhook_id is None:
        _warn_not_provisioned(name)
        return False
    await _update_subscription(
        client, name, webhook_id, room_reply_subscription(hashes)
    )
    logger.info("Synced room-reply webhook with %d parent hashes", len(hashes))
    return True


async def _redis_value_equals(redis, key: str, expected: str) -> bool:
    value = await redis.get(key)
    if isinstance(value, bytes):
        value = value.decode()
    return value == expected


async def sync_room_reply_webhook(
    redis,
    session_factory: Callable[[], Any] | None = None,
    client: HypersnapWebhookClient | None = None,
) -> None:
    """Coalesced, cross-worker-safe room-reply sync. Never raises.

    Marks the hash set dirty, then drains it under a Redis lock. A caller
    that loses the lock returns immediately: the holder re-checks the dirty
    flag after each pass (and once more after releasing) so no change is lost.
    """
    if client is None and not is_app_signer_configured():
        return
    if session_factory is None:
        from app.database import async_session as session_factory
    try:
        await redis.set(ROOM_SYNC_PENDING_KEY, "1", ex=ROOM_SYNC_PENDING_TTL_SECONDS)
        while await redis.exists(ROOM_SYNC_PENDING_KEY):
            token = secrets.token_hex(16)
            acquired = await redis.set(
                ROOM_SYNC_LOCK_KEY, token, nx=True, ex=ROOM_SYNC_LOCK_TTL_SECONDS
            )
            if not acquired:
                return
            try:
                while await redis.delete(ROOM_SYNC_PENDING_KEY):
                    async with session_factory() as db:
                        await push_room_reply_hashes(db, client)
            finally:
                if await _redis_value_equals(redis, ROOM_SYNC_LOCK_KEY, token):
                    await redis.delete(ROOM_SYNC_LOCK_KEY)
    except Exception:
        logger.exception("Room-reply webhook sync failed")


_background_tasks: set[asyncio.Task[None]] = set()


def schedule_room_reply_sync(redis) -> None:
    """Fire-and-forget :func:`sync_room_reply_webhook` (room start/end hook).

    No-op when the app custody signer is not configured (tests, local dev).
    """
    if not is_app_signer_configured():
        return
    task = asyncio.create_task(sync_room_reply_webhook(redis))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# ---------------------------------------------------------------------------
# Push webhook sync
# ---------------------------------------------------------------------------


def _report_capacity(webhook: ManagedWebhook, fid_count: int, shards: int) -> None:
    """Log loudly when FIDs overflow the provisioned shards (they get no push)."""
    capacity = shards * MAX_FILTER_ENTRIES
    can_grow = shards < PUSH_SHARDS_PER_STREAM
    if fid_count <= capacity:
        if can_grow and fid_count > capacity - PUSH_SHARD_HEADROOM_FIDS:
            logger.warning(
                "%s: %d FIDs in %d shard(s) (capacity %d); run POST "
                "/v1/admin/setup-webhooks to add a shard",
                webhook.name,
                fid_count,
                shards,
                capacity,
            )
        return
    remedy = (
        "run POST /v1/admin/setup-webhooks and add the new shard secrets"
        if can_grow
        else f"hard limit of {PUSH_FID_CAPACITY} FIDs per stream reached"
    )
    logger.error(
        "%s: %d FIDs exceed %d provisioned shard(s); %d FIDs get no pushes; %s",
        webhook.name,
        fid_count,
        shards,
        fid_count - capacity,
        remedy,
    )


async def _sync_push_stream(
    client: HypersnapWebhookClient,
    webhook: ManagedWebhook,
    fids: set[int],
    ids: Mapping[str, str],
) -> None:
    names = [name for name in shard_names(webhook) if name in ids]
    if not names:
        _warn_not_provisioned(webhook.name)
        return
    _report_capacity(webhook, len(fids), len(names))
    for name, shard_fids in zip(names, partition_fids(fids, len(names))):
        try:
            await _update_subscription(
                client, name, ids[name], push_subscription(webhook, shard_fids)
            )
            logger.info("Synced %s with %d target FIDs", name, len(shard_fids))
        except hypersnap.HypersnapError as exc:
            logger.error(
                "Hypersnap webhook sync failed for %s: %s %s",
                name,
                exc.status_code,
                exc.body or exc,
            )


async def sync_push_webhooks(
    fids: Iterable[int], client: HypersnapWebhookClient | None = None
) -> None:
    """Spread ``fids`` over every push stream's shards. Never raises."""
    client = client or _default_client()
    if client is None:
        return
    try:
        ids = dict(await _resolve_webhook_ids(client))
    except hypersnap.HypersnapError as exc:
        logger.error("Hypersnap webhook list failed: %s %s", exc.status_code, exc)
        return
    unique = {fid for fid in fids if fid > 0}
    for webhook in PUSH_WEBHOOKS:
        await _sync_push_stream(client, webhook, unique, ids)


# ---------------------------------------------------------------------------
# Provisioning (admin)
# ---------------------------------------------------------------------------


def _wanted_webhooks(
    push_fid_count: int, existing: Mapping[str, Any]
) -> list[tuple[ManagedWebhook, str]]:
    """Room-reply webhook plus enough push shards (and any already present)."""
    shard_count = shards_needed(push_fid_count, PUSH_SHARD_HEADROOM_FIDS)
    wanted = [(ROOM_REPLY_WEBHOOK, ROOM_REPLY_WEBHOOK.name)]
    for webhook in PUSH_WEBHOOKS:
        wanted += [
            (webhook, name)
            for index, name in enumerate(shard_names(webhook))
            if index < shard_count or name in existing
        ]
    return wanted


async def ensure_webhooks(
    client: HypersnapWebhookClient | None = None,
    *,
    push_fid_count: int = 0,
) -> list[dict[str, Any]]:
    """Create any missing Juke webhook (idempotent, by name).

    Provisions enough shards per push stream for ``push_fid_count`` FIDs plus
    :data:`PUSH_SHARD_HEADROOM_FIDS`. New webhooks start on the never-matching
    sentinel filter; call the sync functions afterwards to load the real FID /
    hash sets. Returns, per webhook, its id, whether it was created, the env
    var for its secret and the current signing secret (admin-only output).
    """
    global _webhook_ids_listed_at
    client = client or HypersnapWebhookClient(app_webhook_signer())
    existing = {
        record.get("title"): record
        for record in await client.list()
        if record.get("webhook_id")
    }
    wanted = _wanted_webhooks(push_fid_count, existing)
    missing = [name for _, name in wanted if name not in existing]
    if len(existing) + len(missing) > MAX_WEBHOOKS_PER_FID:
        raise WebhookCapacityError(
            f"FID {client.owner_fid} holds {len(existing)} webhooks; creating "
            f"{len(missing)} more would exceed the cap of {MAX_WEBHOOKS_PER_FID}"
        )

    results = []
    for webhook, name in wanted:
        record = existing.get(name)
        created = record is None
        if created:
            record = await client.create(
                name=name,
                url=webhook.url,
                subscription=webhook.build_subscription([webhook.sentinel]),
                description="Managed by the Juke backend",
            )
            logger.info("Created Hypersnap webhook %s", name)
        elif record.get("target_url") != webhook.url:
            record = await client.update(str(record["webhook_id"]), url=webhook.url)
        results.append(
            {
                "name": name,
                "webhook_id": str(record["webhook_id"]),
                "created": created,
                "secret_var": webhook.secret_setting,
                "secret": active_secret(record),
            }
        )
    # ``wanted`` covers every managed webhook on the FID: the cache is fresh.
    _webhook_ids.clear()
    _webhook_ids.update({r["name"]: r["webhook_id"] for r in results})
    _webhook_ids_listed_at = time.monotonic()
    return results


def secret_env(results: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """Comma-joined secrets per env var (shards of a stream share one var)."""
    joined: dict[str, list[str]] = {}
    for result in results:
        values = joined.setdefault(result["secret_var"], [])
        if result["secret"] and result["secret"] not in values:
            values.append(result["secret"])
    return {var: ",".join(values) for var, values in joined.items()}


# ---------------------------------------------------------------------------
# Delivery payloads → push_service's (Neynar-era) payload shape
# ---------------------------------------------------------------------------


def secrets_by_event_type() -> list[tuple[str, list[str]]]:
    """(event type, accepted secrets) for each push webhook."""
    return [(w.event_type, w.secrets()) for w in PUSH_WEBHOOKS]


def cast_of(data: Mapping[str, Any]) -> Mapping[str, Any]:
    """``cast.created`` data is the cast itself (node source) or wraps it
    under ``cast`` (docs); accept both."""
    nested = data.get("cast")
    return nested if isinstance(nested, Mapping) else data


def dedupe_key(event_type: str, data: Mapping[str, Any]) -> str | None:
    """Natural key for at-least-once dedupe (also collapses reply+mention)."""
    if event_type == EVENT_CAST_CREATED:
        cast_hash = normalize_cast_hash(cast_of(data).get("hash"))
        return f"cast:{cast_hash}" if cast_hash else None
    if event_type == EVENT_REACTION_CREATED:
        target = data.get("target") or data.get("cast") or {}
        reactor = data.get("reactor_fid") or (data.get("user") or {}).get("fid")
        cast_hash = normalize_cast_hash(target.get("hash"))
        if reactor and cast_hash:
            return f"reaction:{reactor}:{cast_hash}:{data.get('reaction_type')}"
        return None
    if event_type == EVENT_FOLLOW_CREATED:
        follower = data.get("follower_fid") or (data.get("follower") or {}).get("fid")
        target = data.get("target_fid") or (data.get("target") or {}).get("fid")
        return f"follow:{follower}:{target}" if follower and target else None
    return None


async def _fetch_users(fids: Sequence[int]) -> dict[int, dict[str, Any]]:
    """Best-effort profile lookup; webhook payloads carry stub users only."""
    wanted = sorted({fid for fid in fids if isinstance(fid, int) and fid > 0})
    if not wanted:
        return {}
    try:
        data = await hypersnap.get("/user/bulk", {"fids": ",".join(map(str, wanted))})
    except hypersnap.HypersnapError as exc:
        logger.warning("Hypersnap user lookup for webhook failed: %s", exc)
        return {}
    return {
        user["fid"]: user
        for user in data.get("users") or []
        if isinstance(user, dict) and isinstance(user.get("fid"), int)
    }


async def _fetch_mention_text(cast: Mapping[str, Any]) -> str | None:
    """Cast text with ``@username`` mentions inlined, or ``None``.

    Webhook casts carry mentioned fids but not their positions, so the text
    has the handles stripped; the ``/v2`` read restores them.
    """
    if not cast.get("mentioned_profiles"):
        return None
    cast_hash = normalize_cast_hash(cast.get("hash"))
    if cast_hash is None:
        return None
    try:
        data = await hypersnap.get("/cast", {"identifier": cast_hash, "type": "hash"})
    except hypersnap.HypersnapError as exc:
        logger.warning("Hypersnap cast lookup for webhook failed: %s", exc)
        return None
    fetched = data.get("cast")
    if not isinstance(fetched, Mapping):
        return None
    if normalize_cast_hash(fetched.get("hash")) != cast_hash:
        return None
    text = fetched.get("text")
    return text if isinstance(text, str) else None


def _user(fid: Any, profiles: Mapping[int, dict[str, Any]]) -> dict[str, Any]:
    return dict(profiles.get(fid) or {"fid": fid})


async def to_push_payload(
    event_type: str, payload: Mapping[str, Any]
) -> dict[str, Any] | None:
    """Translate a Hypersnap delivery into what ``PushService`` consumes.

    Returns ``None`` for events push does not handle. Actor profiles are
    enriched from ``/user/bulk`` because the node only sends stub users, and
    text with mentions is re-read so the stripped handles are restored.
    """
    data = payload.get("data")
    if not isinstance(data, Mapping):
        return None

    if event_type == EVENT_CAST_CREATED:
        cast = dict(cast_of(data))
        author_fid = (cast.get("author") or {}).get("fid")
        profiles, text = await asyncio.gather(
            _fetch_users([author_fid]), _fetch_mention_text(cast)
        )
        if author_fid in profiles:
            cast["author"] = _user(author_fid, profiles)
        if text is not None:
            cast["text"] = text
        return {"type": event_type, "data": cast}

    if event_type == EVENT_REACTION_CREATED:
        target = data.get("target") or {}
        reactor_fid = data.get("reactor_fid")
        if not isinstance(target, Mapping) or not reactor_fid:
            return None
        profiles = await _fetch_users([reactor_fid])
        return {
            "type": event_type,
            "data": {
                "reaction_type": data.get("reaction_type"),
                "user": _user(reactor_fid, profiles),
                "cast": {
                    "hash": target.get("hash", ""),
                    "author": {"fid": target.get("fid")},
                },
            },
        }

    if event_type == EVENT_FOLLOW_CREATED:
        follower_fid = data.get("follower_fid")
        target_fid = data.get("target_fid")
        if not follower_fid or not target_fid:
            return None
        profiles = await _fetch_users([follower_fid])
        return {
            "type": event_type,
            "data": {
                "follower": _user(follower_fid, profiles),
                "user": {"fid": target_fid},
            },
        }

    return None
