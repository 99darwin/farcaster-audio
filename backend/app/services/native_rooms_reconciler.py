"""Background reconciler for Farcaster-native audio rooms.

Stale-room cleanup loop for backend-orchestrated native rooms. When a
host creates a native room via ``POST /v1/rooms/native`` then never
joins / never taps End, the Juke ``Room`` row stays ``status='active'``
forever — and the row sits at the top of the discovery rail with zero
participants. The upstream ``client.farcaster.xyz`` API, meanwhile,
GC's the room after a host-presence window expires; once it falls off
the upstream ``GET /v1/audio-rooms`` list it'll never come back.

This service periodically (default: every 60s) reconciles the Juke
active-rooms registry against the upstream live list and ends any
native room whose upstream counterpart is gone. Belt-and-braces with
the per-room TTL fallback in :py:mod:`app.routers.rooms` (which
expires Redis active-room markers after ~4 hours).

Operational guarantees:

* Skips silently if :py:class:`FarcasterSpacesService` is unconfigured
  (the service-FID bearer is absent). Reconciliation has no fallback
  when we can't read the upstream — better to leave rooms in place
  than to drop them based on a stale local view.
* Honors a ``propagation_grace_seconds`` window so rooms that JUST
  got created (and may not have propagated to the upstream's
  ``GET /v1/audio-rooms`` index yet) aren't prematurely ended.
* On any unhandled exception during a pass, logs at ERROR with the
  exception type only (NEVER the bearer or full traceback in a way
  that captures locals) and returns whatever counts were accrued.
* The loop is idempotent — calling :py:meth:`start` again while
  running is a no-op; :py:meth:`stop` is safe to call multiple times
  including before :py:meth:`start`.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.room import Room
from app.schemas.farcaster_spaces import AudioRoom, FarcasterSpacesConfigError
from app.services.dev_webhook_service import dispatch as dispatch_dev_webhook
from app.services.farcaster_spaces_service import FarcasterSpacesService
from app.services.redis_service import RedisService

logger = logging.getLogger(__name__)

UPSTREAM_LIST_LIMIT = 200


class NativeRoomsReconciler:
    """Periodically syncs the Redis active-rooms set against upstream
    ``client.farcaster.xyz/v1/audio-rooms``. Drops native rooms that
    are no longer live there so they don't linger in the discovery
    rail.
    """

    def __init__(
        self,
        *,
        farcaster_spaces: FarcasterSpacesService,
        redis: RedisService,
        session_maker: async_sessionmaker[AsyncSession],
        recording_agent=None,
        interval_seconds: float = 60.0,
        propagation_grace_seconds: float = 300.0,
        scheduled_expiry_grace_seconds: float = 30 * 60.0,
    ) -> None:
        self._farcaster_spaces = farcaster_spaces
        self._redis = redis
        self._session_maker = session_maker
        # Optional — when wired, the reconciler force-stops any active
        # native recording before dropping a room whose upstream space has
        # ended. This is the ONLY path that catches a space ended from the
        # Farcaster app (Juke's LiveKit ``room_finished`` webhook never
        # fires for native rooms, since their audio lives on Farcaster's
        # LiveKit). Without it, the recording agent is orphaned.
        self._recording_agent = recording_agent
        self._interval_seconds = interval_seconds
        self._propagation_grace_seconds = propagation_grace_seconds
        self._scheduled_expiry_grace_seconds = scheduled_expiry_grace_seconds
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    # -----------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------

    async def start(self) -> None:
        """Start the periodic reconcile loop.

        Idempotent — calling again while the loop is already running is
        a no-op. The task is stored on the instance so :py:meth:`stop`
        can cancel it cleanly during app shutdown.
        """
        if self._task is not None and not self._task.done():
            return
        # Reset the stop signal in case this instance was previously
        # stopped and is being restarted.
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(
            self._run_forever(), name="native-rooms-reconciler"
        )

    async def stop(self) -> None:
        """Cancel the loop and await teardown.

        Safe to call multiple times and safe to call before
        :py:meth:`start`. Sets the stop flag first so the loop body
        exits cleanly at the next iteration boundary, then cancels the
        underlying task to abort any in-flight sleep.
        """
        self._stop_event.set()
        task = self._task
        if task is None:
            return
        if not task.done():
            task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            # Suppress — shutdown best-effort; failures are already
            # logged inside ``_run_forever``.
            pass
        self._task = None

    async def _run_forever(self) -> None:
        """Reconcile-then-sleep loop. Exits on ``stop()``."""
        while not self._stop_event.is_set():
            try:
                await self.reconcile_once()
            except Exception as exc:  # noqa: BLE001 — guard the loop
                # The pass-level guard inside ``reconcile_once`` should
                # have caught this, but defend in depth so the loop
                # never dies.
                logger.error(
                    "[native-reconciler] unhandled error: %s",
                    type(exc).__name__,
                )
            # Sleep with cancellation responsiveness — wait_for on the
            # stop event lets ``stop()`` interrupt the sleep without
            # using ``task.cancel()`` mid-pass.
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self._interval_seconds,
                )
            except asyncio.TimeoutError:
                continue

    # -----------------------------------------------------------------
    # Reconcile pass
    # -----------------------------------------------------------------

    async def reconcile_once(self) -> dict[str, int]:
        """Single reconcile pass.

        Returns ``{"checked": N, "dropped": M, "errors": E}`` for
        observability and tests. NEVER raises — all branches that could
        bubble are caught and translated into the ``errors`` counter.
        """
        counts = {"checked": 0, "dropped": 0, "errors": 0}

        # Skip silently when the service-FID bearer is missing. The
        # reconciler has no offline fallback — we MUST be able to read
        # the upstream live list to decide what to drop.
        try:
            upstream_rooms = await self._farcaster_spaces.list_live_rooms(
                limit=UPSTREAM_LIST_LIMIT
            )
        except FarcasterSpacesConfigError:
            logger.debug("[native-reconciler] skipped: spaces service unconfigured")
            return counts
        except Exception as exc:  # noqa: BLE001 — upstream may blip
            logger.error(
                "[native-reconciler] upstream list failed: %s",
                type(exc).__name__,
            )
            counts["errors"] = 1
            return counts

        upstream_live_ids: set[str] = {r.id for r in upstream_rooms if r.id}
        upstream_live_by_id = {r.id: r for r in upstream_rooms if r.id}

        # Pull active native rooms older than the propagation grace
        # window. Younger rows might just be slow to land in the
        # upstream index — give them a chance.
        cutoff = datetime.now(tz=timezone.utc) - timedelta(
            seconds=self._propagation_grace_seconds
        )
        scheduled_cutoff = datetime.now(tz=timezone.utc) - timedelta(
            seconds=self._scheduled_expiry_grace_seconds
        )
        try:
            async with self._session_maker() as db:
                rows_result = await db.execute(
                    select(Room).where(
                        Room.is_farcaster_native.is_(True),
                        or_(
                            and_(
                                Room.status == "active",
                                Room.started_at.is_not(None),
                                Room.started_at < cutoff,
                            ),
                            and_(
                                Room.status == "scheduled",
                                Room.scheduled_at.is_not(None),
                                Room.scheduled_at < scheduled_cutoff,
                            ),
                        ),
                    )
                )
                candidates = list(rows_result.scalars().all())
                counts["checked"] = len(candidates)

                for room in candidates:
                    farcaster_room_id = room.farcaster_room_id
                    if not farcaster_room_id:
                        # Defense-in-depth: a row marked native MUST
                        # carry the upstream id. If it doesn't we can't
                        # decide — log + skip rather than guessing.
                        logger.warning(
                            "[native-reconciler] native row missing "
                            "farcaster_room_id (room=%s)",
                            room.id,
                        )
                        counts["errors"] += 1
                        continue
                    if farcaster_room_id in upstream_live_ids:
                        # Authoritative live evidence also repairs a mirror
                        # that missed its scheduled→active transition.
                        if room.status == "scheduled":
                            await self._promote_scheduled_room(
                                db, room, upstream_live_by_id[farcaster_room_id]
                            )
                        continue

                    # Absent from the capped, eventually-consistent GLOBAL
                    # live index. That is NOT proof the room ended —
                    # Juke-orchestrated rooms aren't reliably present in
                    # that list. Confirm authoritatively with a per-room
                    # lookup before dropping. Only rooms that already
                    # failed the cheap global-list filter reach this
                    # branch, so the extra call fan-out is bounded to the
                    # (normally small) set of absent rooms per pass.
                    try:
                        room_state = await self._farcaster_spaces.get_room(
                            farcaster_room_id
                        )
                    except (
                        Exception
                    ) as exc:  # noqa: BLE001 — never drop on lookup error
                        # A lookup failure is ambiguous — treat it as a
                        # transient upstream blip and LEAVE the room in
                        # place rather than risk killing a live space.
                        logger.error(
                            "[native-reconciler] per-room lookup failed for "
                            "room=%s: %s — leaving in place",
                            room.id,
                            type(exc).__name__,
                        )
                        counts["errors"] += 1
                        continue

                    if getattr(room_state, "state", None) == "live":
                        if room.status == "scheduled":
                            await self._promote_scheduled_room(db, room, room_state)
                        continue

                    if not self._is_room_gone(room_state):
                        # Upstream confirms the room is still live/scheduled
                        # — this was a global-index gap, not an ended room.
                        continue

                    try:
                        await self._drop_room(db, room)
                        counts["dropped"] += 1
                    except Exception as exc:  # noqa: BLE001 — per-row guard
                        logger.error(
                            "[native-reconciler] drop failed for room=%s: " "%s",
                            room.id,
                            type(exc).__name__,
                        )
                        counts["errors"] += 1
        except Exception as exc:  # noqa: BLE001 — pass-level guard
            logger.error("[native-reconciler] pass error: %s", type(exc).__name__)
            counts["errors"] += 1
            return counts

        if counts["dropped"] or counts["errors"]:
            logger.info(
                "[native-reconciler] checked=%d dropped=%d errors=%d",
                counts["checked"],
                counts["dropped"],
                counts["errors"],
            )
        return counts

    async def _promote_scheduled_room(
        self, db: AsyncSession, room: Room, upstream: AudioRoom
    ) -> None:
        """Repair a mirror when upstream authoritatively reports it live."""
        started_at = upstream.started_at or datetime.now(tz=timezone.utc)
        room.status = "active"
        room.started_at = started_at
        await db.commit()
        try:
            await self._redis.add_active_room(str(room.id), started_at.timestamp())
            await self._redis.publish_room_discovery_event(
                {
                    "type": "rooms_changed",
                    "reason": "room_reconciled_live",
                    "room_id": str(room.id),
                    "status": "active",
                }
            )
        except Exception as exc:  # noqa: BLE001 — DB remains authoritative
            logger.debug(
                "[native-reconciler] live promotion redis sync failed room=%s: %s",
                room.id,
                type(exc).__name__,
            )

    @staticmethod
    def _is_room_gone(room_state: AudioRoom | None) -> bool:
        """Decide whether an authoritative per-room lookup says the room
        is genuinely gone (safe to drop).

        * ``None`` — upstream returned 404, the room no longer exists.
        * ``state == "ended"`` — upstream still has the record but the
          space has ended.

        Any other state (``"live"``, ``"scheduled"``, or an unknown
        forward-compat string) means the room is NOT gone — leave it be.
        """
        if room_state is None:
            return True
        return getattr(room_state, "state", None) == "ended"

    async def _stop_native_recording(self, db: AsyncSession, room: Room) -> None:
        """Force-stop the room's native recording agent before the room is
        dropped. Best-effort and fully self-contained — any failure is
        logged and swallowed so reconciliation always proceeds.

        No-op when the recording-agent dispatcher wasn't wired (e.g. tests
        that construct the reconciler without it).
        """
        if self._recording_agent is None:
            logger.warning(
                "[native-reconciler] room=%s has an active recording but no "
                "recording-agent wired — leaving recording flag set",
                room.id,
            )
            return

        # Imported lazily to avoid a circular import at module load
        # (room_service imports a wide surface that pulls this module in).
        from app.services.livekit_service import LiveKitService
        from app.services.room_service import SYSTEM_ACTOR_FID, RoomService

        livekit = LiveKitService()
        try:
            room_service = RoomService(
                db,
                self._redis,
                livekit,
                farcaster_spaces=self._farcaster_spaces,
                recording_agent=self._recording_agent,
            )
            result = await room_service.admin_stop_native_recording(
                str(room.id), admin_fid=SYSTEM_ACTOR_FID
            )
            logger.info(
                "[native-reconciler] stopped native recording for room=%s "
                "(status=%s)",
                room.id,
                result.get("status"),
            )
        except Exception as exc:  # noqa: BLE001 — never block cleanup
            logger.error(
                "[native-reconciler] native recording stop failed for " "room=%s: %s",
                room.id,
                type(exc).__name__,
            )
        finally:
            try:
                await livekit.close()
            except Exception:  # noqa: BLE001 — best-effort teardown
                pass

    async def _drop_room(self, db: AsyncSession, room: Room) -> None:
        """Flip ``room`` to ended state and drop from the Redis active
        set.

        Commits the row update before touching Redis so a transient
        Redis failure doesn't leave the DB and the registry diverging
        further than the next reconciler pass will catch.

        Also publishes a ``rooms_changed`` event on the discovery channel
        so connected WebSocket clients refresh their live rail instantly,
        matching the behavior of the host's manual end-native-room call.
        """
        # Stop any active native recording FIRST — while the upstream
        # LiveKit room may still be alive — so the worker can flush ffmpeg
        # + finalize the S3 upload. Once we flip the row to ``ended`` and
        # the upstream room is GC'd, the agent gets force-disconnected and
        # the recording is orphaned with no ``recording_url``. Best-effort:
        # a stuck worker must never block stale-room cleanup.
        if room.recording and room.recording_id:
            await self._stop_native_recording(db, room)

        now = datetime.now(tz=timezone.utc)
        if room.status != "ended":
            room.status = "ended"
            if room.ended_at is None:
                room.ended_at = now
            await db.commit()

            # Notify partner webhooks for developer-created native rooms.
            # Dispatch is best-effort — a failure must never block cleanup or
            # prevent subsequent rooms from being processed. The delivery
            # itself runs in background tasks via dev_webhook_service's own
            # session factory; we only use ``db`` here for the subscription
            # lookup query, which is safe after a commit.
            if room.created_by_app_id is not None:
                try:
                    _meta = room.metadata_ or {}
                    await dispatch_dev_webhook(
                        db,
                        app_id=room.created_by_app_id,
                        event_type="room.finished",
                        data={
                            "room_id": str(room.id),
                            "host_fid": room.host_fid,
                            "started_at": (
                                room.started_at.isoformat() if room.started_at else None
                            ),
                            "ended_at": now.isoformat(),
                            "ended_by_fid": None,
                            "ended_via": "upstream",
                            "is_farcaster_native": True,
                            "farcaster_room_id": room.farcaster_room_id,
                            "host_mode": _meta.get("host_mode"),
                            "farcaster_host_fid": _meta.get("farcaster_host_fid"),
                        },
                    )
                except Exception as exc:  # noqa: BLE001 — webhook never blocks cleanup
                    logger.warning(
                        "[native-reconciler] room.finished dispatch failed "
                        "for room=%s: %s",
                        room.id,
                        type(exc).__name__,
                    )
        try:
            await self._redis.remove_active_room(str(room.id))
        except Exception as exc:  # noqa: BLE001 — redis best-effort
            logger.debug(
                "[native-reconciler] redis remove_active_room failed "
                "for room=%s: %s",
                room.id,
                type(exc).__name__,
            )
        try:
            await self._redis.publish_room_discovery_event(
                {
                    "type": "rooms_changed",
                    "reason": "room_reconciled",
                    "room_id": str(room.id),
                    "status": room.status,
                }
            )
        except Exception as exc:  # noqa: BLE001 — pubsub best-effort
            logger.debug(
                "[native-reconciler] discovery publish failed for " "room=%s: %s",
                room.id,
                type(exc).__name__,
            )
