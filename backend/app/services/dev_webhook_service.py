"""Outbound developer webhook dispatch.

Public surface:
- ``generate_secret()`` — fresh signing secret for a new subscription
- ``encrypt_secret(webhook_id, secret)`` — at-rest blob for ``secret``
- ``sign_payload(secret, body, timestamp)`` — HMAC-SHA256 over `{ts}.{body}`
- ``dispatch(db, app_id, event_type, data)`` — fan out to all matching
  subscriptions for ``app_id``. Best-effort; runs in the background.
- ``public_delivery_outcome(webhook)`` — the coarse status shown to devs
- ``encrypt_legacy_secrets(session_factory)`` — one-shot startup backfill
  of plaintext secrets stored before at-rest encryption.
- ``drain_delivery_tasks(timeout)`` — await all in-flight retries.
  Called from the FastAPI lifespan shutdown so a deploy doesn't silently
  drop pending deliveries.

Security:
- Each webhook subscription has its own per-developer signing secret,
  AES-GCM encrypted at rest (``signer_crypto``,
  ``SignerPurpose.DEVELOPER_WEBHOOK_SECRET``, AAD = webhook id). Rows
  written before that are plaintext ``whsec_…``; they keep working and are
  re-encrypted by :func:`encrypt_legacy_secrets`.
- ``X-Juke-Signature`` is ``t={ts},v1={hex_hmac}``, signed over
  ``f"{ts}.{json_body}"``. Developers verify by recomputing the HMAC
  with their stored secret and comparing in constant time. The timestamp
  guards against replay; reject events older than ~5 minutes.
- SSRF guard: every attempt resolves the URL's hostname and aborts if
  any A/AAAA record is not globally routable (``link_preview.is_private_ip``:
  loopback, link-local incl. IMDS, RFC1918, CGNAT 100.64/10, ULA,
  reserved, multicast, and IPv4-mapped / 6to4 / NAT64 forms of those).
  The request is then sent to the validated IP itself (Host header and
  TLS SNI/certificate check keep the original hostname), so a DNS
  rebind between our lookup and the connect cannot redirect it. Only
  ports 80/443 are dialled, redirects are disabled, and the environment
  proxy is ignored.
- Error surfaces returned to developers are coarsened to fixed
  categories (and the raw HTTP status is withheld) so they can't be used
  as a network-reconnaissance oracle.

Reliability model (v1):
- Fire-and-forget via tracked ``asyncio.create_task``. Tasks are held in
  a module-level set so the GC can't collect them mid-retry, and drained
  on process shutdown.
- Inline retry: up to 4 attempts at t=0, +10s, +60s, +300s.
- After ``MAX_CONSECUTIVE_FAILURES`` consecutive failed deliveries we
  auto-disable the subscription. Re-enable by deleting + re-creating.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import socket
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import async_session
from app.models.developer_webhook import DeveloperWebhook
from app.services import signer_crypto
from app.services.link_preview import is_private_ip

logger = logging.getLogger(__name__)


# Tunables — overridable in tests.
RETRY_DELAYS_SECONDS: tuple[float, ...] = (0.0, 10.0, 60.0, 300.0)
REQUEST_TIMEOUT_SECONDS = 5.0
MAX_CONSECUTIVE_FAILURES = 10

SECRET_PREFIX = "whsec_"
ALLOWED_SCHEMES = frozenset({"http", "https"})
# Only standard web ports, so a webhook can't be aimed at arbitrary services.
ALLOWED_PORTS = frozenset({80, 443})

# Fixed vocabulary for ``last_error`` and the public outcome.
OUTCOME_SUCCESS = "success"
ERROR_SECRET_UNAVAILABLE = "secret_unavailable"
ERROR_CATEGORIES = frozenset(
    {
        "timeout",
        "connection_failed",
        "http_3xx",
        "http_4xx",
        "http_5xx",
        "http_other",
        "blocked_ip",
        "blocked_port",
        "dns_failure",
        "invalid_url",
        "no_attempts",
        ERROR_SECRET_UNAVAILABLE,
    }
)
# Any stored value outside the vocabulary is reported as this.
GENERIC_ERROR_CATEGORY = "delivery_failed"
# Failures no retry can fix.
TERMINAL_ERRORS = frozenset(
    {"blocked_ip", "blocked_port", "dns_failure", "invalid_url"}
)


# Holds references to in-flight delivery tasks. Without this set Python is
# free to GC them mid-await (a documented ``create_task`` footgun), and a
# 300-second retry window would make that easy to hit under load.
_active_delivery_tasks: "set[asyncio.Task[None]]" = set()


def generate_secret() -> str:
    """Mint a fresh webhook signing secret (32 random bytes, urlsafe-b64).

    Prefix ``whsec_`` follows the convention developers recognize from
    other webhook providers and makes accidental leakage in logs/code
    grep-able.
    """
    return SECRET_PREFIX + secrets.token_urlsafe(32)


def encrypt_secret(webhook_id: uuid.UUID, secret: str) -> str:
    """At-rest blob for a webhook signing secret, bound to its row id.

    Raises ``signer_crypto.SignerKeyConfigError`` when no key is configured.
    """
    return signer_crypto.encrypt_secret(
        secret.encode(),
        aad=str(webhook_id),
        purpose=signer_crypto.SignerPurpose.DEVELOPER_WEBHOOK_SECRET,
    )


def _is_legacy_plaintext(stored: str) -> bool:
    return stored.startswith(SECRET_PREFIX)


def decrypt_secret(webhook_id: uuid.UUID, stored: str) -> str:
    """Signing secret from its stored form (blob, or legacy plaintext).

    Raises ``signer_crypto.SignerKeyConfigError`` / ``SignerDecryptError``.
    """
    if _is_legacy_plaintext(stored):
        return stored
    return signer_crypto.decrypt_private_key(
        stored,
        aad=str(webhook_id),
        purpose=signer_crypto.SignerPurpose.DEVELOPER_WEBHOOK_SECRET,
    ).decode()


def sign_payload(secret: str, body: bytes, timestamp: int) -> str:
    """Compute the value placed in ``X-Juke-Signature``.

    Format: ``t={timestamp},v1={hex_hmac}`` where ``hex_hmac`` is the
    HMAC-SHA256 of ``f"{timestamp}.{body}"`` using ``secret``.
    """
    mac = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.".encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()
    return f"t={timestamp},v1={mac}"


def build_event_envelope(event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    """Stable outbound shape. Consumers dedupe on ``event_id``."""
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }


def public_delivery_outcome(webhook: DeveloperWebhook) -> str | None:
    """Coarse result of the last delivery: ``success``, a category, or None.

    Never derived from anything but the fixed vocabulary, so the developer
    API can't be used to fingerprint what answered at the target.
    """
    if webhook.last_delivery_at is None:
        return None
    if not webhook.last_error:
        return OUTCOME_SUCCESS
    return public_error_category(webhook.last_error)


def public_error_category(stored: str | None) -> str | None:
    """``stored`` if it's a known category, else a generic one."""
    if not stored:
        return None
    return stored if stored in ERROR_CATEGORIES else GENERIC_ERROR_CATEGORY


