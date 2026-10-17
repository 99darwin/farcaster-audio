"""Pre-authentication hardening shared by the inbound webhook receivers.

Every ``/v1/webhooks/*`` route is reachable by anyone on the internet and has
to do some work (read the body, compute HMACs / verify signatures) before it
can tell a real delivery from junk. This module bounds that work:

* :func:`read_capped_body` refuses bodies over :data:`MAX_WEBHOOK_BODY_BYTES`
  — on ``Content-Length`` up front, and again while streaming so a chunked or
  lying request can't make us buffer more than the cap.
* :func:`enforce_ip_rate_limit` is a generous per-IP, per-route volume cap.
  Real senders (LiveKit, Hypersnap, the juke.audio proxy) arrive from a few
  IPs, so the ceilings are sized for their legitimate burst volume.
* :func:`ensure_auth_failure_budget` / :func:`record_auth_failure` are a much
  tighter per-IP budget on *failed* authentications, checked before any
  signature work, so a client hammering a route with forged deliveries stops
  costing us HMAC/ed25519 computations after a handful of attempts.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request, status
from redis import asyncio as aioredis

from app.services.redis_service import RedisService

logger = logging.getLogger(__name__)

# Largest webhook body we will buffer. Hypersnap cast payloads and LiveKit
# events are a few KB; JFS envelopes are well under 1 KB.
MAX_WEBHOOK_BODY_BYTES = 256 * 1024

RATE_LIMIT_KEY_PREFIX = "webhook:rl:"
AUTH_FAILURE_KEY_PREFIX = "webhook:authfail:"

# Failed authentications tolerated per IP per route before we stop verifying.
AUTH_FAILURE_LIMIT = 20
AUTH_FAILURE_WINDOW_SECONDS = 60


async def read_capped_body(
    request: Request, max_bytes: int = MAX_WEBHOOK_BODY_BYTES
) -> bytes:
    """Read the raw request body, rejecting anything larger than ``max_bytes``.

    Raises 413 when the declared ``Content-Length`` exceeds the cap (before
    reading a byte) or when the streamed body crosses it (stops reading at
    that point). Raises 400 on a malformed ``Content-Length``.
    """
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_length = int(declared)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid Content-Length",
            ) from None
        if declared_length < 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid Content-Length",
            )
        if declared_length > max_bytes:
            raise _payload_too_large()

    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > max_bytes:
            raise _payload_too_large()
        chunks.append(chunk)
    return b"".join(chunks)


def _payload_too_large() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        detail="Webhook body too large",
    )


async def enforce_ip_rate_limit(
    redis: aioredis.Redis,
    *,
    route: str,
    client_ip: str,
    limit: int,
    window_seconds: int,
) -> None:
    """429 once ``client_ip`` exceeds ``limit`` calls to ``route`` per window."""
    allowed, retry_after = await RedisService(redis).check_rate_limit(
        f"{RATE_LIMIT_KEY_PREFIX}{route}:{client_ip}", limit, window_seconds
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many webhook requests",
            headers={"Retry-After": str(retry_after)},
        )


def _auth_failure_key(route: str, client_ip: str) -> str:
    return f"{AUTH_FAILURE_KEY_PREFIX}{route}:{client_ip}"


async def ensure_auth_failure_budget(
    redis: aioredis.Redis, *, route: str, client_ip: str
) -> None:
    """429 when ``client_ip`` already burned its failed-auth budget on ``route``."""
    raw = await redis.get(_auth_failure_key(route, client_ip))
    try:
        failures = int(raw) if raw is not None else 0
    except (TypeError, ValueError):
        failures = 0
    if failures >= AUTH_FAILURE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed webhook authentications",
            headers={"Retry-After": str(AUTH_FAILURE_WINDOW_SECONDS)},
        )


async def record_auth_failure(
    redis: aioredis.Redis, *, route: str, client_ip: str
) -> None:
    """Count one failed authentication against ``client_ip`` on ``route``."""
    key = _auth_failure_key(route, client_ip)
    try:
        pipe = redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, AUTH_FAILURE_WINDOW_SECONDS)
        await pipe.execute()
    except Exception:
        # Never turn a failed-auth response into a 500 because the counter
        # couldn't be written; the per-IP volume limit still applies.
        logger.warning("Failed to record webhook auth failure for route %s", route)
