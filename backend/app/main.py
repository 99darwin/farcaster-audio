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
from app.routers import admin, auth, feed, media, notifications, participants, push, rooms, snaps, users, webhooks

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("farcaster-audio")

if settings.ENVIRONMENT != "development":
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENVIRONMENT,
        integrations=[
            FastApiIntegration(),
            SqlalchemyIntegration(),
        ],
        traces_sample_rate=0.1,
    )

# Load SKILL.md once at startup
_skill_md_path = Path(__file__).parent / "static" / "SKILL.md"
_skill_md_content = _skill_md_path.read_text() if _skill_md_path.exists() else "# SKILL.md not found"


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

    # Startup: init redis pool
    app.state.redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    yield
    # Shutdown: close redis
    await app.state.redis.close()


app = FastAPI(
    title="Farcaster Audio Spaces API",
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Middleware stack (order matters: last added = first to execute)
# ---------------------------------------------------------------------------

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
        from x402 import HTTPFacilitatorClient, x402ResourceServer
        from x402.http.middleware.fastapi import PaymentMiddlewareASGI
        from x402.mechanisms.evm import ExactEvmServerScheme

        facilitator = HTTPFacilitatorClient(base_url=settings.X402_FACILITATOR_URL)
        resource_server = x402ResourceServer(facilitator)
        resource_server.register("eip155:*", ExactEvmServerScheme())

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
        logger.info("x402 payment middleware enabled (network=%s, toll=%s)",
                     settings.X402_NETWORK, settings.AGENT_JOIN_TOLL)
    except ImportError as e:
        logger.warning("x402 import failed: %s — agent payment gate disabled.", e, exc_info=True)
    except Exception as e:
        logger.error("x402 middleware setup failed: %s", e, exc_info=True)
else:
    logger.warning("x402 middleware NOT enabled (X402_ENABLED=%s, X402_PAYMENT_ADDRESS=%s)",
                   settings.X402_ENABLED, bool(settings.X402_PAYMENT_ADDRESS))

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health(request: Request):
    health_data = {
        "status": "ok",
        "environment": settings.ENVIRONMENT,
        "version": "0.1.0",
    }
    # Check Redis connectivity
    try:
        await request.app.state.redis.ping()
        health_data["redis"] = "connected"
    except Exception:
        health_data["redis"] = "disconnected"
        health_data["status"] = "degraded"
    return health_data


@app.get("/v1/agent/SKILL.md", response_class=PlainTextResponse)
async def get_agent_skill():
    """Serve the agent skill document. Free, no auth required."""
    return PlainTextResponse(
        content=_skill_md_content,
        media_type="text/markdown; charset=utf-8",
    )


app.include_router(admin.router)
app.include_router(auth.router)
app.include_router(feed.router)
app.include_router(rooms.router)
app.include_router(users.router)
app.include_router(participants.router)
app.include_router(media.router)
app.include_router(notifications.router)
app.include_router(push.router)
app.include_router(snaps.router)
app.include_router(webhooks.router)
