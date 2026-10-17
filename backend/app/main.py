import logging
from contextlib import asynccontextmanager
from pathlib import Path

import redis.asyncio as aioredis
import sentry_sdk
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

from app.config import settings
from app.log_redaction import (
    configure_log_redaction,
    sentry_before_breadcrumb,
    sentry_before_send,
)
from app.middleware.body_size import BodySizeLimitMiddleware
from app.routers import (
    admin,
    auth,
    developer,
    drafts,
    farcaster_sync,
    feed,
    gifs,
    leaderboard,
    leaderboard_admin,
    media,
    messages,
    messaging_access,
    notifications,
    participants,
    push,
    recordings,
    rooms,
    search,
    snaps,
    spaces_discovery,
    users,
    voice_notes,
    webhooks,
)

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("farcaster-audio")
configure_log_redaction()

if settings.ENVIRONMENT != "development":
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENVIRONMENT,
        integrations=[
            FastApiIntegration(),
            SqlalchemyIntegration(),
        ],
        traces_sample_rate=0.1,
        # Defense in depth: Sentry's default frame-locals capture would
        # otherwise serialize secrets (e.g. an upstream provider api_key
        # held in a request-scoped dict) into every captured event. Belt-
        # and-suspenders alongside scoping secrets out of raise frames.
        include_local_variables=False,
        send_default_pii=False,
        before_breadcrumb=sentry_before_breadcrumb,
        before_send=sentry_before_send,
        # The Starlette integration otherwise awaits ``request.body()`` /
        # ``request.form()`` for every request up to 10 KB *before* the
        # endpoint runs, i.e. before auth and rate limits: unauthenticated
        # clients could make us buffer and parse bodies, and request
        # payloads would be shipped to Sentry. Never read bodies.
        max_request_body_size="never",
    )

# Load SKILL.md once at startup
_skill_md_path = Path(__file__).parent / "static" / "SKILL.md"
_skill_md_content = (
    _skill_md_path.read_text() if _skill_md_path.exists() else "# SKILL.md not found"
)


