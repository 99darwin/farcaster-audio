"""Per-user ``client.farcaster.xyz`` bearer for Direct Casts.

Probe B1 (docs/messaging-design.md section 2) showed the Direct Cast HTTP
API and ``wss://ws.farcaster.xyz/stream`` reject ``app_key`` JFS bearers;
they only accept the token minted by ``PUT /v2/onboarding-state`` from a
custody EIP-191 signature. Juke never holds custody keys, so the device
signs ONE ``generateToken`` request with the recovery phrase (at phrase
import, or in the "Enable messages" flow) and the backend:

1. validates the request (method, sane timestamps, expiry at most
   :data:`DC_TOKEN_TTL_MS` out),
2. checks the EIP-191 signature recovers to the FID's on-chain custody
   address (``key_gateway.custody_of``, as the signer flow does),
3. exchanges it upstream
   (``FarcasterSpacesService.mint_bearer_from_signed_request``),
4. stores only the token, AES-GCM encrypted (``signer_crypto``,
   ``SignerPurpose.FARCASTER_TOKEN``, AAD ``fid:<fid>``).

The signature, the token secret and the plaintext blob are never logged,
returned, or attached to an exception. Rows are deleted on logout.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import status
from sqlalchemy import delete, func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import key_gateway
from app.models.user_farcaster_token import UserFarcasterToken
from app.models.user_signer import UserSigner
from app.schemas.farcaster_token import DirectCastAuthRequest, TokenStatus
from app.services import signer_crypto
from app.services.farcaster_spaces_service import (
    FarcasterSpacesService,
    _canonicalize,
)

logger = logging.getLogger(__name__)

MS_PER_SECOND = 1_000
DAY_MS = 24 * 60 * 60 * MS_PER_SECOND
# Product decision: short-lived compared to upstream's 1000-day default.
DC_TOKEN_TTL_DAYS = 90
DC_TOKEN_TTL_MS = DC_TOKEN_TTL_DAYS * DAY_MS
# Device clocks drift; accept a little future skew on both timestamps
# (60 s, docs/messaging-design.md section 2).
CLOCK_SKEW_MS = 60 * MS_PER_SECOND
# A signed request is exchanged right away; older ones are stale replays.
MAX_REQUEST_AGE_MS = 10 * 60 * MS_PER_SECOND
# Treat a token this close to expiry as expired so a request never races it.
EXPIRY_MARGIN = timedelta(minutes=5)

EIP191_PREFIX = "eip191:"
SIGNATURE_BYTES = 65

TOKEN_STATUS_ACTIVE: TokenStatus = "active"
TOKEN_STATUS_MISSING: TokenStatus = "missing"
TOKEN_STATUS_EXPIRED: TokenStatus = "expired"

ENABLE_RATE_LIMIT = 10
ENABLE_RATE_WINDOW_SECONDS = 60 * 60
ENABLE_RATE_KEY_PREFIX = "messages_enable_rate:"

CustodyResolver = Callable[[int], Awaitable[str | None]]


class FarcasterTokenError(Exception):
    """Enabling failed; ``code`` is an opaque client-facing tag."""

    def __init__(self, status_code: int, code: str) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True)
class DirectCastTokenStatus:
    token_status: TokenStatus
    expires_at: datetime | None

    @property
    def is_enabled(self) -> bool:
        return self.token_status == TOKEN_STATUS_ACTIVE


def _now_ms() -> int:
    return int(time.time() * MS_PER_SECOND)


def _as_utc(value: datetime) -> datetime:
    # SQLite (tests) returns naive datetimes for timezone-aware columns.
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _aad(fid: int) -> str:
    return f"fid:{fid}"


def _is_expired(expires_at: datetime, now: datetime) -> bool:
    return _as_utc(expires_at) - EXPIRY_MARGIN <= now


def _decrypt_secret(row: UserFarcasterToken) -> str | None:
    """The stored bearer secret. Never cache or log the return value."""
    plaintext = signer_crypto.decrypt_private_key(
        row.encrypted_token,
        aad=_aad(row.fid),
        purpose=signer_crypto.SignerPurpose.FARCASTER_TOKEN,
    )
    secret = json.loads(plaintext).get("secret")
    return secret if isinstance(secret, str) and secret else None


def _invalid_signature() -> FarcasterTokenError:
    return FarcasterTokenError(status.HTTP_400_BAD_REQUEST, "invalid_signature")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_auth_request(
    auth_request: DirectCastAuthRequest, *, now_ms: int | None = None
) -> int:
    """Check the timestamps are sane; return the requested ``expiresAt`` (ms).

    Shape (method, exact keys, strict ints) is enforced by the schema.
    """
    now = now_ms if now_ms is not None else _now_ms()
    timestamp = auth_request.params.timestamp
    expires_at = auth_request.params.expires_at
    is_fresh = now - MAX_REQUEST_AGE_MS <= timestamp <= now + CLOCK_SKEW_MS
    is_future = expires_at > now and expires_at > timestamp
    is_within_ttl = expires_at <= now + DC_TOKEN_TTL_MS + CLOCK_SKEW_MS
    if not (is_fresh and is_future and is_within_ttl):
        raise FarcasterTokenError(status.HTTP_400_BAD_REQUEST, "invalid_auth_request")
    return expires_at


def _decode_signature(signature: str) -> bytes:
    if not signature.startswith(EIP191_PREFIX):
        raise _invalid_signature()
    try:
        raw = base64.b64decode(signature.removeprefix(EIP191_PREFIX), validate=True)
    except (binascii.Error, ValueError):
        raise _invalid_signature() from None
    if len(raw) != SIGNATURE_BYTES:
        raise _invalid_signature()
    return raw


def recover_auth_request_signer(
    auth_request: DirectCastAuthRequest, signature: str
) -> str:
    """EIP-191 signer of the canonical request, as a checksummed address."""
    raw = _decode_signature(signature)
    signable = encode_defunct(text=_canonicalize(auth_request.to_upstream()))
    try:
        return Account.recover_message(signable, signature=raw)
    except Exception:  # noqa: BLE001 - eth_keys raises several types for bad sigs
        raise _invalid_signature() from None


async def _require_custody_signer(
    fid: int,
    auth_request: DirectCastAuthRequest,
    signature: str,
    custody_resolver: CustodyResolver,
) -> None:
    signer = recover_auth_request_signer(auth_request, signature)
    try:
        custody = await custody_resolver(fid)
    except key_gateway.KeyGatewayError:
        raise FarcasterTokenError(
            status.HTTP_502_BAD_GATEWAY, "registry_unavailable"
        ) from None
    if custody is None:
        raise FarcasterTokenError(status.HTTP_404_NOT_FOUND, "fid_not_found")
    if signer.lower() != custody.lower():
        logger.warning("dc_token_signer_mismatch fid=%s", fid)
        raise _invalid_signature()


# ---------------------------------------------------------------------------
# Exchange + store
# ---------------------------------------------------------------------------


async def _exchange(
    spaces_service: FarcasterSpacesService,
    auth_request: DirectCastAuthRequest,
    signature: str,
    *,
    fid: int,
) -> tuple[str, int]:
    try:
        return await spaces_service.mint_bearer_from_signed_request(
            auth_request.to_upstream(), signature, log_label=f"dc fid={fid}"
        )
    except (httpx.HTTPError, ValueError) as exc:
        is_rejected = (
            isinstance(exc, httpx.HTTPStatusError)
            and exc.response.status_code < status.HTTP_500_INTERNAL_SERVER_ERROR
        )
        if is_rejected:
            raise FarcasterTokenError(
                status.HTTP_400_BAD_REQUEST, "token_rejected"
            ) from None
        raise FarcasterTokenError(
            status.HTTP_502_BAD_GATEWAY, "upstream_error"
        ) from None


async def _store_token(
    db: AsyncSession, *, fid: int, secret: str, expires_at_ms: int
) -> datetime:
    plaintext = json.dumps({"secret": secret, "expires_at_ms": expires_at_ms})
    blob = signer_crypto.encrypt_secret(
        plaintext.encode(),
        aad=_aad(fid),
        purpose=signer_crypto.SignerPurpose.FARCASTER_TOKEN,
    )
    expires_at = datetime.fromtimestamp(expires_at_ms / MS_PER_SECOND, UTC)
    # One atomic upsert: two concurrent enables for a fid (signer-register
    # background task + "Enable messages") can't both INSERT and 500.
    stmt = pg_insert(UserFarcasterToken).values(
        fid=fid, encrypted_token=blob, expires_at=expires_at
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[UserFarcasterToken.fid],
        set_={
            "encrypted_token": stmt.excluded.encrypted_token,
            "expires_at": stmt.excluded.expires_at,
            "updated_at": func.now(),
        },
    )
    await db.execute(stmt)
    await db.commit()
    # The core upsert bypasses the ORM; refresh a row this session already
    # holds so later ``db.get`` calls don't see the previous token.
    cached = db.identity_map.get(db.identity_key(UserFarcasterToken, fid))
    if cached is not None:
        await db.refresh(cached)
    return expires_at


async def enable_direct_casts(
    db: AsyncSession,
    *,
    fid: int,
    auth_request: DirectCastAuthRequest,
    signature: str,
    spaces_service: FarcasterSpacesService,
    custody_resolver: CustodyResolver | None = None,
    now_ms: int | None = None,
) -> DirectCastTokenStatus:
    """Validate, verify custody, exchange upstream and store the token.

    Raises :class:`FarcasterTokenError` (opaque code) on any failure; the
    signature is never included in it.
    """
    requested_expires_at_ms = validate_auth_request(auth_request, now_ms=now_ms)
    try:
        signer_crypto.load_signer_encryption_key()
    except signer_crypto.SignerKeyConfigError:
        # Fail before minting: a token we cannot store must not be created.
        logger.error("dc_token_unconfigured")
        raise FarcasterTokenError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "messaging_unavailable"
        ) from None
    await _require_custody_signer(
        fid, auth_request, signature, custody_resolver or key_gateway.custody_of
    )
    secret, upstream_expires_at_ms = await _exchange(
        spaces_service, auth_request, signature, fid=fid
    )
    expires_at = await _store_token(
        db,
        fid=fid,
        secret=secret,
        expires_at_ms=min(upstream_expires_at_ms, requested_expires_at_ms),
    )
    logger.info("dc_token_enabled fid=%s", fid)
    return DirectCastTokenStatus(TOKEN_STATUS_ACTIVE, expires_at)


async def enable_after_signer_register(
    *,
    session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]],
    spaces_service: FarcasterSpacesService,
    prepare_id: uuid.UUID,
    auth_request: DirectCastAuthRequest,
    signature: str,
) -> None:
    """Background half of ``/v1/auth/signer/register``: best effort.

    The signer link must not fail because messaging could not be enabled;
    on failure the client sees ``token_status: "missing"`` and offers the
    "Enable messages" flow. This is a background-task boundary, so every
    exception stops here and is logged as fid + exception type only (an
    exception's text could carry the signature or the minted token).
    """
    fid: int | None = None
    try:
        async with session_factory() as db:
            row = await db.get(UserSigner, prepare_id)
            if row is None:
                return
            fid = row.fid
            await enable_direct_casts(
                db,
                fid=fid,
                auth_request=auth_request,
                signature=signature,
                spaces_service=spaces_service,
            )
    except FarcasterTokenError as exc:
        logger.warning("dc_token_register_enable_failed fid=%s code=%s", fid, exc.code)
    except Exception as exc:  # noqa: BLE001 -- background boundary, see above
        logger.error(
            "dc_token_register_enable_failed fid=%s error=%s",
            fid,
            type(exc).__name__,
        )


# ---------------------------------------------------------------------------
# Read / delete
# ---------------------------------------------------------------------------


async def get_token_status(
    db: AsyncSession, fid: int, *, now: datetime | None = None
) -> DirectCastTokenStatus:
    row = await db.get(UserFarcasterToken, fid)
    if row is None:
        return DirectCastTokenStatus(TOKEN_STATUS_MISSING, None)
    expires_at = _as_utc(row.expires_at)
    if _is_expired(expires_at, now or datetime.now(UTC)):
        return DirectCastTokenStatus(TOKEN_STATUS_EXPIRED, expires_at)
    return DirectCastTokenStatus(TOKEN_STATUS_ACTIVE, expires_at)


async def get_direct_cast_bearer(
    db: AsyncSession, fid: int, *, now: datetime | None = None
) -> str | None:
    """The upstream bearer secret for ``fid``; ``None`` when missing/expired.

    Raises ``signer_crypto.SignerKeyConfigError`` / ``SignerDecryptError``
    when a stored token cannot be decrypted (server misconfiguration;
    callers map to an opaque 503). Never cache or log the return value.
    """
    row = await db.get(UserFarcasterToken, fid)
    if row is None:
        return None
    if _is_expired(row.expires_at, now or datetime.now(UTC)):
        return None
    return _decrypt_secret(row)


async def delete_direct_cast_token(db: AsyncSession, fid: int) -> None:
    """Forget the token (logout). Idempotent."""
    await db.execute(delete(UserFarcasterToken).where(UserFarcasterToken.fid == fid))
    await db.commit()


async def revoke_rejected_token(db: AsyncSession, fid: int, *, bearer: str) -> bool:
    """Delete ``fid``'s stored token iff it is still the ``bearer`` upstream 401'd.

    Called when upstream rejects the token so ``GET /v1/messages/status``
    reports ``missing`` (re-enable) instead of a stale ``active``. The
    compare-and-delete keeps a request that raced a fresh ``/enable`` from
    deleting the new token. Returns whether a row was deleted.
    """
    row = await db.get(UserFarcasterToken, fid)
    if row is None:
        return False
    stored = _decrypt_secret(row)
    if stored is None or not hmac.compare_digest(stored.encode(), bearer.encode()):
        return False
    await db.delete(row)
    await db.commit()
    return True