# ---------------------------------------------------------------------------
# SSRF protection
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DeliveryTarget:
    """Where one attempt connects: a validated IP, plus the names to present.

    ``url`` has the IP literal as its host; ``host_header`` and
    ``sni_hostname`` (https only) carry the original hostname so virtual
    hosting and certificate verification still work.
    """

    url: str
    host_header: str
    sni_hostname: str | None


def _is_safe_ip(ip_str: str) -> bool:
    """Return True only for globally-routable public IPs.

    Delegates to ``link_preview.is_private_ip`` (``not is_global``, with
    IPv4-mapped, 6to4 and NAT64 addresses unwrapped) so the two outbound
    fetchers share one definition of "public".
    """
    return not is_private_ip(ip_str)


async def _resolve_hostname(hostname: str) -> list[str]:
    """Resolve ``hostname`` to all IPs via ``getaddrinfo`` (async wrapper)."""
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return []
    return [info[4][0] for info in infos]


def _ip_netloc(ip: str, port: int | None) -> str:
    host = f"[{ip}]" if ipaddress.ip_address(ip).version == 6 else ip
    return f"{host}:{port}" if port is not None else host


async def _resolve_delivery_target(url: str) -> tuple[DeliveryTarget | None, str]:
    """Resolve and check ``url`` immediately before an attempt.

    Returns ``(target, "")`` when every resolved address is public, else
    ``(None, error_category)``. The caller must connect to ``target.url``
    (the pinned IP), never re-resolve ``url``.
    """
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return None, "invalid_url"
    hostname = parsed.hostname
    if parsed.scheme not in ALLOWED_SCHEMES or not hostname:
        return None, "invalid_url"
    if parsed.username is not None or parsed.password is not None:
        return None, "invalid_url"
    if port is not None and port not in ALLOWED_PORTS:
        return None, "blocked_port"
    try:
        ascii_host = hostname.encode("idna").decode("ascii")
    except UnicodeError:
        return None, "invalid_url"
    ips = await _resolve_hostname(ascii_host)
    if not ips:
        return None, "dns_failure"
    if not all(_is_safe_ip(ip) for ip in ips):
        return None, "blocked_ip"
    pinned = urlunparse(parsed._replace(netloc=_ip_netloc(ips[0], port)))
    host_header = f"{ascii_host}:{port}" if port is not None else ascii_host
    sni_hostname = ascii_host if parsed.scheme == "https" else None
    return DeliveryTarget(pinned, host_header, sni_hostname), ""


