"""User app signers: generate, relay ``KeyGateway.addFor``, confirm, serve.

Implements the frozen Hypersnap auth contract (``/v1/auth/signer/*``):

1. ``prepare`` (unauthenticated): generate an Ed25519 keypair, store the
   private key encrypted in a ``pending`` ``user_signers`` row, and return
   the two EIP-712 ``Add`` payloads the FID's custody wallet must sign (the
   Ed25519 signer at KeyGateway nonce n, the device auth address at n+1)
   plus a server nonce for the custody-signed Protocol Auth token.
2. ``register``: check both ``Add`` signatures recover to custody, verify
   the token (custody-signed, carrying the prepare nonce) and simulate the
   first ``addFor``, all before anything is relayed. The relay itself runs
   in the background (:func:`relay_prepared_signer`); register answers 202.
3. ``status`` (by ``prepare_id``): report progress, reconciling with
   Hypersnap while confirming. Progress only: it never carries a session.
   Once approved, the device signs in through ``/v1/auth/protocol`` with
   the auth address that was just added on-chain, so ``prepare_id`` (which
   travels in a query string) is never a bearer credential.

Guards owned here (``send_add_for`` does none of them):

* Idempotency per ``prepare_id``: a ``SET NX`` lock serializes register
  attempts, an accepted prepare is never re-validated or re-relayed, a key
  already added on-chain is never re-sent.
* Rate limits per IP and per FID on prepare and register, per IP and per
  prepare on status; stale ``pending`` rows expire with the prepare.
  Prepare is unauthenticated, so its FID budget is charged per
  ``(fid, IP)`` with only a high pure-FID backstop: one caller cannot
  lock a victim FID out of linking.
* The custody-signed register token's nonce is remembered
  (:func:`is_prepare_nonce`) so ``/v1/auth/miniapp-quickauth``, which does
  not consume nonces, refuses to turn a link token into a session.
* A cross-worker Redis relayer lock around ``send_add_for`` so two workers
  never allocate the same relayer nonce.

Private keys are only ever held decrypted in memory; they are never logged
or returned.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from eth_utils import is_address, to_checksum_address
from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap, key_gateway
from app.config import settings
from app.models.user import SIGNER_STATUS_APPROVED, SIGNER_STATUS_PENDING, User
from app.models.user_signer import (
    USER_SIGNER_APPROVED,
    USER_SIGNER_CONFIRMING,
    USER_SIGNER_FAILED,
    USER_SIGNER_PENDING,
    USER_SIGNER_REVOKED,
    USER_SIGNER_SUBMITTED,
    UserSigner,
)
from app.services import signer_crypto, signer_registry
from app.services.auth_address_service import upsert_auth_address_from_registration
from app.services.key_request_signing import _get_app_account, sign_key_request
from app.services.siwf_service import (
    LINK_METHOD_CUSTODY,
    PROTOCOL_AUTH_MAX_TTL_SECONDS,
    ProtocolAuthClaims,
    ProtocolAuthError,
    allowed_protocol_auth_domains,
    verify_protocol_auth_token,
)

logger = logging.getLogger(__name__)

# Prepared state lives as long as the ``Add`` signatures can be relayed.
PREPARE_TTL_SECONDS = key_gateway.MAX_ADD_DEADLINE_SECONDS
PREPARE_KEY_PREFIX = "signer_prepare:"
# Marks a prepare's Protocol Auth nonce for as long as any token carrying it
# can still verify: the prepare window plus the longest token lifetime.
PREPARE_NONCE_KEY_PREFIX = "signer_prepare_nonce:"
PREPARE_NONCE_TTL_SECONDS = PREPARE_TTL_SECONDS + PROTOCOL_AUTH_MAX_TTL_SECONDS
# Seconds shaved off the Add deadline so it is still in the future (and
# within ``MAX_ADD_DEADLINE_SECONDS``) when the relay runs.
ADD_DEADLINE_MARGIN_SECONDS = 60
DEFAULT_PROTOCOL_AUTH_DOMAIN = "juke.audio"

REGISTER_LOCK_PREFIX = "signer_register:"
REGISTER_LOCK_TTL_SECONDS = 60

RELAYER_LOCK_KEY = "key_gateway:relayer_lock"
RELAYER_LOCK_TTL_MS = 60_000
RELAYER_LOCK_WAIT_SECONDS = 30.0
RELAYER_LOCK_POLL_SECONDS = 0.1
# Compare-and-delete so a worker never releases a lock it no longer holds.
RELEASE_LOCK_SCRIPT = (
    "if redis.call('get', KEYS[1]) == ARGV[1] then "
    "return redis.call('del', KEYS[1]) else return 0 end"
)

PREPARE_RATE_PER_IP = 20
# Prepare is unauthenticated: the FID is caller-supplied, so the per-FID
# budget is keyed on (fid, IP). The pure-FID ceiling is a relayer-abuse
# backstop and stays well above the per-IP budget, so a single IP can never
# exhaust a victim FID's budget.
PREPARE_RATE_PER_FID_IP = 10
PREPARE_RATE_PER_FID = 100
REGISTER_RATE_PER_IP = 10
REGISTER_RATE_PER_FID = 5
# Clients poll every 3s for up to 3 min (60 polls); leave headroom.
STATUS_RATE_PER_PREPARE = 90
STATUS_RATE_PER_IP = 240
RATE_WINDOW_SECONDS = 60 * 60
STATUS_RATE_WINDOW_SECONDS = 5 * 60
# Hard cap on live pending rows per FID; matches the pure-FID backstop so the
# DB cap is never a cheaper lockout than the rate limit.
MAX_PENDING_SIGNERS_PER_FID = PREPARE_RATE_PER_FID

HYPERSNAP_POLL_SECONDS = 90.0
HYPERSNAP_POLL_INTERVAL_SECONDS = 2.0
# Two relayer-lock waits, two receipt waits and the Hypersnap poll.
RELAY_LOCK_PREFIX = "signer_relay:"
RELAY_LOCK_TTL_SECONDS = 10 * 60

AUTH_ADDRESS_STATUS_APPROVED = "approved"
AUTH_ADDRESS_OWNER_PREFIX = "auth_addr:"

# Contract-facing status values for ``GET /signer/status``.
STATUS_PENDING = "pending"
STATUS_SUBMITTED = "submitted"
STATUS_APPROVED = "approved"
STATUS_FAILED = "failed"
_CONTRACT_STATUS = {
    USER_SIGNER_PENDING: STATUS_PENDING,
    USER_SIGNER_SUBMITTED: STATUS_SUBMITTED,
    USER_SIGNER_CONFIRMING: STATUS_SUBMITTED,
    USER_SIGNER_APPROVED: STATUS_APPROVED,
    USER_SIGNER_FAILED: STATUS_FAILED,
    USER_SIGNER_REVOKED: STATUS_FAILED,
}

# Machine-readable ``failure_reason`` / status ``error`` codes.
ERROR_PREPARE_EXPIRED = "prepare_expired"
ERROR_INVALID_SIGNATURE = "invalid_signature"
ERROR_REVERTED = "reverted"
ERROR_RELAY_UNAVAILABLE = "relay_unavailable"
ERROR_RELAY_FAILED = "relay_failed"
ERROR_INTERNAL = "internal_error"


class SignerNotApprovedError(Exception):
    """The FID has no approved app signer; callers map to 403 signer_not_linked."""


class _RelayError(Exception):
    """A background relay step failed; ``code`` becomes ``failure_reason``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PrepareStatus:
    prepare_id: uuid.UUID
    fid: int
    status: str
    signer_tx_hash: str | None
    auth_address_tx_hash: str | None
    error: str | None


