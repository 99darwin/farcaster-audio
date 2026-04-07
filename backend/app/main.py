import logging
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
import sentry_sdk
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