async def _validate_url_for_delivery(url: str) -> str | None:
    """``None`` if ``url`` may be delivered to now, else the error category."""
    _, error = await _resolve_delivery_target(url)
    return error or None


# ---------------------------------------------------------------------------
# Error categorization
# ---------------------------------------------------------------------------


def _categorize_status(status_code: int) -> str:
    if 200 <= status_code < 300:
        return ""
    if 300 <= status_code < 400:
        return "http_3xx"
    if 400 <= status_code < 500:
        return "http_4xx"
    if 500 <= status_code < 600:
        return "http_5xx"
    return "http_other"


def _categorize_exception(exc: BaseException) -> str:
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return "timeout"
    return "connection_failed"


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------


async def _list_subscriptions_for_event(
    db: AsyncSession, app_id: uuid.UUID, event_type: str
) -> list[DeveloperWebhook]:
    """Return enabled webhooks for ``app_id`` subscribed to ``event_type``.

    Disabled subscriptions (auto-disabled after repeated failures) are
    filtered out at dispatch time so they don't keep firing.
    """
    result = await db.execute(
        select(DeveloperWebhook).where(
            DeveloperWebhook.app_id == app_id,
            DeveloperWebhook.disabled_at.is_(None),
        )
    )
    rows = result.scalars().all()
    return [row for row in rows if event_type in (row.events or [])]


async def _deliver_once(
    client: httpx.AsyncClient,
    url: str,
    secret: str,
    body: bytes,
    *,
    event_id: str,
) -> tuple[int | None, str]:
    """Post ``body`` to ``url`` with signing headers.

    Returns ``(status_code, error_category)``. ``error_category`` is the
    empty string on 2xx success, otherwise one of :data:`ERROR_CATEGORIES`.
    """
    target, blocked = await _resolve_delivery_target(url)
    if target is None:
        return None, blocked

    timestamp = int(time.time())
    signature = sign_payload(secret, body, timestamp)
    # ``X-Juke-Idempotency-Key`` echoes the envelope's ``event_id`` as a
    # top-level header so consumers can dedupe without parsing the body.
    # Same value on every retry of the same event so a successful prior
    # delivery that timed out on our side is recognized.
    headers = {
        "Host": target.host_header,
        "Content-Type": "application/json",
        "User-Agent": "JukeWebhooks/1",
        "X-Juke-Signature": signature,
        "X-Juke-Idempotency-Key": event_id,
    }
    extensions = {"sni_hostname": target.sni_hostname} if target.sni_hostname else None
    try:
        response = await client.post(
            target.url,
            content=body,
            headers=headers,
            timeout=REQUEST_TIMEOUT_SECONDS,
            extensions=extensions,
        )
    except (httpx.RequestError, asyncio.TimeoutError) as exc:
        return None, _categorize_exception(exc)

    category = _categorize_status(response.status_code)
    return response.status_code, category


async def _record_delivery_result(
    session_factory: async_sessionmaker[AsyncSession],
    webhook_id: uuid.UUID,
    status_code: int | None,
    error: str,
) -> None:
    """Persist final attempt outcome and roll the consecutive-failure counter.

    On success: reset ``consecutive_failures`` to 0 and clear ``last_error``.
    On failure: increment ``consecutive_failures`` and auto-disable if the
    threshold is crossed.
    """
    try:
        async with session_factory() as db:
            result = await db.execute(
                select(DeveloperWebhook).where(DeveloperWebhook.id == webhook_id)
            )
            row = result.scalar_one_or_none()
            if row is None:
                return
            now = datetime.now(timezone.utc)
            row.last_delivery_at = now
            row.last_status = status_code
            if error:
                row.last_error = error
                row.consecutive_failures = (row.consecutive_failures or 0) + 1
                if row.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    row.disabled_at = now
                    logger.warning(
                        "Auto-disabled webhook %s after %d consecutive " "failures",
                        webhook_id,
                        row.consecutive_failures,
                    )
            else:
                row.last_error = None
                row.consecutive_failures = 0
            await db.commit()
    except Exception:
        logger.exception("Failed to record delivery result for webhook %s", webhook_id)