async def _drain_active_recordings(app: FastAPI) -> None:
    """Finalize every in-flight native recording before the process exits.

    Called from the lifespan shutdown so a redeploy (SIGTERM) flushes +
    uploads each active recording instead of orphaning it. Best-effort and
    time-bounded: a wedged worker must not block the whole shutdown past the
    platform's SIGKILL grace. Finalizes concurrently and caps total time at
    ``RECORDING_DRAIN_TIMEOUT_SECONDS``.

    Requires Redis + the spaces service to still be open, so it MUST run
    before those are torn down.
    """
    import asyncio

    from sqlalchemy import select

    from app.database import async_session
    from app.models.room import Room
    from app.services.livekit_service import LiveKitService
    from app.services.redis_service import RedisService as _RedisService
    from app.services.room_service import SYSTEM_ACTOR_FID, RoomService

    recording_agent = getattr(app.state, "recording_agent_service", None)
    farcaster_spaces = getattr(app.state, "farcaster_spaces_service", None)
    if recording_agent is None or farcaster_spaces is None:
        return

    active_ids = recording_agent.active_recording_ids()
    if not active_ids:
        return

    logger.warning(
        "[shutdown] draining %d in-flight recording(s) before exit", len(active_ids)
    )

    async def _finalize_one(recording_id: str) -> None:
        livekit = LiveKitService()
        try:
            async with async_session() as db:
                room = (
                    await db.execute(
                        select(Room).where(Room.recording_id == recording_id)
                    )
                ).scalar_one_or_none()
                if room is None:
                    # No DB row maps to this worker — still stop it so it
                    # uploads its buffer rather than dying with the temp file.
                    await recording_agent.stop_recording(recording_id)
                    return
                rs = RoomService(
                    db,
                    _RedisService(app.state.redis),
                    livekit,
                    farcaster_spaces=farcaster_spaces,
                    recording_agent=recording_agent,
                )
                await rs.admin_stop_native_recording(
                    str(room.id), admin_fid=SYSTEM_ACTOR_FID
                )
        except Exception as exc:  # noqa: BLE001 — never block other drains
            logger.error(
                "[shutdown] failed to finalize recording %s: %s",
                recording_id[:8],
                type(exc).__name__,
            )
        finally:
            try:
                await livekit.close()
            except Exception:  # noqa: BLE001 — best-effort teardown
                pass

    try:
        await asyncio.wait_for(
            asyncio.gather(
                *(_finalize_one(rid) for rid in active_ids),
                return_exceptions=True,
            ),
            timeout=settings.RECORDING_DRAIN_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error(
            "[shutdown] recording drain timed out after %ss — %d may be orphaned",
            settings.RECORDING_DRAIN_TIMEOUT_SECONDS,
            len(active_ids),
        )


def create_redis_client(max_connections: int) -> aioredis.Redis:
    """Redis client over a bounded, blocking connection pool.

    An unbounded pool lets socket floods exhaust Redis ``maxclients`` for the
    whole API. When the pool is full a caller waits up to
    ``REDIS_POOL_TIMEOUT_SECONDS`` and then fails, instead of opening yet
    another connection.
    """
    pool = aioredis.BlockingConnectionPool.from_url(
        settings.REDIS_URL,
        decode_responses=True,
        max_connections=max_connections,
        timeout=settings.REDIS_POOL_TIMEOUT_SECONDS,
    )
    return aioredis.Redis.from_pool(pool)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Reject insecure JWT secret in non-development environments
    if (
        settings.ENVIRONMENT != "development"
        and settings.JWT_SECRET == "change-me-in-production"
    ):
        raise RuntimeError(
            "JWT_SECRET must be changed from the default value in non-development environments"
        )

    # ADMIN_SECRET gates /v1/admin/recordings/cleanup and similar shared-secret
    # ops endpoints. In production a weak or unset value is a real exposure, so
    # we fail closed there. Local dev / tests can boot with a placeholder so
    # contributors don't need to generate a 32-byte token to run pytest.
    if settings.ENVIRONMENT != "development":
        if not settings.ADMIN_SECRET or len(settings.ADMIN_SECRET) < 32:
            raise RuntimeError(
                "ADMIN_SECRET must be set and at least 32 characters in "
                "non-development environments. Generate with "
                "`python -c 'import secrets; print(secrets.token_urlsafe(48))'`."
            )
    elif settings.ADMIN_SECRET and len(settings.ADMIN_SECRET) < 32:
        logger.warning(
            "ADMIN_SECRET is shorter than 32 characters (len=%d). Rotate to a "
            "longer random value before relying on admin ops endpoints.",
            len(settings.ADMIN_SECRET),
        )

    if settings.ENVIRONMENT != "development":
        if not settings.JUKE_API_KEY_PEPPER or not settings.JUKE_API_KEY_ENCRYPTION_KEY:
            raise RuntimeError(
                "JUKE_API_KEY_PEPPER and JUKE_API_KEY_ENCRYPTION_KEY are required "
                "outside development"
            )
        # Fail closed if the pepper is too short to provide meaningful
        # collision resistance for HMAC-SHA256 keying.
        if len(settings.JUKE_API_KEY_PEPPER.encode()) < 32:
            raise RuntimeError(
                "JUKE_API_KEY_PEPPER must be at least 32 bytes outside development"
            )
        # Validate the AES-256 encryption key length upfront so a misconfigured
        # deployment fails at boot instead of at first key creation.
        import base64 as _b64

        _raw_key = settings.JUKE_API_KEY_ENCRYPTION_KEY
        _decoded: bytes | None = None
        for _decoder in (_b64.urlsafe_b64decode, _b64.b64decode):
            try:
                _decoded = _decoder(_raw_key + "=" * (-len(_raw_key) % 4))
                break
            except Exception:
                continue
        if _decoded is None or len(_decoded) != 32:
            # Allow the raw 32-byte form (rare but valid).
            if len(_raw_key.encode()) != 32:
                raise RuntimeError(
                    "JUKE_API_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes "
                    "(AES-256)"
                )

    # Reject wildcard CORS origins — combined with allow_credentials=True
    # this would be a cross-site footgun if we ever move to cookie auth.
    # We also require every allowed origin to be HTTPS outside development.
    if "*" in settings.CORS_ORIGINS:
        raise RuntimeError(
            "CORS_ORIGINS must not contain '*' while credentials are allowed"
        )
    if settings.ENVIRONMENT != "development":
        insecure_origins = [
            o for o in settings.CORS_ORIGINS if not o.startswith("https://")
        ]
        if insecure_origins:
            raise RuntimeError(
                f"CORS_ORIGINS must be HTTPS outside development: {insecure_origins}"
            )

    # Fail fast on a malformed TRUSTED_PROXY_IPS; only warn when unset so a
    # missing env var can't take production down.
    from app.services.client_ip import check_trusted_proxy_config

    check_trusted_proxy_config()

    # Startup: init redis pool
    app.state.redis = create_redis_client(settings.REDIS_MAX_CONNECTIONS)
    # Websocket pubsub pins one connection per socket: separate pool so a
    # socket flood exhausts only this one, never the HTTP command pool.
    app.state.redis_pubsub = create_redis_client(settings.REDIS_PUBSUB_MAX_CONNECTIONS)

    # Eagerly construct the Farcaster-spaces discovery service so its
    # bearer-mint lock + httpx client are a single shared instance for
    # the lifetime of the process. Construction is cheap (no I/O); the
    # bearer mint itself stays lazy.
    from app.services.farcaster_spaces_service import FarcasterSpacesService

    app.state.farcaster_spaces_service = FarcasterSpacesService(settings)

    # Recording-agent dispatcher — also one per process so the active-
    # recordings registry stays consistent. No I/O at construction;
    # workers spawn on demand from /v1/rooms/{id}/recording/start.
    from app.services.recording_agent_service import RecordingAgentService

    app.state.recording_agent_service = RecordingAgentService(settings)

    # Native-room reconciler — periodically drops Juke ``Room`` rows
    # whose upstream counterpart has fallen off ``client.farcaster.xyz``
    # so stale rooms don't linger in the discovery rail. Skips silently
    # if the spaces service is unconfigured (read-only proxy is the
    # only way to learn what's still live upstream).
    from app.database import async_session as _native_session_factory
    from app.services.native_rooms_reconciler import NativeRoomsReconciler
    from app.services.redis_service import RedisService as _RedisService

    app.state.native_rooms_reconciler = NativeRoomsReconciler(
        farcaster_spaces=app.state.farcaster_spaces_service,
        redis=_RedisService(app.state.redis),
        session_maker=_native_session_factory,
        recording_agent=app.state.recording_agent_service,
    )
    await app.state.native_rooms_reconciler.start()

    # Every Gunicorn worker runs a publisher loop. Postgres row claims use
    # SKIP LOCKED, so workers cooperate without a process-local leader lock;
    # persisted leases recover jobs from worker crashes or rolling restarts.
    from app.database import async_session as _scheduled_cast_session_factory
    from app.services.scheduled_cast_publisher import ScheduledCastPublisher

    app.state.scheduled_cast_publisher = ScheduledCastPublisher(
        _scheduled_cast_session_factory
    )
    await app.state.scheduled_cast_publisher.start()

    # Re-encrypt developer webhook secrets stored before at-rest encryption.
    # Idempotent and safe across workers; deliveries keep working either way.
    from app.services.dev_webhook_service import encrypt_legacy_secrets

    try:
        migrated = await encrypt_legacy_secrets(_scheduled_cast_session_factory)
        if migrated:
            logger.info("[webhooks] Encrypted %d legacy signing secret(s)", migrated)
    except Exception as exc:  # startup must not fail on this backfill
        logger.error(
            "[webhooks] Legacy secret backfill skipped: %s", type(exc).__name__
        )

    # Nightly recognition-leaderboard aggregation. Every worker runs the loop;
    # a Redis lock ensures only one performs each pass so Neynar isn't hit N
    # times. Disabled by default (needs Redis + Neynar) — enable per deploy.
    if settings.LEADERBOARD_AGGREGATION_ENABLED:
        from app.database import async_session as _leaderboard_session_factory
        from app.services.leaderboard_service import LeaderboardAggregator

        app.state.leaderboard_aggregator = LeaderboardAggregator(
            _leaderboard_session_factory, app.state.redis
        )
        await app.state.leaderboard_aggregator.start()

    # Sync Warpcast labels at startup (fire-and-forget)
    if settings.SPAM_FILTER_ENABLED:
        import asyncio

        from app.database import async_session as _session_factory
        from app.services.spam_service import SpamService

        async def _sync_labels():
            try:
                async with _session_factory() as db:
                    svc = SpamService(db, app.state.redis)
                    count = await svc.sync_warpcast_labels()
                    logger.info("[spam] Startup label sync complete: %d labels", count)
            except Exception as e:
                logger.error("[spam] Startup label sync failed: %s", e, exc_info=True)

        asyncio.create_task(_sync_labels())

    yield
    # Stop claiming scheduled casts before other application services begin
    # shutting down. A cancelled in-flight HTTP request leaves a processing
    # lease which another worker (or the restarted process) will recover.
    scheduled_publisher = getattr(app.state, "scheduled_cast_publisher", None)
    if scheduled_publisher is not None:
        try:
            await scheduled_publisher.stop()
        except Exception:  # pragma: no cover - shutdown best-effort
            pass
    leaderboard_aggregator = getattr(app.state, "leaderboard_aggregator", None)
    if leaderboard_aggregator is not None:
        try:
            await leaderboard_aggregator.stop()
        except Exception:  # pragma: no cover - shutdown best-effort
            pass
    # Shutdown. ORDER MATTERS: finalize in-flight recordings FIRST, while
    # Redis + the spaces service are still open (the finalize path publishes
    # to Redis and releases the agent FID via the spaces service). Without
    # this, a redeploy SIGTERMs the process, the recording worker (a child
    # process) dies with its un-uploaded local temp file, and the recording
    # is orphaned with no audio ever reaching S3.
    await _drain_active_recordings(app)

    # Drain in-flight developer webhook deliveries.
    from app.services.dev_webhook_service import drain_delivery_tasks

    await drain_delivery_tasks(timeout=10.0)
    # Stop the native-rooms reconciler before draining the spaces
    # service — its pass may still be holding the httpx client open.
    reconciler = getattr(app.state, "native_rooms_reconciler", None)
    if reconciler is not None:
        try:
            await reconciler.stop()
        except Exception:  # pragma: no cover - shutdown best-effort
            pass
    # Close the Farcaster spaces httpx client if it was instantiated.
    fcsp = getattr(app.state, "farcaster_spaces_service", None)
    if fcsp is not None:
        try:
            await fcsp.aclose()
        except Exception:  # pragma: no cover - shutdown best-effort
            pass
    # Close the Direct Casts upstream httpx client if it was instantiated.
    direct_cast_service = getattr(app.state, "direct_cast_service", None)
    if direct_cast_service is not None:
        try:
            await direct_cast_service.aclose()
        except Exception:  # pragma: no cover - shutdown best-effort
            pass
    from app.clients import hypersnap

    await hypersnap.close_client()
    await app.state.redis_pubsub.aclose()
    await app.state.redis.close()


app = FastAPI(
    title="Farcaster Audio Spaces API",
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Middleware stack (order matters: last added = first to execute)
# ---------------------------------------------------------------------------

# Body-size cap sits inside CORS so a 413 still carries CORS headers.
app.add_middleware(BodySizeLimitMiddleware)

# CORS must be outermost
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
)

# x402 payment middleware — only active when X402_ENABLED=true and configured
if settings.X402_ENABLED and settings.X402_PAYMENT_ADDRESS:
    try:
        from x402 import x402ResourceServer
        from x402.http.facilitator_client import HTTPFacilitatorClient
        from x402.http.middleware.fastapi import PaymentMiddlewareASGI
        from x402.mechanisms.evm.exact.server import ExactEvmScheme
        from cdp.x402 import create_facilitator_config

        facilitator = HTTPFacilitatorClient(create_facilitator_config())
        resource_server = x402ResourceServer(facilitator)
        resource_server.register("eip155:*", ExactEvmScheme())

        app.add_middleware(
            PaymentMiddlewareASGI,
            server=resource_server,
            routes={
                "POST /v1/rooms/:room_id/agent-join": {
                    "description": "Join Juke audio space as listener",
                    "accepts": {
                        "scheme": "exact",
                        "network": settings.X402_NETWORK,
                        "price": {
                            "amount": settings.AGENT_JOIN_TOLL,
                            "asset": settings.X402_USDC_ASSET,
                        },
                        "pay_to": settings.X402_PAYMENT_ADDRESS,
                    },
                },
            },
        )
        logger.info(
            "x402 payment middleware enabled (network=%s, toll=%s)",
            settings.X402_NETWORK,
            settings.AGENT_JOIN_TOLL,
        )
    except ImportError as e:
        logger.warning(
            "x402 import failed: %s — agent payment gate disabled.", e, exc_info=True
        )
    except Exception as e:
        logger.error("x402 middleware setup failed: %s", e, exc_info=True)
else:
    logger.warning(
        "x402 middleware NOT enabled (X402_ENABLED=%s, X402_PAYMENT_ADDRESS=%s)",
        settings.X402_ENABLED,
        bool(settings.X402_PAYMENT_ADDRESS),
    )

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health(request: Request) -> dict[str, str]:
    """Liveness + Redis reachability. Deliberately reveals nothing else
    (no environment name, version or dependency detail) to anonymous callers.
    """
    try:
        await request.app.state.redis.ping()
    except Exception:
        return {"status": "degraded"}
    return {"status": "ok"}


@app.get("/v1/agent/SKILL.md", response_class=PlainTextResponse)
async def get_agent_skill():
    """Serve the agent skill document. Free, no auth required."""
    return PlainTextResponse(
        content=_skill_md_content,
        media_type="text/markdown; charset=utf-8",
    )


app.include_router(admin.router)
app.include_router(auth.router)
app.include_router(developer.router)
app.include_router(drafts.router)
app.include_router(farcaster_sync.router)
app.include_router(feed.router)
app.include_router(gifs.router)
app.include_router(leaderboard.router)
app.include_router(leaderboard_admin.router)
app.include_router(rooms.router)
app.include_router(users.router)
app.include_router(participants.router)
app.include_router(media.router)
app.include_router(messages.router)
app.include_router(messages.status_router)
app.include_router(messaging_access.router)
app.include_router(messaging_access.token_router)
app.include_router(notifications.router)
app.include_router(push.router)
app.include_router(recordings.router)
app.include_router(search.router)
app.include_router(snaps.router)
app.include_router(spaces_discovery.router)
app.include_router(voice_notes.router)
app.include_router(webhooks.router)