def _http_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail=code)


# ---------------------------------------------------------------------------
# Redis helpers
# ---------------------------------------------------------------------------


async def enforce_rate_limit(redis, key: str, *, limit: int, window: int) -> None:
    """Fixed-window counter (``INCR`` + ``EXPIRE``); 429 past ``limit``."""
    attempts = await redis.incr(key)
    if attempts == 1:
        await redis.expire(key, window)
    if attempts > limit:
        ttl = await redis.ttl(key)
        retry_after = int(ttl) if isinstance(ttl, int) and ttl > 0 else window
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="rate_limited",
            headers={"Retry-After": str(retry_after)},
        )


@asynccontextmanager
async def _held_lock(redis, key: str, *, ttl_seconds: int) -> AsyncIterator[bool]:
    """``SET NX EX`` lock; yields whether it was acquired, releases if so."""
    token = secrets.token_hex(16)
    acquired = bool(await redis.set(key, token, nx=True, ex=ttl_seconds))
    try:
        yield acquired
    finally:
        if acquired:
            await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token)


@asynccontextmanager
async def relayer_lock(redis) -> AsyncIterator[None]:
    """Hold the cross-worker relayer lock for one ``addFor`` broadcast.

    ``SET NX PX`` with a random token; released with compare-and-delete.
    Waits up to :data:`RELAYER_LOCK_WAIT_SECONDS`.
    """
    token = secrets.token_hex(16)
    deadline = time.monotonic() + RELAYER_LOCK_WAIT_SECONDS
    while not await redis.set(RELAYER_LOCK_KEY, token, nx=True, px=RELAYER_LOCK_TTL_MS):
        if time.monotonic() >= deadline:
            raise _RelayError(ERROR_RELAY_UNAVAILABLE)
        await asyncio.sleep(RELAYER_LOCK_POLL_SECONDS)
    try:
        yield
    finally:
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, RELAYER_LOCK_KEY, token)