async def _deliver_with_retry(
    *,
    webhook_id: uuid.UUID,
    url: str,
    secret: str,
    body: bytes,
    event_id: str,
    session_factory: async_sessionmaker[AsyncSession],
    retry_delays: tuple[float, ...] = RETRY_DELAYS_SECONDS,
) -> None:
    """Attempt delivery with exponential-ish backoff.

    Updates ``last_delivery_at`` / ``last_status`` / ``last_error`` on the
    final attempt's outcome. Takes primitives rather than a model row so
    the background task is completely decoupled from the request-scoped
    session that originally loaded the subscription.
    """
    # Redirects are disabled so a 302 to ``http://169.254.169.254/...``
    # cannot bypass the SSRF check. ``trust_env=False``: an environment
    # proxy would resolve the hostname itself, defeating IP pinning.
    async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as client:
        last_status: int | None = None
        last_error = "no_attempts"
        for delay in retry_delays:
            if delay > 0:
                await asyncio.sleep(delay)
            status_code, error = await _deliver_once(
                client, url, secret, body, event_id=event_id
            )
            last_status = status_code
            last_error = error
            if not error:
                break
            logger.info(
                "Webhook %s attempt failed (status=%s, error=%s)",
                webhook_id,
                status_code,
                error,
            )
            # If the URL is blocked (SSRF) or unresolvable, no later attempt
            # will help — short-circuit.
            if error in TERMINAL_ERRORS:
                break
    await _record_delivery_result(session_factory, webhook_id, last_status, last_error)


def _spawn_delivery(coro: "asyncio.coroutines.Coroutine[Any, Any, None]") -> None:
    """Schedule ``coro`` and keep a strong reference until it finishes."""
    task = asyncio.create_task(coro)
    _active_delivery_tasks.add(task)
    task.add_done_callback(_active_delivery_tasks.discard)


async def drain_delivery_tasks(timeout: float = 10.0) -> None:
    """Await outstanding deliveries during process shutdown.

    Best-effort; logs but does not raise if the timeout elapses. Designed
    to be called from a FastAPI lifespan shutdown hook so a graceful pod
    termination doesn't silently lose pending retries.
    """
    if not _active_delivery_tasks:
        return
    pending = list(_active_delivery_tasks)
    try:
        await asyncio.wait_for(
            asyncio.gather(*pending, return_exceptions=True),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "drain_delivery_tasks: %d task(s) still in-flight after %.1fs",
            len(_active_delivery_tasks),
            timeout,
        )


async def dispatch(
    db: AsyncSession,
    *,
    app_id: uuid.UUID | None,
    event_type: str,
    data: dict[str, Any],
) -> None:
    """Fan out ``event_type`` to every enabled subscription for ``app_id``.

    Returns immediately; deliveries run in background tasks. Safe to call
    from any handler that has the room's owning ``app_id`` (rooms created
    via ``POST /v1/developer/spaces`` set ``Room.created_by_app_id``;
    iOS-created rooms have ``None`` and produce no outbound webhooks).
    """
    if app_id is None:
        return
    subscriptions = await _list_subscriptions_for_event(db, app_id, event_type)
    if not subscriptions:
        return

    envelope = build_event_envelope(event_type, data)
    body = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
    event_id = envelope["event_id"]

    for webhook in subscriptions:
        try:
            secret = decrypt_secret(webhook.id, webhook.secret)
        except (signer_crypto.SignerKeyConfigError, signer_crypto.SignerDecryptError):
            # Never log the blob or key; the category tells the developer
            # to re-create the subscription if it persists.
            logger.error("Webhook %s signing secret unavailable", webhook.id)
            _spawn_delivery(
                _record_delivery_result(
                    async_session, webhook.id, None, ERROR_SECRET_UNAVAILABLE
                )
            )
            continue
        _spawn_delivery(
            _deliver_with_retry(
                webhook_id=webhook.id,
                url=webhook.url,
                secret=secret,
                body=body,
                event_id=event_id,
                session_factory=async_session,
            )
        )


async def encrypt_legacy_secrets(
    session_factory: async_sessionmaker[AsyncSession],
) -> int:
    """Encrypt every plaintext ``whsec_`` secret in place. Returns the count.

    Idempotent and safe to run from several workers at once: each row is
    updated only while it still holds the plaintext it was read with.
    Raises ``signer_crypto.SignerKeyConfigError`` when no key is configured.
    """
    signer_crypto.load_signer_encryption_key()  # fail fast before any reads
    updated = 0
    async with session_factory() as db:
        result = await db.execute(
            select(DeveloperWebhook.id, DeveloperWebhook.secret).where(
                DeveloperWebhook.secret.startswith(SECRET_PREFIX, autoescape=True)
            )
        )
        for webhook_id, plaintext in result.all():
            outcome = await db.execute(
                update(DeveloperWebhook)
                .where(
                    DeveloperWebhook.id == webhook_id,
                    DeveloperWebhook.secret == plaintext,
                )
                .values(secret=encrypt_secret(webhook_id, plaintext))
            )
            updated += outcome.rowcount or 0
        await db.commit()
    return updated
