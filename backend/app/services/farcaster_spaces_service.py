"""Read-only proxy to Farcaster's undocumented `client.farcaster.xyz`
audio-spaces API.

We mint a single long-lived bearer token using an EOA we own (the
"service FID") via the same `PUT /v2/onboarding-state` handshake the
Quorum Mobile client uses. The bearer is held in memory only, refreshed
lazily when within a configurable hours-from-expiry threshold, and is
NEVER logged, returned in a response, or attached to an exception.

Auth flow (matches Quorum reference):

  1. Build the canonical-sorted JSON form of
     ``{"method": "generateToken",
        "params": {"timestamp": now_ms,
                   "expiresAt": now_ms + 1000*86400*1000}}``.
  2. Sign it via EIP-191 (``personal_sign``) with our custody key.
  3. base64-encode the 65-byte signature, prefix `eip191:`, send as
     ``Authorization: Bearer eip191:<base64>``.
  4. PUT https://client.farcaster.xyz/v2/onboarding-state with body
     ``{"authRequest": <unsorted payload>}``. The signed canonical
     form is what's verified server-side; the request body itself is
     the JS object, key order irrelevant.
  5. Parse ``{"result": {"token": {"secret": "...", "expiresAt": N}}}``
     and cache the secret.

All discovery endpoints share a single ``httpx.AsyncClient`` with a
10s timeout and no redirect-following. Retries on 5xx / network errors
use exponential backoff (3 attempts, base 0.5s × 2^n).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, TypeVar
from uuid import UUID

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import key_gateway
from app.clients.key_gateway import KeyGatewayError
from app.config import Settings
from app.models.developer_app_bot import DeveloperAppBot
from app.services.bot_signer_service import (
    AUTH_MODE_APP_KEY,
    BotSignerConfigError,
    BotSignerCryptoError,
    mint_bearer_for_bot,
)
from app.schemas.farcaster_spaces import (
    AudioRoom,
    AudioRoomChatMessage,
    AudioRoomParticipant,
    FarcasterSpacesConfigError,
)

logger = logging.getLogger(__name__)

FARCASTER_API_BASE_URL = "https://client.farcaster.xyz"
# 1000 days in milliseconds — matches Quorum/upstream default.
DEFAULT_AUTH_TOKEN_EXPIRES_IN_MS = 1000 * 24 * 60 * 60 * 1000
RETRY_ATTEMPTS = 3
RETRY_BASE_SECONDS = 0.5
REQUEST_TIMEOUT_SECONDS = 10.0
MAX_LOGGED_BODY_CHARS = 400
# Every legacy custody_env key var must carry this prefix, so no allowlist
# typo can ever point a developer bot at a platform secret (JWT_SECRET,
# JUKE_FARCASTER_CUSTODY_PRIVATE_KEY, signer encryption keys, ...).
DEVELOPER_CUSTODY_ENV_PREFIX = "JUKE_DEV_BOT_CUSTODY_"
CUSTODY_KEY_REF_ENV_SCHEME = "env:"
# Single opaque message for every custody_key_ref failure mode, so neither
# the response nor the exception text distinguishes "not allowlisted" from
# "missing", "wrong key", or "custody changed".
CUSTODY_KEY_REF_FAILED = "custody_key_ref resolution failed"

T = TypeVar("T")


def _canonicalize(obj: Any) -> str:
    """Deterministic JSON stringification matching Quorum's canonicalize().

    Sorts object keys, compact separators (no whitespace). Crucially:
    the bytes produced here are what we sign. Any drift from the
    upstream canonicalize() will produce a signature the server can't
    verify — keep this aligned with `services/onboarding/farcasterService.ts`.

    NOTE on ``ensure_ascii``: our auth payload is pure ASCII
    (``generateToken`` + integer timestamps), so the Python default
    (``ensure_ascii=True``) vs JS ``JSON.stringify`` (raw UTF-8) is a
    no-op for this code path. If we ever sign a payload containing
    non-ASCII strings, set ``ensure_ascii=False`` to match the JS
    reference byte-for-byte.
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _format_scheduled_at(dt: datetime) -> str:
    """Render a schedule time as the ISO-8601 string the upstream
    ``/v1/audio-rooms`` create endpoint expects (e.g.
    ``2026-06-01T18:00:00Z``).

    Upstream returns ``scheduledAt`` in this same ISO form (see
    ``AudioRoom.scheduled_at``) and 400s an epoch-millis integer with
    ``{"errors":[{"message":"scheduledAt must be a valid future
    timestamp"}]}``. We normalize to UTC and emit a ``Z`` suffix to match
    the Quorum reference client (``farcasterSpacesClient.createAudioRoom``,
    whose ``AudioRoomCreateFields.scheduledAt`` is typed as an ISO string).
    """
    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