def _decode_redis_value(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, bytes):
        return raw.decode()
    return str(raw)


def _prepare_key(prepare_id: uuid.UUID) -> str:
    return f"{PREPARE_KEY_PREFIX}{prepare_id}"


def _prepare_nonce_key(nonce: str) -> str:
    return f"{PREPARE_NONCE_KEY_PREFIX}{nonce}"


async def is_prepare_nonce(redis, nonce: str) -> bool:
    """True when ``nonce`` was issued for a signer prepare's register token."""
    if not nonce:
        return False
    return await redis.get(_prepare_nonce_key(nonce)) is not None


async def _load_state(redis, prepare_id: uuid.UUID) -> dict[str, Any] | None:
    raw = _decode_redis_value(await redis.get(_prepare_key(prepare_id)))
    return None if raw is None else json.loads(raw)


async def _save_state(redis, prepare_id: uuid.UUID, state: dict[str, Any]) -> None:
    remaining = max(int(state["expires_at"]) - int(time.time()), 1)
    await redis.set(_prepare_key(prepare_id), json.dumps(state), ex=remaining)


# ---------------------------------------------------------------------------
# Prepare
# ---------------------------------------------------------------------------


def _protocol_auth_domain() -> str:
    """First configured Protocol Auth domain (the token's SIWE ``domain``)."""
    first = settings.QUICKAUTH_ALLOWED_AUDIENCES.split(",")[0].strip().lower()
    return first or DEFAULT_PROTOCOL_AUTH_DOMAIN


def _signed_key_request_metadata(key: bytes) -> str:
    signature, deadline = sign_key_request(key)
    metadata = key_gateway.encode_signed_key_request_metadata(
        request_fid=settings.FARCASTER_APP_FID,
        request_signer=_get_app_account().address,
        signature=signature,
        deadline=deadline,
    )
    return "0x" + metadata.hex()


def _add_entry(*, key_type: int, key: bytes, nonce: int) -> dict[str, Any]:
    """The relay arguments for one ``addFor`` (no typed data)."""
    return {
        "key_type": key_type,
        "key": "0x" + key.hex(),
        "metadata": _signed_key_request_metadata(key),
        "nonce": nonce,
    }


def _typed_data(state: dict[str, Any], add: dict[str, Any]) -> dict[str, Any]:
    return key_gateway.build_add_typed_data(
        owner=state["custody_address"],
        key_type=add["key_type"],
        key=bytes.fromhex(add["key"][2:]),
        metadata=add["metadata"],
        nonce=add["nonce"],
        deadline=state["deadline"],
    )


def _normalize_auth_address(address: str) -> str:
    if not is_address(address):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid_auth_address",
        )
    return to_checksum_address(address)


async def _expire_stale_pending(db: AsyncSession, fid: int) -> int:
    """Drop expired ``pending`` rows (every FID); return ``fid``'s fresh count.

    Abandoned prepares (never registered) would otherwise count against
    :data:`MAX_PENDING_SIGNERS_PER_FID` forever, letting anyone lock a FID
    out of linking by calling the unauthenticated prepare endpoint. The
    sweep covers all FIDs so bulk prepares across many FIDs do not leave
    orphaned encrypted keys behind.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=PREPARE_TTL_SECONDS)
    await db.execute(
        delete(UserSigner)
        .where(UserSigner.status == USER_SIGNER_PENDING, UserSigner.created_at < cutoff)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    result = await db.execute(
        select(func.count())
        .select_from(UserSigner)
        .where(UserSigner.fid == fid, UserSigner.status == USER_SIGNER_PENDING)
    )
    return int(result.scalar_one())


async def has_approved_signer(db: AsyncSession, fid: int) -> bool:
    result = await db.execute(
        select(UserSigner.id)
        .where(UserSigner.fid == fid, UserSigner.status == USER_SIGNER_APPROVED)
        .limit(1)
    )
    return result.first() is not None


async def prepare_signer(
    db: AsyncSession,
    redis,
    *,
    fid: int,
    auth_address: str,
    client_ip: str,
) -> dict[str, Any]:
    """Create a pending signer for ``fid`` and the payloads custody must sign."""
    if fid <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_fid"
        )
    auth_address = _normalize_auth_address(auth_address)
    await enforce_rate_limit(
        redis,
        f"signer_prepare_rate:ip:{client_ip}",
        limit=PREPARE_RATE_PER_IP,
        window=RATE_WINDOW_SECONDS,
    )
    await enforce_rate_limit(
        redis,
        f"signer_prepare_rate:fid_ip:{fid}:{client_ip}",
        limit=PREPARE_RATE_PER_FID_IP,
        window=RATE_WINDOW_SECONDS,
    )
    await enforce_rate_limit(
        redis,
        f"signer_prepare_rate:fid:{fid}",
        limit=PREPARE_RATE_PER_FID,
        window=RATE_WINDOW_SECONDS,
    )
    if await _expire_stale_pending(db, fid) >= MAX_PENDING_SIGNERS_PER_FID:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="rate_limited"
        )

    custody = await key_gateway.custody_of(fid)
    if custody is None:
        raise _http_error(status.HTTP_404_NOT_FOUND, "fid_not_found")
    if await has_approved_signer(
        db, fid
    ) and await signer_registry.is_auth_address_active(fid, auth_address):
        raise _http_error(status.HTTP_409_CONFLICT, "already_linked")
    nonce = await key_gateway.key_gateway_nonce(custody)

    prepare_id = uuid.uuid4()
    raw_private, public_key = signer_crypto.generate_ed25519_keypair()
    encrypted = signer_crypto.encrypt_private_key(
        raw_private, aad=str(prepare_id), purpose=signer_crypto.SignerPurpose.USER
    )
    del raw_private

    now = int(time.time())
    expires_at = now + PREPARE_TTL_SECONDS
    domain = _protocol_auth_domain()
    state = {
        "fid": fid,
        "custody_address": custody,
        "public_key": public_key,
        "auth_address": auth_address,
        "deadline": expires_at - ADD_DEADLINE_MARGIN_SECONDS,
        "expires_at": expires_at,
        "protocol_auth_nonce": secrets.token_hex(16),
        "is_accepted": False,
        "adds": [
            _add_entry(
                key_type=key_gateway.KEY_TYPE_ED25519,
                key=bytes.fromhex(public_key[2:]),
                nonce=nonce,
            ),
            _add_entry(
                key_type=key_gateway.KEY_TYPE_AUTH_ADDRESS,
                key=key_gateway.auth_address_key(auth_address),
                nonce=nonce + 1,
            ),
        ],
    }

    db.add(
        UserSigner(
            id=prepare_id,
            fid=fid,
            public_key=public_key,
            encrypted_private_key=encrypted,
            status=USER_SIGNER_PENDING,
            auth_address=auth_address.lower(),
        )
    )
    await db.commit()
    await _save_state(redis, prepare_id, state)
    await redis.set(
        _prepare_nonce_key(state["protocol_auth_nonce"]),
        "1",
        ex=PREPARE_NONCE_TTL_SECONDS,
    )

    signer_add, auth_add = state["adds"]
    return {
        "prepare_id": str(prepare_id),
        "custody_address": custody.lower(),
        "signer_public_key": public_key.lower(),
        "typed_data": {
            "signer": _typed_data(state, signer_add),
            "auth_address": _typed_data(state, auth_add),
        },
        "protocol_auth": {
            "domain": domain,
            "uri": f"https://{domain}",
            "nonce": state["protocol_auth_nonce"],
            "expires_at": expires_at,
        },
        "expires_at": expires_at,
    }


# ---------------------------------------------------------------------------
# Register (validation; the relay runs in the background)
# ---------------------------------------------------------------------------


def _require_custody_signature(
    state: dict[str, Any], add: dict[str, Any], signature: str
) -> None:
    try:
        signer = key_gateway.recover_add_signer(_typed_data(state, add), signature)
    except key_gateway.MALFORMED_SIGNATURE_ERRORS:
        raise _http_error(status.HTTP_400_BAD_REQUEST, "invalid_signature") from None
    if signer.lower() != state["custody_address"].lower():
        raise _http_error(status.HTTP_400_BAD_REQUEST, "invalid_signature")


async def _verify_register_token(
    token: str, *, state: dict[str, Any]
) -> ProtocolAuthClaims:
    """Custody-signed token for the prepared FID carrying the prepare nonce.

    The prepare nonce is single-use because an accepted prepare is never
    validated again.
    """
    domains = allowed_protocol_auth_domains(settings.QUICKAUTH_ALLOWED_AUDIENCES)
    try:
        claims = await verify_protocol_auth_token(token, allowed_domains=domains)
    except ProtocolAuthError as exc:
        logger.warning("signer_register_token_rejected reason=%s", exc.reason)
        raise _http_error(status.HTTP_400_BAD_REQUEST, "invalid_token") from None
    except key_gateway.KeyGatewayError:
        raise _http_error(status.HTTP_502_BAD_GATEWAY, "registry_unavailable") from None
    is_bound = (
        claims.fid == int(state["fid"])
        and claims.nonce == state["protocol_auth_nonce"]
        and claims.method == LINK_METHOD_CUSTODY
        and claims.address.lower() == state["custody_address"].lower()
    )
    if not is_bound:
        logger.warning("signer_register_token_unbound fid=%s", state["fid"])
        raise _http_error(status.HTTP_400_BAD_REQUEST, "invalid_token")
    return claims


async def _simulate_signer_add(state: dict[str, Any], signature: str) -> None:
    add = state["adds"][0]
    try:
        await key_gateway.simulate_add_for(
            fid_owner=state["custody_address"],
            key_type=add["key_type"],
            key=add["key"],
            metadata=add["metadata"],
            deadline=state["deadline"],
            signature=signature,
        )
    except key_gateway.KeyGatewayValidationError:
        raise _http_error(status.HTTP_400_BAD_REQUEST, "invalid_signature") from None
    except key_gateway.KeyGatewayError as exc:
        if exc.reason is not None:  # the contract reverted
            logger.warning("signer_register_simulation_reverted reason=%s", exc.reason)
            raise _http_error(
                status.HTTP_400_BAD_REQUEST, "invalid_signature"
            ) from None
        raise _http_error(status.HTTP_502_BAD_GATEWAY, "relay_failed") from None


def _accepted(row: UserSigner) -> dict[str, str]:
    return {"prepare_id": str(row.id), "status": _CONTRACT_STATUS[row.status]}


async def register_signer(
    db: AsyncSession,
    redis,
    *,
    prepare_id: uuid.UUID,
    signer_add_signature: str,
    auth_address_add_signature: str,
    protocol_auth_token: str,
    client_ip: str,
) -> tuple[dict[str, str], bool]:
    """Validate a register request before anything is relayed.

    Returns ``(body, should_relay)``. ``should_relay`` is True only for the
    request that accepted the prepare; the caller then schedules
    :func:`relay_prepared_signer`. Retries after acceptance get the current
    status (idempotent 202).
    """
    await enforce_rate_limit(
        redis,
        f"signer_register_rate:ip:{client_ip}",
        limit=REGISTER_RATE_PER_IP,
        window=RATE_WINDOW_SECONDS,
    )
    state = await _load_state(redis, prepare_id)
    if state is None:
        raise _http_error(status.HTTP_410_GONE, "prepare_expired")
    fid = int(state["fid"])
    await enforce_rate_limit(
        redis,
        f"signer_register_rate:fid:{fid}",
        limit=REGISTER_RATE_PER_FID,
        window=RATE_WINDOW_SECONDS,
    )

    lock_key = f"{REGISTER_LOCK_PREFIX}{prepare_id}"
    async with _held_lock(redis, lock_key, ttl_seconds=REGISTER_LOCK_TTL_SECONDS) as ok:
        if not ok:
            raise _http_error(status.HTTP_409_CONFLICT, "already_submitted")
        # Re-read under the lock: a concurrent request may have accepted it.
        state = await _load_state(redis, prepare_id)
        if state is None:
            raise _http_error(status.HTTP_410_GONE, "prepare_expired")
        row = await db.get(UserSigner, prepare_id)
        if row is None or row.fid != fid or row.public_key != state["public_key"]:
            raise _http_error(status.HTTP_410_GONE, "prepare_expired")
        if state["is_accepted"] or row.status != USER_SIGNER_PENDING:
            return _accepted(row), False

        signer_add, auth_add = state["adds"]
        _require_custody_signature(state, signer_add, signer_add_signature)
        _require_custody_signature(state, auth_add, auth_address_add_signature)
        await _verify_register_token(protocol_auth_token, state=state)
        await _simulate_signer_add(state, signer_add_signature)

        state["is_accepted"] = True
        await _save_state(redis, prepare_id, state)
    logger.info("signer_register_accepted fid=%s", fid)
    return _accepted(row), True


# ---------------------------------------------------------------------------
# Background relay
# ---------------------------------------------------------------------------


async def _is_key_added(fid: int, key: str, key_type: int) -> bool:
    state, onchain_type = await key_gateway.key_data_of(fid, key)
    return state == key_gateway.KEY_STATE_ADDED and onchain_type == key_type


def _relay_error_code(exc: key_gateway.KeyGatewayError) -> str:
    if isinstance(exc, key_gateway.KeyGatewayValidationError):
        return ERROR_INVALID_SIGNATURE
    if isinstance(
        exc, key_gateway.KeyGatewayConfigError | key_gateway.KeyGatewaySpendCapError
    ):
        return ERROR_RELAY_UNAVAILABLE
    if exc.reason == ERROR_REVERTED:
        return ERROR_REVERTED
    return ERROR_RELAY_FAILED


async def _relay_add(
    redis, *, state: dict[str, Any], add: dict[str, Any], signature: str
) -> str:
    """Broadcast one ``addFor`` and wait for it to be mined; return the tx."""
    try:
        async with relayer_lock(redis):
            tx_hash = await key_gateway.send_add_for(
                fid_owner=state["custody_address"],
                key_type=add["key_type"],
                key=add["key"],
                metadata=add["metadata"],
                deadline=state["deadline"],
                signature=signature,
            )
        await key_gateway.wait_for_add_receipt(tx_hash)
    except key_gateway.KeyGatewayError as exc:
        raise _RelayError(_relay_error_code(exc)) from None
    return tx_hash


async def _ensure_added(
    redis, *, fid: int, state: dict, add: dict, signature: str
) -> str | None:
    """Relay ``add`` unless the key is already on-chain; return the tx hash."""
    try:
        if await _is_key_added(fid, add["key"], add["key_type"]):
            return None
    except key_gateway.KeyGatewayError:
        raise _RelayError(ERROR_RELAY_FAILED) from None
    return await _relay_add(redis, state=state, add=add, signature=signature)


async def _record_auth_address(
    db: AsyncSession, redis, *, fid: int, address: str, tx_hash: str | None
) -> None:
    row = await upsert_auth_address_from_registration(
        db=db,
        address=address,
        fid=fid,
        status=AUTH_ADDRESS_STATUS_APPROVED,
        approval_url=None,
    )
    if tx_hash is not None:
        row.add_tx_hash = tx_hash
        await db.commit()
    await redis.set(f"{AUTH_ADDRESS_OWNER_PREFIX}{address}", str(fid))
    await redis.set(f"{AUTH_ADDRESS_OWNER_PREFIX}{address.lower()}", str(fid))


async def _poll_hypersnap(fid: int, public_key: str, *, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        try:
            if await signer_registry.is_ed25519_signer_active(fid, public_key):
                return True
        except hypersnap.HypersnapError:
            logger.warning("signer_hypersnap_poll_failed fid=%s", fid)
        if time.monotonic() + HYPERSNAP_POLL_INTERVAL_SECONDS > deadline:
            return False
        await asyncio.sleep(HYPERSNAP_POLL_INTERVAL_SECONDS)


async def apply_user_signer_status(
    db: AsyncSession, user: User, *, is_approved: bool
) -> None:
    """Reflect a registered signer on ``users.signer_status``.

    Never downgrades: a user with an earlier approved signer stays
    ``approved`` while a newer one is still in flight.
    """
    if is_approved:
        user.signer_status = SIGNER_STATUS_APPROVED
    elif user.signer_status != SIGNER_STATUS_APPROVED:
        user.signer_status = SIGNER_STATUS_PENDING
    await db.commit()


async def _apply_existing_user_status(
    db: AsyncSession, fid: int, *, is_approved: bool
) -> None:
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is not None:
        await apply_user_signer_status(db, user, is_approved=is_approved)


async def _approve(db: AsyncSession, row: UserSigner) -> None:
    row.status = USER_SIGNER_APPROVED
    row.approved_at = datetime.now(timezone.utc)
    row.failure_reason = None
    await db.commit()
    await _apply_existing_user_status(db, row.fid, is_approved=True)


async def _relay_both_adds(
    db: AsyncSession,
    redis,
    *,
    row: UserSigner,
    state: dict[str, Any],
    signer_add_signature: str,
    auth_address_add_signature: str,
) -> None:
    """Relay the signer add (nonce n) then the auth address add (n+1).

    The row stays ``submitted`` until both are mined, so a status poll never
    approves (and hands out a session for) a half-linked device.
    """
    signer_add, auth_add = state["adds"]
    row.status = USER_SIGNER_SUBMITTED
    await db.commit()
    signer_tx = await _ensure_added(
        redis, fid=row.fid, state=state, add=signer_add, signature=signer_add_signature
    )
    if signer_tx is not None:
        row.add_tx_hash = signer_tx
        await db.commit()
    auth_tx = await _ensure_added(
        redis,
        fid=row.fid,
        state=state,
        add=auth_add,
        signature=auth_address_add_signature,
    )
    if auth_tx is not None:
        row.auth_address_tx_hash = auth_tx
    row.status = USER_SIGNER_CONFIRMING
    await db.commit()
    await _record_auth_address(
        db, redis, fid=row.fid, address=state["auth_address"], tx_hash=auth_tx
    )


async def relay_prepared_signer(
    redis,
    *,
    prepare_id: uuid.UUID,
    signer_add_signature: str,
    auth_address_add_signature: str,
    session_factory: Callable[[], Any],
    hypersnap_poll_seconds: float = HYPERSNAP_POLL_SECONDS,
) -> None:
    """Background task: relay an accepted prepare and confirm the signer.

    Runs after the 202, with its own session. Every failure lands on the row
    as a machine ``failure_reason`` that ``status`` reports as ``error``.
    """
    lock_key = f"{RELAY_LOCK_PREFIX}{prepare_id}"
    async with _held_lock(redis, lock_key, ttl_seconds=RELAY_LOCK_TTL_SECONDS) as ok:
        if not ok:
            return
        async with session_factory() as db:
            row = await db.get(UserSigner, prepare_id)
            state = await _load_state(redis, prepare_id)
            if row is None or row.status != USER_SIGNER_PENDING or state is None:
                return
            # Read before the try: a rollback expires ``row``. ``prepare_id``
            # is a login capability and is never logged.
            fid = row.fid
            try:
                await _apply_existing_user_status(db, row.fid, is_approved=False)
                await _relay_both_adds(
                    db,
                    redis,
                    row=row,
                    state=state,
                    signer_add_signature=signer_add_signature,
                    auth_address_add_signature=auth_address_add_signature,
                )
                if await _poll_hypersnap(
                    row.fid, row.public_key, timeout=hypersnap_poll_seconds
                ):
                    await _approve(db, row)
            except _RelayError as exc:
                await _fail(db, prepare_id, fid=fid, code=exc.code)
            except Exception:  # background boundary: never leave the row stuck
                logger.exception("signer_relay_crashed fid=%s", fid)
                await db.rollback()
                await _fail(db, prepare_id, fid=fid, code=ERROR_INTERNAL)


async def _fail(
    db: AsyncSession, prepare_id: uuid.UUID, *, fid: int, code: str
) -> None:
    logger.warning("signer_relay_failed fid=%s reason=%s", fid, code)
    await db.execute(
        update(UserSigner)
        .where(UserSigner.id == prepare_id)
        .values(status=USER_SIGNER_FAILED, failure_reason=code)
        .execution_options(synchronize_session=False)
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


async def get_prepare_status(
    db: AsyncSession, redis, *, prepare_id: uuid.UUID, client_ip: str
) -> PrepareStatus:
    """Progress of one prepare; reconciles with Hypersnap while confirming."""
    await enforce_rate_limit(
        redis,
        f"signer_status_rate:ip:{client_ip}",
        limit=STATUS_RATE_PER_IP,
        window=STATUS_RATE_WINDOW_SECONDS,
    )
    await enforce_rate_limit(
        redis,
        f"signer_status_rate:prepare:{prepare_id}",
        limit=STATUS_RATE_PER_PREPARE,
        window=STATUS_RATE_WINDOW_SECONDS,
    )
    row = await db.get(UserSigner, prepare_id)
    if row is None:
        raise _http_error(status.HTTP_404_NOT_FOUND, "prepare_not_found")
    if row.status == USER_SIGNER_CONFIRMING:
        try:
            if await signer_registry.is_ed25519_signer_active(row.fid, row.public_key):
                await _approve(db, row)
        except hypersnap.HypersnapError:
            logger.warning("signer_status_reconcile_failed fid=%s", row.fid)

    contract_status = _CONTRACT_STATUS[row.status]
    error = row.failure_reason if contract_status == STATUS_FAILED else None
    if (
        row.status == USER_SIGNER_PENDING
        and await _load_state(redis, prepare_id) is None
    ):
        contract_status, error = STATUS_FAILED, ERROR_PREPARE_EXPIRED
    return PrepareStatus(
        prepare_id=row.id,
        fid=row.fid,
        status=contract_status,
        signer_tx_hash=row.add_tx_hash,
        auth_address_tx_hash=row.auth_address_tx_hash,
        error=error,
    )


# ---------------------------------------------------------------------------
# WS2 interface
# ---------------------------------------------------------------------------


async def get_user_signer(db: AsyncSession, fid: int) -> Ed25519PrivateKey:
    """Decrypt and return the approved app signer for ``fid``.

    The most recently approved signer wins. Raises
    :class:`SignerNotApprovedError` when there is none, and
    ``signer_crypto.SignerKeyConfigError`` / ``SignerDecryptError`` when the
    key cannot be decrypted (callers map these to an opaque 503).
    """
    result = await db.execute(
        select(UserSigner)
        .where(UserSigner.fid == fid, UserSigner.status == USER_SIGNER_APPROVED)
        .order_by(UserSigner.approved_at.desc(), UserSigner.created_at.desc())
        .limit(1)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise SignerNotApprovedError(f"fid {fid} has no approved signer")
    private_key = signer_crypto.decrypt_private_key(
        row.encrypted_private_key,
        aad=str(row.id),
        purpose=signer_crypto.SignerPurpose.USER,
    )
    return Ed25519PrivateKey.from_private_bytes(private_key)