_JFS_BEARER_PATTERN = re.compile(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")


def _trimmed(body: str) -> str:
    """Bound log volume on upstream failures and redact any echoed JFS
    bearer. Some upstream error pages echo headers or payloads — without
    this scrub, a 4xx/5xx body could surface the caller's bearer in our
    logs."""
    redacted = _JFS_BEARER_PATTERN.sub("[REDACTED_JFS]", body)
    if len(redacted) > MAX_LOGGED_BODY_CHARS:
        return redacted[:MAX_LOGGED_BODY_CHARS] + "…"
    return redacted


def _redact_auth(request: httpx.Request) -> httpx.Request:
    """In-place strip the Authorization header from a captured request.

    We attach the original request to ``httpx.HTTPStatusError`` so
    callers can inspect status / URL on failure. But the request object
    retains the outbound Authorization header (carrying either the
    minted bearer or the eip191 signature) which would surface in any
    accidental ``logger.exception`` traceback walk or Sentry event
    payload. Strip it eagerly: nothing downstream needs the bearer.
    """
    try:
        if "authorization" in request.headers:
            del request.headers["authorization"]
    except Exception:  # pragma: no cover — header API is forgiving
        pass
    return request


class FarcasterSpacesService:
    """In-process gateway to `client.farcaster.xyz` read endpoints.

    Holds the minted service-FID bearer in memory only. Callers should
    treat the service as a singleton per FastAPI app — recreating it
    forces a re-mint.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: httpx.AsyncClient | None = None
        self._bearer_secret: str | None = None
        self._bearer_expires_at_ms: int | None = None
        self._mint_lock = asyncio.Lock()
        # Per-FID recording-agent bearer cache. Each entry is a tuple
        # of ``(secret, expires_at_ms)``. Mint operations serialize
        # through ``_agent_mint_lock`` so two coroutines asking for
        # the same agent FID don't double-mint; the lock is held only
        # across the upstream PUT call.
        self._agent_bearer_cache: dict[int, tuple[str, int]] = {}
        self._agent_mint_lock = asyncio.Lock()
        # Simple in-process busy-bit map: ``{fid: True}`` means the
        # agent is currently dispatched to a room. Cleared by
        # ``release_recording_agent``. NOTE: this is single-process
        # only. Multi-worker deployments should swap this for a Redis
        # SETNX lock keyed by FID before scaling beyond one API pod.
        self._agent_busy: dict[int, bool] = {}
        self._agent_busy_lock = asyncio.Lock()
        # Per-(app_id, fid) developer-bot bearer cache. Mirrors the
        # recording-agent cache layout but is keyed by ``(app_id, fid)``
        # because two different developer apps may legitimately register
        # the same FID. Mint operations serialize through
        # ``_dev_bot_mint_lock`` so concurrent callers asking for the
        # same (app, fid) don't double-mint.
        self._dev_bot_bearer_cache: dict[tuple[UUID, int], tuple[str, int]] = {}
        self._dev_bot_mint_lock = asyncio.Lock()

    # -----------------------------------------------------------------
    # HTTP client lifecycle
    # -----------------------------------------------------------------

    def _get_http_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=REQUEST_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -----------------------------------------------------------------
    # Bearer mint + cache
    # -----------------------------------------------------------------

    @staticmethod
    def _build_auth_request(now_ms: int | None = None) -> dict[str, Any]:
        ts = now_ms if now_ms is not None else int(time.time() * 1000)
        return {
            "method": "generateToken",
            "params": {
                "timestamp": ts,
                "expiresAt": ts + DEFAULT_AUTH_TOKEN_EXPIRES_IN_MS,
            },
        }

    def _sign_auth_request(self, auth_request: dict[str, Any]) -> str:
        """Sign the canonicalized auth request and return the
        `eip191:<base64>` bearer header value."""
        private_key = self._settings.juke_farcaster_custody_private_key_resolved()
        if not private_key:
            # Defense-in-depth: callers reach _get_bearer() first,
            # which already raises, but this keeps a misuse from ever
            # touching eth_account with an empty key.
            raise FarcasterSpacesConfigError("service not configured")
        return self._sign_auth_request_with_key(auth_request, private_key)

    @staticmethod
    def _sign_auth_request_with_key(
        auth_request: dict[str, Any], private_key: str
    ) -> str:
        """Pure-helper variant of :py:meth:`_sign_auth_request` accepting
        an explicit custody key.

        Used by the per-FID recording-agent bearer-mint path so each
        agent FID signs with its OWN custody EOA. Caller is responsible
        for guaranteeing ``private_key`` is non-empty.
        """
        canonical = _canonicalize(auth_request)
        signable = encode_defunct(text=canonical)
        signed = Account.sign_message(signable, private_key=private_key)
        sig_bytes: bytes = signed.signature
        sig_b64 = base64.b64encode(sig_bytes).decode("ascii")
        return f"eip191:{sig_b64}"

    async def _mint_service_bearer(self) -> str:
        """Mint a fresh long-lived bearer token from
        `client.farcaster.xyz`. Stores `{secret, expires_at_ms}` on the
        instance and returns the secret. NEVER logs the bearer value.
        """
        private_key = self._settings.juke_farcaster_custody_private_key_resolved()
        if not private_key:
            raise FarcasterSpacesConfigError("service not configured")
        secret, expires_at_ms = await self._mint_bearer_for_key(
            private_key, log_label="service"
        )
        self._bearer_secret = secret
        self._bearer_expires_at_ms = expires_at_ms
        return secret

    def _bearer_needs_refresh(self) -> bool:
        """Returns True iff we have no bearer or the cached one is
        within ``JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS`` of
        expiring."""
        if not self._bearer_secret or self._bearer_expires_at_ms is None:
            return True
        threshold_ms = (
            self._settings.JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS
            * 60
            * 60
            * 1000
        )
        return (self._bearer_expires_at_ms - int(time.time() * 1000)) <= threshold_ms

    async def _get_bearer(self) -> str:
        """Return the cached bearer, minting (or refreshing) if needed.

        Raises ``FarcasterSpacesConfigError`` if the custody key is
        empty — the router translates this to HTTP 503.
        """
        if not self._settings.juke_farcaster_custody_private_key_resolved():
            raise FarcasterSpacesConfigError("service not configured")
        if not self._bearer_needs_refresh():
            assert self._bearer_secret is not None  # narrow for mypy
            return self._bearer_secret
        async with self._mint_lock:
            # Double-check under lock — another coroutine may have just
            # minted.
            if not self._bearer_needs_refresh():
                assert self._bearer_secret is not None
                return self._bearer_secret
            return await self._mint_service_bearer()

    # -----------------------------------------------------------------
    # Per-FID recording-agent bearer mint + pool
    # -----------------------------------------------------------------

    async def _mint_bearer_for_key(
        self, custody_private_key: str, *, log_label: str
    ) -> tuple[str, int]:
        """Run the upstream ``PUT /v2/onboarding-state`` flow with a
        caller-supplied custody key. Returns ``(secret, expires_at_ms)``.

        Shared mint backbone used by both the service-FID bearer
        (callers fold the result into ``self._bearer_*``) and the
        per-agent bearer cache. NEVER logs the bearer value.

        ``log_label`` is an opaque identifier used only in log lines —
        e.g. ``"service"`` or ``"agent fid=NNN"`` — to disambiguate
        operational signal between the two mint paths.
        """
        if not custody_private_key:
            raise FarcasterSpacesConfigError("custody key missing")

        auth_request = self._build_auth_request()
        bearer_header_value = self._sign_auth_request_with_key(
            auth_request, custody_private_key
        )
        return await self.mint_bearer_from_signed_request(
            auth_request, bearer_header_value, log_label=log_label
        )

    async def mint_bearer_from_signed_request(
        self,
        auth_request: dict[str, Any],
        bearer_header_value: str,
        *,
        log_label: str,
    ) -> tuple[str, int]:
        """``PUT /v2/onboarding-state`` with an already-signed request.

        ``bearer_header_value`` is the ``eip191:<base64>`` signature of
        ``_canonicalize(auth_request)`` by the FID's custody key. Used
        directly by the Direct Casts token flow, where the user's device
        signs and the backend never sees a custody key. Returns
        ``(secret, expires_at_ms)``. NEVER logs the signature or secret.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v2/onboarding-state"
        headers = {
            "accept": "*/*",
            "content-type": "application/json; charset=utf-8",
            "authorization": f"Bearer {bearer_header_value}",
            "origin": "https://farcaster.xyz",
            "referer": "https://farcaster.xyz/",
        }

        try:
            resp = await client.put(
                url, headers=headers, json={"authRequest": auth_request}
            )
        except httpx.HTTPError as e:
            logger.warning(
                "[farcaster-spaces] mint(%s) PUT /v2/onboarding-state "
                "network error: %s",
                log_label,
                type(e).__name__,
            )
            raise

        if resp.status_code >= 400:
            logger.warning(
                "[farcaster-spaces] mint(%s) failed: status=%s",
                log_label,
                resp.status_code,
            )
            _redact_auth(resp.request)
            raise httpx.HTTPStatusError(
                f"mint failed: {resp.status_code}",
                request=resp.request,
                response=resp,
            )

        try:
            data = resp.json()
        except Exception as e:
            logger.warning(
                "[farcaster-spaces] mint(%s) response was not JSON: %s",
                log_label,
                type(e).__name__,
            )
            raise

        token_obj = (data or {}).get("result", {}).get("token") or {}
        secret = token_obj.get("secret")
        expires_at = token_obj.get("expiresAt")
        if not isinstance(secret, str) or not secret:
            logger.warning(
                "[farcaster-spaces] mint(%s) response missing token.secret",
                log_label,
            )
            raise ValueError("mint response missing token.secret")
        if not isinstance(expires_at, (int, float)):
            expires_at = int(time.time() * 1000) + DEFAULT_AUTH_TOKEN_EXPIRES_IN_MS
        expires_at_int = int(expires_at)
        logger.warning(
            "[farcaster-spaces] %s bearer minted (length=%d, expires_at_ms=%d)",
            log_label,
            len(secret),
            expires_at_int,
        )
        return secret, expires_at_int

    def _agent_bearer_needs_refresh(self, fid: int) -> bool:
        """Mirror of :py:meth:`_bearer_needs_refresh` for the per-FID
        cache."""
        cached = self._agent_bearer_cache.get(fid)
        if cached is None:
            return True
        _secret, expires_at_ms = cached
        threshold_ms = (
            self._settings.JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS
            * 60
            * 60
            * 1000
        )
        return (expires_at_ms - int(time.time() * 1000)) <= threshold_ms

    async def get_recording_agent_bearer(self, fid: int) -> str:
        """Mint or return-from-cache a bearer for the given recording-
        agent FID.

        Each agent FID is a separate Farcaster identity backed by its
        OWN custody EOA — declared in
        ``Settings.recording_agent_custody_keys()``. The agent must be
        listed in ``JUKE_RECORDING_AGENT_FIDS`` *and* have a custody key
        registered for it; otherwise this raises
        ``FarcasterSpacesConfigError`` (router translates to 503).

        The cache + mint lock layout matches the service-FID path:
        re-entrancy under contention is safe (double-check pattern
        inside the lock).
        """
        if fid not in set(self._settings.recording_agent_fids_resolved()):
            raise FarcasterSpacesConfigError(
                f"fid {fid} not registered as recording agent"
            )
        custody_keys = self._settings.recording_agent_custody_keys()
        private_key = custody_keys.get(fid)
        if not private_key:
            raise FarcasterSpacesConfigError(
                f"recording-agent fid {fid} has no custody key configured"
            )
        if not self._agent_bearer_needs_refresh(fid):
            return self._agent_bearer_cache[fid][0]

        async with self._agent_mint_lock:
            if not self._agent_bearer_needs_refresh(fid):
                return self._agent_bearer_cache[fid][0]
            secret, expires_at_ms = await self._mint_bearer_for_key(
                private_key, log_label=f"agent fid={fid}"
            )
            self._agent_bearer_cache[fid] = (secret, expires_at_ms)
            return secret

    async def pick_available_recording_agent(self) -> tuple[int, str] | None:
        """Reserve the first agent FID not currently dispatched and
        return ``(fid, bearer)``.

        Returns ``None`` when no agent FIDs are configured OR every
        configured agent is already busy. Caller is responsible for
        calling :py:meth:`release_recording_agent` when the recording
        ends — release in a finally-block at the call site.

        Reserve-and-mint are NOT atomic: the busy bit flips before the
        bearer mint so a concurrent caller can't grab the same agent
        mid-mint. If the mint subsequently fails the agent is released
        before the exception propagates.
        """
        async with self._agent_busy_lock:
            chosen: int | None = None
            for fid in self._settings.recording_agent_fids_resolved():
                if not self._agent_busy.get(fid):
                    chosen = fid
                    self._agent_busy[fid] = True
                    break
            if chosen is None:
                return None
        try:
            bearer = await self.get_recording_agent_bearer(chosen)
        except BaseException:
            # Release the busy bit so a later call can retry. We don't
            # want a flaky mint to permanently sideline an agent.
            async with self._agent_busy_lock:
                self._agent_busy.pop(chosen, None)
            raise
        return chosen, bearer

    async def release_recording_agent(self, fid: int) -> None:
        """Mark ``fid`` as available for the next dispatch.

        Idempotent: releasing a fid that wasn't busy is a no-op (the
        recording-agent stop path is invoked from multiple cleanup
        points and double-release is benign).
        """
        async with self._agent_busy_lock:
            self._agent_busy.pop(fid, None)

    # -----------------------------------------------------------------
    # Per-developer-app bot bearer mint + cache
    # -----------------------------------------------------------------

    def _allowed_custody_key_refs(self) -> dict[str, frozenset[str]]:
        """Parse ``DEVELOPER_CUSTODY_KEY_REFS`` into ``{app_id: {VAR,...}}``.

        Malformed entries and names without
        :data:`DEVELOPER_CUSTODY_ENV_PREFIX` are ignored, so the allowlist
        fails closed.
        """
        raw = getattr(self._settings, "DEVELOPER_CUSTODY_KEY_REFS", "") or ""
        allowed: dict[str, set[str]] = {}
        for entry in raw.split(","):
            app_part, sep, var_part = entry.strip().partition(":")
            app_part, var_part = app_part.strip(), var_part.strip()
            if not sep or not app_part or not var_part:
                continue
            if not var_part.startswith(DEVELOPER_CUSTODY_ENV_PREFIX):
                continue
            try:
                app_key = str(UUID(app_part))
            except ValueError:
                continue
            allowed.setdefault(app_key, set()).add(var_part)
        return {app: frozenset(names) for app, names in allowed.items()}

    def _resolve_custody_key_ref(self, ref: str | None, *, app_id: UUID) -> str:
        """Resolve a legacy ``custody_key_ref`` to its hex private key.

        Only the ``env:<NAME>`` scheme is supported, and only when the exact
        ``(app_id, NAME)`` pair is in the admin-maintained
        ``DEVELOPER_CUSTODY_KEY_REFS`` allowlist and ``NAME`` starts with
        :data:`DEVELOPER_CUSTODY_ENV_PREFIX`. Without that gate the ref was a
        read primitive over every server environment variable.

        Every failure raises ``FarcasterSpacesConfigError`` with the same
        message and logs no var name. The returned value is never logged.
        """
        if not isinstance(ref, str) or not ref.startswith(CUSTODY_KEY_REF_ENV_SCHEME):
            raise FarcasterSpacesConfigError(CUSTODY_KEY_REF_FAILED)
        env_var = ref[len(CUSTODY_KEY_REF_ENV_SCHEME) :].strip()
        allowed_for_app = self._allowed_custody_key_refs().get(str(app_id))
        if (
            not env_var.startswith(DEVELOPER_CUSTODY_ENV_PREFIX)
            or not allowed_for_app
            or env_var not in allowed_for_app
        ):
            logger.warning(
                "[farcaster-spaces] custody_key_ref not allowlisted app_id=%s",
                app_id,
            )
            raise FarcasterSpacesConfigError(CUSTODY_KEY_REF_FAILED)
        value = os.environ.get(env_var)
        if not value:
            logger.warning(
                "[farcaster-spaces] allowlisted custody_key_ref unset app_id=%s",
                app_id,
            )
            raise FarcasterSpacesConfigError(CUSTODY_KEY_REF_FAILED)
        return value

    async def _verify_custody_key_matches(
        self, bot: DeveloperAppBot, private_key: str
    ) -> None:
        """Refuse to mint unless the resolved key IS the bot's custody key.

        The address derived from ``private_key`` must equal both the
        registered ``bot.custody_address`` and the fid's current on-chain
        custody address (IdRegistry). Any mismatch, lookup failure or
        unparsable key raises the uniform ``FarcasterSpacesConfigError``.
        """
        try:
            derived = Account.from_key(private_key).address
        except Exception:
            logger.warning(
                "[farcaster-spaces] custody key unparsable app_id=%s fid=%s",
                bot.app_id,
                bot.fid,
            )
            raise FarcasterSpacesConfigError(CUSTODY_KEY_REF_FAILED) from None
        registered = bot.custody_address or ""
        if derived.lower() != registered.lower():
            logger.warning(
                "[farcaster-spaces] custody key != registered address "
                "app_id=%s fid=%s",
                bot.app_id,
                bot.fid,
            )
            raise FarcasterSpacesConfigError(CUSTODY_KEY_REF_FAILED)
        try:
            onchain = await key_gateway.custody_of(bot.fid)
        except KeyGatewayError as exc:
            logger.warning(
                "[farcaster-spaces] custody lookup failed app_id=%s fid=%s err=%s",
                bot.app_id,
                bot.fid,
                type(exc).__name__,
            )
            raise FarcasterSpacesConfigError(CUSTODY_KEY_REF_FAILED) from None
        if onchain is None or onchain.lower() != derived.lower():
            logger.warning(
                "[farcaster-spaces] custody key != on-chain custody "
                "app_id=%s fid=%s",
                bot.app_id,
                bot.fid,
            )
            raise FarcasterSpacesConfigError(CUSTODY_KEY_REF_FAILED)

    def _dev_bot_bearer_needs_refresh(self, app_id: UUID, fid: int) -> bool:
        """Mirror of :py:meth:`_bearer_needs_refresh` for the per-bot
        cache."""
        cached = self._dev_bot_bearer_cache.get((app_id, fid))
        if cached is None:
            return True
        _secret, expires_at_ms = cached
        threshold_ms = (
            self._settings.JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS
            * 60
            * 60
            * 1000
        )
        return (expires_at_ms - int(time.time() * 1000)) <= threshold_ms

    async def get_developer_bot_bearer(
        self, app_id: UUID, fid: int, db: AsyncSession
    ) -> str:
        """Mint or return-from-cache a bearer for a developer-owned
        bot FID.

        Unlike :py:meth:`get_recording_agent_bearer` (which reads from
        the global ``JUKE_RECORDING_AGENT_FIDS`` pool), the developer-
        bot registry is **per-app**. The same FID may be registered
        under multiple apps and each gets its own cached bearer keyed
        by ``(app_id, fid)``.

        Looks up the active row in ``developer_app_bots`` scoped to
        ``app_id`` (defense-in-depth: even if the router auth gate was
        bypassed, the service still refuses to mint for a row owned by
        a different app). Resolves ``custody_key_ref`` via the documented
        scheme dispatch (``env:<VAR>`` for Phase-4 scaffolding), then
        calls the shared ``_mint_bearer_for_key`` backbone.

        Two auth modes are supported (dispatched on ``bot.auth_mode``):

        * ``custody_env`` (legacy) — resolve ``custody_key_ref`` to a
          custody EOA private key and mint an EIP-191 bearer, cached per
          ``(app_id, fid)``.
        * ``app_key`` (managed) — mint a JFS bearer directly from the
          Juke-held Ed25519 signer. These are NOT cached: signing is
          cheap and the bearers carry a 300s TTL, so a fresh one is
          minted per request.

        Raises ``FarcasterSpacesConfigError`` if:
        * No active row exists for ``(app_id, fid)``.
        * The custody key reference cannot be resolved, or (managed mode)
          the signer's key material can't be decrypted / the encryption
          key is misconfigured.
        For managed bots that aren't approved yet, ``BotSignerNotReady``
        propagates UNCAUGHT so routers can map it to an actionable 409
        (distinct from the opaque 503 that config/crypto failures get).
        Routers translate ``FarcasterSpacesConfigError`` to HTTP 403 / 503.
        """
        # Service-layer ownership + liveness check. This runs BEFORE the
        # bearer cache so deactivating (or deleting) a bot takes effect
        # immediately instead of after the cached bearer's lifetime.
        # The router already enforces ownership via ``verified_key.app_id`` matching, but we re-verify
        # here so an internal caller cannot accidentally skip the gate.
        result = await db.execute(
            select(DeveloperAppBot).where(
                DeveloperAppBot.app_id == app_id,
                DeveloperAppBot.fid == fid,
                DeveloperAppBot.is_active.is_(True),
            )
        )
        bot = result.scalar_one_or_none()
        if bot is None:
            self._dev_bot_bearer_cache.pop((app_id, fid), None)
            raise FarcasterSpacesConfigError(
                f"no active bot for app/fid (app_id={app_id}, fid={fid})"
            )

        if bot.auth_mode == AUTH_MODE_APP_KEY:
            # Managed Ed25519 signer: mint per request, never cache.
            # ``BotSignerNotReady`` (not approved / no key material) is
            # deliberately NOT caught here — it propagates typed so the
            # router can 409. Config/crypto failures are recast to
            # ``FarcasterSpacesConfigError`` so they take the existing
            # opaque-503 path and never leak which knob is wrong.
            try:
                return await mint_bearer_for_bot(bot)
            except (BotSignerConfigError, BotSignerCryptoError) as exc:
                raise FarcasterSpacesConfigError(
                    "managed bot signer unavailable"
                ) from exc

        if not self._dev_bot_bearer_needs_refresh(app_id, fid):
            return self._dev_bot_bearer_cache[(app_id, fid)][0]

        private_key = self._resolve_custody_key_ref(bot.custody_key_ref, app_id=app_id)
        await self._verify_custody_key_matches(bot, private_key)

        async with self._dev_bot_mint_lock:
            # Double-check under lock — another coroutine may have just
            # minted for the same (app_id, fid).
            if not self._dev_bot_bearer_needs_refresh(app_id, fid):
                return self._dev_bot_bearer_cache[(app_id, fid)][0]
            secret, expires_at_ms = await self._mint_bearer_for_key(
                private_key, log_label=f"dev-bot app={app_id} fid={fid}"
            )
            self._dev_bot_bearer_cache[(app_id, fid)] = (
                secret,
                expires_at_ms,
            )
            return secret

    # -----------------------------------------------------------------
    # Native-room create — call client.farcaster.xyz/v1/audio-rooms
    # -----------------------------------------------------------------

    async def create_audio_room_with_bearer(
        self,
        *,
        bearer: str,
        title: str,
        scheduled_at: datetime | None = None,
        channel_key: str | None = None,
    ) -> dict[str, Any]:
        """Create an upstream Farcaster audio room using a caller-supplied
        bearer (developer-API path).

        Calls ``POST /v1/audio-rooms`` with the bot's bearer + an
        optional schedule + channel key. Returns the upstream ``result``
        payload — at minimum a ``roomId`` field that callers persist to
        ``rooms.farcaster_room_id``.

        The bearer must already have been minted for a bot FID the
        caller owns (see :py:meth:`get_developer_bot_bearer`). This
        method does NOT mint or validate ownership — that's the caller
        responsibility.
        """
        return await self._post_create_audio_room(
            bearer=bearer,
            title=title,
            scheduled_at=scheduled_at,
            channel_key=channel_key,
        )

    async def create_audio_room(
        self,
        *,
        title: str,
        description: str | None = None,
        scheduled_at: datetime | None = None,
        channel_key: str | None = None,
        as_user_bearer: str | None = None,
    ) -> AudioRoom:
        """Create a Farcaster-native audio room.

        When ``as_user_bearer`` is supplied it is used verbatim as the
        upstream ``Authorization`` header — the upstream room will be
        hosted by whichever FID signed that JFS Bearer. When absent we
        fall back to the cached service-FID bearer (Juke's service FID
        becomes the technical upstream host; the router prefixes the
        title with ``@username:`` to attribute the human host).

        POSTs to ``client.farcaster.xyz/v1/audio-rooms`` with
        ``{title, description?, scheduledAt?, channelKey?}``.
        ``scheduled_at`` is sent as an ISO-8601 string (see
        :py:func:`_format_scheduled_at`) — the upstream endpoint rejects
        an epoch-millis integer with "scheduledAt must be a valid future
        timestamp" and returns the field in ISO form itself. Returns a
        parsed :py:class:`AudioRoom` from the envelope's ``result.room``
        (the same shape ``GET /v1/audio-room`` produces).

        Raises:
          * :class:`FarcasterSpacesConfigError` — service-FID path only,
            custody key not configured (router translates to 503).
          * :class:`httpx.HTTPError` — upstream rejected or transport
            failed after retries (router translates to 502).
          * :class:`ValueError` — upstream returned a malformed envelope
            (router translates to 502).

        NEVER logs the bearer token or attaches it to a propagating
        exception (``_redact_auth`` strips it from the captured request
        before re-raise).
        """
        bearer = (
            as_user_bearer if as_user_bearer is not None else await self._get_bearer()
        )
        result = await self._post_create_audio_room(
            bearer=bearer,
            title=title,
            description=description,
            scheduled_at=scheduled_at,
            channel_key=channel_key,
        )
        room_obj = result.get("room")
        if not isinstance(room_obj, dict):
            # Some variants flatten — tolerate ``result`` itself being
            # the room payload.
            if isinstance(result.get("id"), str):
                room_obj = result
            else:
                raise ValueError("create_audio_room response missing result.room")
        return AudioRoom.model_validate(room_obj)

    async def _post_create_audio_room(
        self,
        *,
        bearer: str,
        title: str,
        description: str | None = None,
        scheduled_at: datetime | None = None,
        channel_key: str | None = None,
    ) -> dict[str, Any]:
        """Shared POST backbone for ``create_audio_room*`` callers.

        Posts the canonical request, raises a redacted ``HTTPStatusError``
        on >=400 (Authorization header stripped from the request object),
        retries 5xx + network errors via :py:meth:`_retrying`, and
        returns the upstream ``result`` dict.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-rooms"
        headers = self._common_headers(bearer)
        payload: dict[str, Any] = {"title": title}
        if description is not None:
            payload["description"] = description
        if scheduled_at is not None:
            payload["scheduledAt"] = _format_scheduled_at(scheduled_at)
        if channel_key:
            payload["channelKey"] = channel_key

        async def op() -> dict[str, Any]:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-rooms status=%d " "body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"create_audio_room failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            try:
                data = resp.json()
            except Exception as e:
                logger.warning(
                    "[farcaster-spaces] create_audio_room response was " "not JSON: %s",
                    type(e).__name__,
                )
                raise
            result = (data or {}).get("result")
            if not isinstance(result, dict):
                raise ValueError("create_audio_room response missing result")
            return result

        return await self._retrying(op, path_for_log="POST /v1/audio-rooms")

    # -----------------------------------------------------------------
    # Host-side lifecycle — end the room / invite the human host onto
    # the speaker stage. Both run through the service-FID bearer; the
    # service FID is the technical host of every backend-orchestrated
    # native room, so it's the only FID upstream will accept for these
    # endpoints.
    # -----------------------------------------------------------------

    async def start_scheduled_audio_room(
        self, room_id: str, *, bearer: str | None = None
    ) -> AudioRoom | None:
        """Call ``POST /v1/audio-room/start-scheduled`` to flip a
        scheduled room's upstream state from ``scheduled`` to ``live``.
        Host-only upstream.

        Two host-mode paths mirror :py:meth:`end_audio_room`:

        * **User-FID hosted rooms** (default ``user_fid`` create path).
          The upstream host is the human user, so the service bearer
          403s. Caller MUST pass the user's freshly-signed JFS bearer via
          ``bearer=`` — it's forwarded verbatim as the Authorization
          header.
        * **Service-FID hosted rooms** (legacy ``service_fid`` create
          path). Caller leaves ``bearer`` unset; we mint with the cached
          service bearer.

        Returns the parsed :class:`AudioRoom` (now ``state="live"``) from
        the envelope's ``result.room`` on 2xx, or ``None`` when upstream
        omits the room payload. A 4xx raises ``httpx.HTTPStatusError``
        (the router maps it to 4xx/502 — e.g. "not the host", "not in
        scheduled state"); 5xx + network errors retry through the shared
        backoff. NEVER logs the bearer (``_redact_auth`` strips it from
        the captured request before re-raise).
        """
        bearer = bearer if bearer is not None else await self._get_bearer()
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/start-scheduled"
        headers = self._common_headers(bearer)
        payload = {"roomId": room_id}

        async def op() -> dict[str, Any]:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/start-scheduled "
                    "status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"start-scheduled failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            try:
                data = resp.json()
            except Exception as e:
                logger.warning(
                    "[farcaster-spaces] start-scheduled response was not JSON: %s",
                    type(e).__name__,
                )
                # 2xx-but-malformed body: the captured request still
                # carries the Authorization header. Strip it before the
                # exception escapes into any logger.exception / Sentry frame.
                _redact_auth(resp.request)
                raise
            result = (data or {}).get("result")
            if not isinstance(result, dict):
                raise ValueError("start-scheduled response missing result")
            return result

        result = await self._retrying(
            op, path_for_log="POST /v1/audio-room/start-scheduled"
        )
        room_raw = result.get("room")
        if not isinstance(room_raw, dict):
            return None
        try:
            return AudioRoom.model_validate(room_raw)
        except Exception as e:  # noqa: BLE001 — schema drift tolerance
            logger.warning(
                "[farcaster-spaces] start-scheduled result.room malformed: %s",
                type(e).__name__,
            )
            return None

    async def end_audio_room(
        self, room_id: str, *, bearer: str | None = None
    ) -> AudioRoom | None:
        """Call ``POST /v1/audio-room/end``.

        Only the upstream host FID is allowed to end a room — Farcaster
        403s any other caller. Two host-mode paths:

        * **Service-FID hosted rooms** (legacy ``service_fid`` create
          path). The caller leaves ``bearer`` unset; we mint with the
          cached service bearer. Juke's service FID IS the upstream
          host so this works.
        * **User-FID hosted rooms** (current default ``user_fid`` create
          path — see ``POST /v1/audio-rooms`` with ``user_jfs_bearer``).
          The upstream host is the human user, not the service FID, so
          the service bearer 403s. Caller MUST pass the user's
          freshly-signed JFS bearer via ``bearer=`` and it's forwarded
          verbatim as the Authorization header.

        Returns the parsed :class:`AudioRoom` from the envelope's
        ``result.room`` on 2xx, or ``None`` when the upstream returns a
        4xx (most often "room already ended" — surfaced as ``None`` so
        callers can keep their flow idempotent without distinguishing
        first-end from re-end). 5xx + network errors retry through the
        shared backoff and surface as ``httpx.HTTPError``. NEVER logs
        the bearer.
        """
        bearer = bearer if bearer is not None else await self._get_bearer()
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/end"
        headers = self._common_headers(bearer)
        payload = {"roomId": room_id}

        async def op() -> dict[str, Any] | None:
            resp = await client.post(url, headers=headers, json=payload)
            if 400 <= resp.status_code < 500:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/end status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                return None
            if resp.status_code >= 500:
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"end_audio_room failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            try:
                return resp.json()
            except Exception as e:
                logger.warning(
                    "[farcaster-spaces] end_audio_room response was not JSON: %s",
                    type(e).__name__,
                )
                raise

        env = await self._retrying(op, path_for_log="POST /v1/audio-room/end")
        if env is None:
            return None
        room_raw = (env.get("result") or {}).get("room")
        if not room_raw:
            return None
        try:
            return AudioRoom.model_validate(room_raw)
        except Exception as e:  # noqa: BLE001 — schema drift tolerance
            logger.warning(
                "[farcaster-spaces] end_audio_room result.room malformed: %s",
                type(e).__name__,
            )
            return None

    async def invite_speaker(self, room_id: str, target_fid: int) -> None:
        """Call ``POST /v1/audio-room/accept-speaker`` with the service
        bearer to unsolicit-invite ``target_fid`` onto the stage.

        Per Quorum's reverse-engineering of the upstream behavior, when
        the target hasn't raised their hand this fires an unsolicited
        invite that queues server-side and surfaces as a "stage invite"
        prompt the moment the target joins the room. Used at native-room
        create time so the human host lands as a speaker the first time
        they tap "Open in Warpcast".

        Best-effort: any non-2xx is logged and swallowed (the worst-case
        is the host joining as a listener and tapping raise-hand). NEVER
        logs the bearer.
        """
        try:
            bearer = await self._get_bearer()
        except FarcasterSpacesConfigError:
            logger.info(
                "[farcaster-spaces] invite_speaker skipped: service not "
                "configured (room=%s fid=%d)",
                room_id,
                target_fid,
            )
            return

        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/accept-speaker"
        headers = self._common_headers(bearer)
        # Farcaster's accept/remove-speaker upstream requires the target as
        # ``fid``; ``targetFid`` is kept for backward compatibility (extra
        # props are tolerated). Sending only ``targetFid`` yields a 400
        # ("must have required property 'fid'").
        payload = {
            "roomId": room_id,
            "fid": int(target_fid),
            "targetFid": int(target_fid),
        }

        try:
            resp = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as e:
            logger.info(
                "[farcaster-spaces] invite_speaker network error "
                "(room=%s fid=%d): %s",
                room_id,
                target_fid,
                type(e).__name__,
            )
            return

        if resp.status_code >= 400:
            body = ""
            try:
                body = resp.text
            except Exception:  # pragma: no cover
                body = ""
            logger.info(
                "[farcaster-spaces] invite_speaker non-2xx "
                "(room=%s fid=%d) status=%d body=%s",
                room_id,
                target_fid,
                resp.status_code,
                _trimmed(body),
            )
            return

        logger.info(
            "[farcaster-spaces] invite_speaker ok (room=%s fid=%d)",
            room_id,
            target_fid,
        )

    async def invite_speaker_with_retry(
        self,
        room_id: str,
        target_fid: int,
        *,
        is_room_ended: Callable[[], Awaitable[bool]] | None = None,
        max_attempts: int = 6,
        delays_seconds: tuple[float, ...] = (2.0, 5.0, 10.0, 15.0, 15.0, 15.0),
    ) -> bool:
        """Fire :py:meth:`invite_speaker` up to ``max_attempts`` times on
        a bounded backoff, stopping early when the target is already on
        stage or the room ends.

        Upstream behavior context: when the create handler dispatches an
        invite immediately after ``POST /v1/audio-rooms`` the upstream
        often no-ops (the human host hasn't joined the upstream room yet,
        so there's no participant record to flip to ``speaker``). The
        retry loop trades a small wall-clock budget (~60s) for far better
        odds the invite lands the moment the host taps "Open in Warpcast".

        Returns ``True`` iff (a) an upstream ``accept-speaker`` call
        returned 2xx within the budget, or (b) a participants check shows
        the target is already on stage (host/cohost/speaker). Returns
        ``False`` if every attempt failed, the room ended mid-loop, or
        the loop body raised. NEVER raises — this method is designed for
        ``asyncio.create_task`` fire-and-forget callers and a raise here
        would surface only as an unhandled task exception in the log.

        Each attempt logs at DEBUG/INFO with just the outcome tag (HTTP
        status code, exception class name) — NEVER the bearer or upstream
        response body.

        Parameters:
          * ``is_room_ended`` — optional callable returning ``True`` when
            the Juke ``Room.status`` flips to ``ended``. Lets the host's
            "End" tap bail the loop out without waiting for the upstream
            to reject. Callers reusing a request-scoped DB session must
            instead pass a callable that opens a fresh session (the
            request session closes when the handler returns).
          * ``max_attempts`` / ``delays_seconds`` — bounded retry budget.
            ``delays_seconds`` is indexed up to ``len() - 1``; if
            ``max_attempts`` exceeds the tuple length the final delay
            value is reused (clamped). Tests use ``(0.0, 0.0, ...)`` so
            the loop runs synchronously without consuming wall-clock.
        """
        try:
            return await self._run_invite_with_retry_loop(
                room_id=room_id,
                target_fid=target_fid,
                is_room_ended=is_room_ended,
                max_attempts=max_attempts,
                delays_seconds=delays_seconds,
            )
        except BaseException as exc:  # noqa: BLE001 — best-effort guard
            logger.warning(
                "[farcaster-spaces] invite_with_retry loop failed "
                "(room=%s fid=%d): %s",
                room_id,
                target_fid,
                type(exc).__name__,
            )
            return False

    async def _run_invite_with_retry_loop(
        self,
        *,
        room_id: str,
        target_fid: int,
        is_room_ended: Callable[[], Awaitable[bool]] | None,
        max_attempts: int,
        delays_seconds: tuple[float, ...],
    ) -> bool:
        """Inner body for :py:meth:`invite_speaker_with_retry`. Split out
        so the outer guard can wrap everything in a single try/except
        without inlining the loop logic in an except branch."""
        # Resolve the bearer up front so config-missing surfaces as a
        # single skip log instead of N retry-log lines.
        try:
            await self._get_bearer()
        except FarcasterSpacesConfigError:
            logger.info(
                "[farcaster-spaces] invite_with_retry skipped: service "
                "not configured (room=%s fid=%d)",
                room_id,
                target_fid,
            )
            return False

        if not delays_seconds:
            # Defensive — caller passing an empty tuple would otherwise
            # blow on the index lookup. Treat as zero-delay.
            delays_seconds = (0.0,)

        for attempt in range(max_attempts):
            # Bail-out check #1: the host ended the room before the invite
            # landed. No point hammering the upstream after that.
            if is_room_ended is not None:
                try:
                    if await is_room_ended():
                        logger.info(
                            "[farcaster-spaces] invite_with_retry "
                            "cancelled: room ended (room=%s fid=%d "
                            "attempt=%d)",
                            room_id,
                            target_fid,
                            attempt + 1,
                        )
                        return False
                except Exception as exc:  # noqa: BLE001 — checker is best-effort
                    logger.debug(
                        "[farcaster-spaces] invite_with_retry "
                        "is_room_ended check error "
                        "(room=%s fid=%d attempt=%d): %s",
                        room_id,
                        target_fid,
                        attempt + 1,
                        type(exc).__name__,
                    )

            # Bail-out check #2: the target is already on stage — either
            # they accepted the previous invite or a cohost promoted them.
            if await self._target_already_on_stage(room_id, target_fid):
                logger.info(
                    "[farcaster-spaces] invite_with_retry skipped: "
                    "target already on stage (room=%s fid=%d attempt=%d)",
                    room_id,
                    target_fid,
                    attempt + 1,
                )
                return True

            status_code = await self._try_invite_speaker(room_id, target_fid)
            if status_code is not None and 200 <= status_code < 300:
                logger.info(
                    "[farcaster-spaces] invite_with_retry ok "
                    "(room=%s fid=%d attempt=%d)",
                    room_id,
                    target_fid,
                    attempt + 1,
                )
                return True

            logger.debug(
                "[farcaster-spaces] invite_with_retry attempt %d failed "
                "(room=%s fid=%d) status=%s",
                attempt + 1,
                room_id,
                target_fid,
                status_code if status_code is not None else "error",
            )

            # Don't sleep after the final attempt — caller's budget is up.
            if attempt < max_attempts - 1:
                delay_index = min(attempt, len(delays_seconds) - 1)
                await asyncio.sleep(delays_seconds[delay_index])

        return False

    async def _target_already_on_stage(self, room_id: str, target_fid: int) -> bool:
        """Best-effort check whether ``target_fid`` already sits on the
        upstream stage as host / cohost / speaker.

        Returns ``False`` on any error — the retry loop must keep
        progressing even when the participants endpoint blips. NEVER
        raises.
        """
        try:
            participants = await self.get_participants(room_id)
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.debug(
                "[farcaster-spaces] participants probe failed " "(room=%s fid=%d): %s",
                room_id,
                target_fid,
                type(exc).__name__,
            )
            return False
        on_stage_roles = {"host", "cohost", "speaker"}
        for p in participants:
            user_fid = getattr(getattr(p, "user", None), "fid", None)
            if user_fid == target_fid and p.role in on_stage_roles:
                return True
        return False

    async def _try_invite_speaker(self, room_id: str, target_fid: int) -> int | None:
        """Issue a single ``accept-speaker`` call and return the upstream
        HTTP status code, or ``None`` if the call raised before we got a
        response.

        Logs at DEBUG with the outcome tag (status / exception class) —
        NEVER the bearer or body. Used as the inner step of
        :py:meth:`invite_speaker_with_retry`; not exported.
        """
        try:
            bearer = await self._get_bearer()
        except FarcasterSpacesConfigError:
            # Already logged once at loop entry; treat config-missing
            # as a terminal failure for the attempt.
            return None

        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/accept-speaker"
        headers = self._common_headers(bearer)
        # Farcaster's accept/remove-speaker upstream requires the target as
        # ``fid``; ``targetFid`` is kept for backward compatibility (extra
        # props are tolerated). Sending only ``targetFid`` yields a 400
        # ("must have required property 'fid'").
        payload = {
            "roomId": room_id,
            "fid": int(target_fid),
            "targetFid": int(target_fid),
        }

        try:
            resp = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as e:
            logger.debug(
                "[farcaster-spaces] invite_with_retry network error "
                "(room=%s fid=%d): %s",
                room_id,
                target_fid,
                type(e).__name__,
            )
            return None
        return resp.status_code

    # -----------------------------------------------------------------
    # Recording-agent join — call client.farcaster.xyz/v1/audio-room/join
    # -----------------------------------------------------------------

    async def join_room_as_listener(
        self, *, room_id: str, bearer: str
    ) -> dict[str, Any]:
        """Call ``POST /v1/audio-room/join`` to obtain LiveKit signaling
        URL + token for the bearer's FID.

        Returns the upstream envelope's ``result`` payload (a dict at
        least containing ``token`` and one of ``wsUrl`` / ``url``).
        Used by the recording-agent dispatcher to acquire the join
        token the Node worker will hand to LiveKit.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/join"
        headers = self._common_headers(bearer)
        payload = {"roomId": room_id}

        async def op() -> dict[str, Any]:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/join status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"join failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            try:
                data = resp.json()
            except Exception as e:
                logger.warning(
                    "[farcaster-spaces] join response was not JSON: %s",
                    type(e).__name__,
                )
                raise
            result = (data or {}).get("result")
            if not isinstance(result, dict):
                raise ValueError("join response missing result")
            return result

        return await self._retrying(op, path_for_log="POST /v1/audio-room/join")

    # -----------------------------------------------------------------
    # Stage controls (user-FID JFS bearer required)
    # -----------------------------------------------------------------
    #
    # The three calls below all need the caller's own JFS bearer, NOT
    # the service-FID bearer:
    #
    #   * raise-hand: the listener is signaling THEIR intent. Service
    #     bearer 403s upstream.
    #   * accept-speaker: the host is approving a hand-raise (or
    #     proactively inviting). For user-FID hosted rooms the upstream
    #     host is the human, so only their bearer authorizes this.
    #   * remove-speaker: same posture as accept.
    #
    # All three follow the same simple shape: POST envelope, 2xx → ok,
    # 4xx → raise (router translates), 5xx → retried by the upstream
    # `_retrying` helper.

    async def raise_hand(self, *, room_id: str, raised: bool, bearer: str) -> None:
        """Call ``POST /v1/audio-room/raise-hand`` with the caller's
        bearer. ``raised=True`` to raise; ``raised=False`` to lower.

        2xx → returns. 4xx → ``httpx.HTTPStatusError``. 5xx → retried.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/raise-hand"
        headers = self._common_headers(bearer)
        payload = {"roomId": room_id, "raised": bool(raised)}

        async def op() -> None:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/raise-hand "
                    "status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"raise-hand failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            return None

        await self._retrying(op, path_for_log="POST /v1/audio-room/raise-hand")

    async def heartbeat(
        self, *, room_id: str, active_speaker_fids: list[int], bearer: str
    ) -> None:
        """Call ``POST /v1/audio-room/heartbeat`` with the caller's bearer to
        report active-speaker activity, resetting the room's host-inactivity
        timer.

        2xx → returns. 4xx → ``httpx.HTTPStatusError``. 5xx → retried.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/heartbeat"
        headers = self._common_headers(bearer)
        payload = {"roomId": room_id, "activeSpeakerFids": active_speaker_fids}

        async def op() -> None:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/heartbeat "
                    "status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"heartbeat failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            return None

        await self._retrying(op, path_for_log="POST /v1/audio-room/heartbeat")

    async def accept_speaker_as_user(
        self, *, room_id: str, target_fid: int, bearer: str
    ) -> None:
        """Call ``POST /v1/audio-room/accept-speaker`` with the host's
        own bearer (vs. ``invite_speaker`` which uses the service bearer
        for backend-orchestrated rooms).

        Used by the host of a user-FID hosted native room to promote a
        listener to speaker — typically after the listener has raised
        their hand. 2xx → returns. 4xx → ``httpx.HTTPStatusError``.
        5xx → retried.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/accept-speaker"
        headers = self._common_headers(bearer)
        # Farcaster's accept/remove-speaker upstream requires the target as
        # ``fid``; ``targetFid`` is kept for backward compatibility (extra
        # props are tolerated). Sending only ``targetFid`` yields a 400
        # ("must have required property 'fid'").
        payload = {
            "roomId": room_id,
            "fid": int(target_fid),
            "targetFid": int(target_fid),
        }

        async def op() -> None:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/accept-speaker "
                    "status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"accept-speaker failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            return None

        await self._retrying(op, path_for_log="POST /v1/audio-room/accept-speaker")

    async def remove_speaker_as_user(
        self, *, room_id: str, target_fid: int, bearer: str
    ) -> None:
        """Call ``POST /v1/audio-room/remove-speaker`` with the host's
        own bearer. Demotes a speaker back to listener.

        2xx → returns. 4xx → ``httpx.HTTPStatusError``. 5xx → retried.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/remove-speaker"
        headers = self._common_headers(bearer)
        # Farcaster's accept/remove-speaker upstream requires the target as
        # ``fid``; ``targetFid`` is kept for backward compatibility (extra
        # props are tolerated). Sending only ``targetFid`` yields a 400
        # ("must have required property 'fid'").
        payload = {
            "roomId": room_id,
            "fid": int(target_fid),
            "targetFid": int(target_fid),
        }

        async def op() -> None:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/remove-speaker "
                    "status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"remove-speaker failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            return None

        await self._retrying(op, path_for_log="POST /v1/audio-room/remove-speaker")

    async def accept_stage_invite_as_user(self, *, room_id: str, bearer: str) -> None:
        """Call ``POST /v1/audio-room/accept-stage-invite`` with the
        invitee's own bearer.

        Used when a Juke user receives a pending stage invite (host has
        invited them to speak). The next participants snapshot will
        show their role flipped to ``speaker`` / ``cohost`` and LiveKit
        will publish-enable the local participant.

        2xx → returns. 4xx → ``httpx.HTTPStatusError``. 5xx → retried.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/accept-stage-invite"
        headers = self._common_headers(bearer)
        payload = {"roomId": room_id}

        async def op() -> None:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/accept-stage-invite "
                    "status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"accept-stage-invite failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            return None

        await self._retrying(op, path_for_log="POST /v1/audio-room/accept-stage-invite")

    async def decline_stage_invite_as_user(self, *, room_id: str, bearer: str) -> None:
        """Call ``POST /v1/audio-room/decline-stage-invite`` with the
        invitee's own bearer.

        2xx → returns. 4xx → ``httpx.HTTPStatusError``. 5xx → retried.
        """
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}/v1/audio-room/decline-stage-invite"
        headers = self._common_headers(bearer)
        payload = {"roomId": room_id}

        async def op() -> None:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] POST /v1/audio-room/decline-stage-invite "
                    "status=%d body=%s",
                    resp.status_code,
                    _trimmed(body),
                )
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"decline-stage-invite failed: {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            return None

        await self._retrying(
            op, path_for_log="POST /v1/audio-room/decline-stage-invite"
        )

    # -----------------------------------------------------------------
    # GET helpers
    # -----------------------------------------------------------------

    def _common_headers(self, bearer: str) -> dict[str, str]:
        return {
            "accept": "*/*",
            "content-type": "application/json; charset=utf-8",
            "authorization": f"Bearer {bearer}",
            "origin": "https://farcaster.xyz",
            "referer": "https://farcaster.xyz/",
        }

    async def _retrying(
        self,
        op: Callable[[], Awaitable[T]],
        *,
        path_for_log: str,
    ) -> T:
        """Run ``op`` with exponential backoff on 5xx + network errors.

        4xx errors are surfaced immediately (no retry). The 503 case for
        config-missing is caught at the ``_get_bearer`` layer so it
        never enters this retry loop.
        """
        last_exc: BaseException | None = None
        for attempt in range(RETRY_ATTEMPTS):
            try:
                return await op()
            except httpx.HTTPStatusError as e:
                last_exc = e
                if e.response is not None and 500 <= e.response.status_code < 600:
                    logger.warning(
                        "[farcaster-spaces] %s attempt %d failed status=%d",
                        path_for_log,
                        attempt + 1,
                        e.response.status_code,
                    )
                else:
                    raise
            except (httpx.TransportError, httpx.HTTPError) as e:
                last_exc = e
                logger.warning(
                    "[farcaster-spaces] %s attempt %d network error: %s",
                    path_for_log,
                    attempt + 1,
                    type(e).__name__,
                )

            if attempt < RETRY_ATTEMPTS - 1:
                delay = RETRY_BASE_SECONDS * (2**attempt)
                await asyncio.sleep(delay)

        assert last_exc is not None
        raise last_exc

    async def _get_envelope(
        self, path: str, *, allow_404: bool = False
    ) -> dict[str, Any] | None:
        bearer = await self._get_bearer()
        client = self._get_http_client()
        url = f"{FARCASTER_API_BASE_URL}{path}"
        headers = self._common_headers(bearer)

        async def op() -> dict[str, Any] | None:
            resp = await client.get(url, headers=headers)
            if allow_404 and resp.status_code == 404:
                return None
            if resp.status_code >= 400:
                body = ""
                try:
                    body = resp.text
                except Exception:  # pragma: no cover
                    body = ""
                logger.warning(
                    "[farcaster-spaces] GET %s status=%d body=%s",
                    path,
                    resp.status_code,
                    _trimmed(body),
                )
                # Strip outgoing Authorization (the minted bearer) from
                # the captured request before the exception escapes.
                _redact_auth(resp.request)
                raise httpx.HTTPStatusError(
                    f"GET {path} {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            try:
                return resp.json()
            except Exception as e:
                logger.warning(
                    "[farcaster-spaces] GET %s returned non-JSON: %s",
                    path,
                    type(e).__name__,
                )
                raise

        return await self._retrying(op, path_for_log=f"GET {path}")

    # -----------------------------------------------------------------
    # Public discovery API
    # -----------------------------------------------------------------

    async def list_live_rooms(self, limit: int = 30) -> list[AudioRoom]:
        env = await self._get_envelope(f"/v1/audio-rooms?limit={int(limit)}")
        if not env:
            return []
        rooms_raw = (env.get("result") or {}).get("rooms") or []
        return [AudioRoom.model_validate(r) for r in rooms_raw]

    async def list_scheduled_rooms(self, limit: int = 30) -> list[AudioRoom]:
        env = await self._get_envelope(f"/v1/audio-rooms/scheduled?limit={int(limit)}")
        if not env:
            return []
        rooms_raw = (env.get("result") or {}).get("rooms") or []
        return [AudioRoom.model_validate(r) for r in rooms_raw]

    async def get_room(self, room_id: str) -> AudioRoom | None:
        env = await self._get_envelope(
            f"/v1/audio-room?roomId={_qs(room_id)}",
            allow_404=True,
        )
        if env is None:
            return None
        room_raw = (env.get("result") or {}).get("room")
        if not room_raw:
            return None
        return AudioRoom.model_validate(room_raw)

    async def get_participants(self, room_id: str) -> list[AudioRoomParticipant]:
        env = await self._get_envelope(
            f"/v1/audio-room/participants?roomId={_qs(room_id)}"
        )
        if not env:
            return []
        participants_raw = (env.get("result") or {}).get("participants") or []
        return [AudioRoomParticipant.model_validate(p) for p in participants_raw]

    async def get_chat(self, room_id: str) -> list[AudioRoomChatMessage]:
        env = await self._get_envelope(f"/v1/audio-room/chat?roomId={_qs(room_id)}")
        if not env:
            return []
        messages_raw = (env.get("result") or {}).get("messages") or []
        return [AudioRoomChatMessage.model_validate(m) for m in messages_raw]


def _qs(value: str) -> str:
    """Minimal query-string-safe encoder (room IDs are constrained
    base16/base32-ish from upstream, but be defensive)."""
    from urllib.parse import quote

    return quote(value, safe="")
