"""User app signers: prepare → register → background relay → status → lookup.

The chain (``key_gateway``) and Hypersnap (``signer_registry``) are mocked;
``Add`` signatures and Protocol Auth tokens are real, signed by throwaway
accounts. Redis is the dict-backed ``FakeRedis`` so locks, nonces and
counters behave for real.
"""

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from eth_account import Account
from eth_account.messages import encode_typed_data
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.clients import hypersnap, key_gateway
from app.config import settings
from app.database import Base
from app.models.auth_address import AuthAddress
from app.models.user import User
from app.models.user_signer import UserSigner
from app.services import signer_crypto, signer_registry, user_signer_service
from tests.protocol_auth_helpers import FakeRedis, make_token

FID = 7777
NONCE = 7
TX_SIGNER = "0x" + "aa" * 32
TX_AUTH = "0x" + "bb" * 32
CLIENT_IP = "203.0.113.9"


@pytest.fixture
async def session_factory():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[User.__table__, UserSigner.__table__, AuthAddress.__table__],
        )
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
async def db_session(session_factory):
    async with session_factory() as session:
        yield session


@pytest.fixture
def redis():
    return FakeRedis()


@pytest.fixture
def custody():
    return Account.create()


@pytest.fixture
def device():
    return Account.create()


@pytest.fixture
def chain(monkeypatch, custody):
    """Mock every chain/Hypersnap touchpoint; tests tweak the returned mocks."""
    monkeypatch.setattr(
        settings,
        "SIGNER_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(b"\x07" * 32).decode(),
    )
    monkeypatch.setattr(
        settings, "QUICKAUTH_ALLOWED_AUDIENCES", "juke.audio,www.juke.audio"
    )
    monkeypatch.setattr(settings, "FARCASTER_APP_FID", 9152)
    app_account = Account.create()
    monkeypatch.setattr(user_signer_service, "_get_app_account", lambda: app_account)
    monkeypatch.setattr(
        user_signer_service,
        "sign_key_request",
        lambda key: ("0x" + "33" * 65, 1_900_000_000),
    )
    monkeypatch.setattr(user_signer_service, "HYPERSNAP_POLL_INTERVAL_SECONDS", 0.0)

    async def _id_of(address):
        return FID if address.lower() == custody.address.lower() else 0

    mocks = {
        "custody_of": AsyncMock(return_value=custody.address),
        "key_gateway_nonce": AsyncMock(return_value=NONCE),
        "key_data_of": AsyncMock(return_value=(key_gateway.KEY_STATE_NULL, 0)),
        "simulate_add_for": AsyncMock(return_value=None),
        "send_add_for": AsyncMock(side_effect=[TX_SIGNER, TX_AUTH]),
        "wait_for_add_receipt": AsyncMock(return_value=None),
    }
    for name, mock in mocks.items():
        monkeypatch.setattr(key_gateway, name, mock)
    monkeypatch.setattr(key_gateway, "id_of", _id_of)
    mocks["is_ed25519_signer_active"] = AsyncMock(return_value=True)
    mocks["is_auth_address_active"] = AsyncMock(return_value=False)
    for name in ("is_ed25519_signer_active", "is_auth_address_active"):
        monkeypatch.setattr(signer_registry, name, mocks[name])
    return mocks


def _sign_add(account, typed_data) -> str:
    signable = encode_typed_data(full_message=typed_data)
    return "0x" + bytes(account.sign_message(signable).signature).hex()


async def _prepare(db, redis, device, *, fid=FID, client_ip=CLIENT_IP):
    return await user_signer_service.prepare_signer(
        db, redis, fid=fid, auth_address=device.address, client_ip=client_ip
    )


def _register_params(custody, prepared, **overrides):
    token, _ = make_token(custody, fid=FID, nonce=prepared["protocol_auth"]["nonce"])
    params = {
        "prepare_id": uuid.UUID(prepared["prepare_id"]),
        "signer_add_signature": _sign_add(custody, prepared["typed_data"]["signer"]),
        "auth_address_add_signature": _sign_add(
            custody, prepared["typed_data"]["auth_address"]
        ),
        "protocol_auth_token": token,
        "client_ip": CLIENT_IP,
    }
    params.update(overrides)
    return params


async def _register(db, redis, custody, prepared, **overrides):
    return await user_signer_service.register_signer(
        db, redis, **_register_params(custody, prepared, **overrides)
    )


async def _relay(redis, session_factory, custody, prepared, *, poll_seconds=0.0):
    params = _register_params(custody, prepared)
    await user_signer_service.relay_prepared_signer(
        redis,
        prepare_id=params["prepare_id"],
        signer_add_signature=params["signer_add_signature"],
        auth_address_add_signature=params["auth_address_add_signature"],
        session_factory=session_factory,
        hypersnap_poll_seconds=poll_seconds,
    )


async def _link(db, redis, session_factory, custody, device, **relay_kwargs):
    """Prepare, register and relay; return the prepare payload."""
    prepared = await _prepare(db, redis, device)
    await _register(db, redis, custody, prepared)
    await _relay(redis, session_factory, custody, prepared, **relay_kwargs)
    return prepared


async def _row(session_factory, prepared) -> UserSigner:
    async with session_factory() as session:
        return await session.get(UserSigner, uuid.UUID(prepared["prepare_id"]))


async def _status(db, redis, prepared):
    # The relay commits through its own session; drop this one's cached rows
    # the way a fresh request session would.
    db.expire_all()
    return await user_signer_service.get_prepare_status(
        db, redis, prepare_id=uuid.UUID(prepared["prepare_id"]), client_ip=CLIENT_IP
    )


async def _http_error(awaitable) -> tuple[int, str]:
    with pytest.raises(HTTPException) as exc_info:
        await awaitable
    return exc_info.value.status_code, exc_info.value.detail


# ---------------------------------------------------------------------------
# prepare
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prepare_returns_contract_shape(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)

    assert set(prepared) == {
        "prepare_id",
        "custody_address",
        "signer_public_key",
        "typed_data",
        "protocol_auth",
        "expires_at",
    }
    assert prepared["custody_address"] == custody.address.lower()
    assert prepared["signer_public_key"] == prepared["signer_public_key"].lower()

    signer = prepared["typed_data"]["signer"]
    auth = prepared["typed_data"]["auth_address"]
    for typed in (signer, auth):
        assert typed["primaryType"] == "Add"
        assert typed["domain"]["chainId"] == 10
        assert typed["message"]["owner"].lower() == custody.address.lower()
        assert typed["message"]["deadline"] <= prepared["expires_at"]
    assert signer["message"]["keyType"] == key_gateway.KEY_TYPE_ED25519
    assert signer["message"]["key"] == prepared["signer_public_key"]
    assert signer["message"]["nonce"] == NONCE
    assert auth["message"]["keyType"] == key_gateway.KEY_TYPE_AUTH_ADDRESS
    # 32-byte key: 12 zero bytes + the 20-byte address.
    assert auth["message"]["key"] == "0x" + "00" * 12 + device.address[2:].lower()
    assert auth["message"]["nonce"] == NONCE + 1

    protocol_auth = prepared["protocol_auth"]
    assert protocol_auth["domain"] == "juke.audio"
    assert protocol_auth["uri"] == "https://juke.audio"
    assert protocol_auth["nonce"].isalnum() and len(protocol_auth["nonce"]) >= 16
    assert protocol_auth["expires_at"] == prepared["expires_at"]

    row = await db_session.get(UserSigner, uuid.UUID(prepared["prepare_id"]))
    assert row.status == "pending"
    assert row.public_key == prepared["signer_public_key"]
    assert row.auth_address == device.address.lower()
    # Encrypted at rest; never echoed.
    assert row.encrypted_private_key.startswith("v1:")
    assert row.encrypted_private_key not in json.dumps(prepared)
    state = json.loads(redis.store[f"signer_prepare:{prepared['prepare_id']}"])
    assert state["protocol_auth_nonce"] == protocol_auth["nonce"]
    assert state["is_accepted"] is False


@pytest.mark.asyncio
async def test_prepare_unregistered_fid_404(db_session, redis, chain, device):
    chain["custody_of"].return_value = None
    assert await _http_error(_prepare(db_session, redis, device)) == (
        404,
        "fid_not_found",
    )


@pytest.mark.asyncio
async def test_prepare_bad_auth_address_422(db_session, redis, chain):
    call = user_signer_service.prepare_signer(
        db_session, redis, fid=FID, auth_address="0x12", client_ip=CLIENT_IP
    )
    assert (await _http_error(call))[0] == 422


@pytest.mark.asyncio
async def test_prepare_rate_limited_per_fid_backstop(db_session, redis, chain, device):
    redis.counters[f"signer_prepare_rate:fid:{FID}"] = (
        user_signer_service.PREPARE_RATE_PER_FID
    )
    assert (await _http_error(_prepare(db_session, redis, device)))[0] == 429


def test_one_ip_cannot_exhaust_a_fids_backstop():
    assert (
        user_signer_service.PREPARE_RATE_PER_FID
        > user_signer_service.PREPARE_RATE_PER_IP
    )
    assert (
        user_signer_service.MAX_PENDING_SIGNERS_PER_FID
        > user_signer_service.PREPARE_RATE_PER_IP
    )


@pytest.mark.asyncio
async def test_prepare_flood_from_one_ip_does_not_lock_out_the_fid(
    db_session, redis, chain, device
):
    """Prepare is unauthenticated: one IP's budget for a FID is its own."""
    for _ in range(user_signer_service.PREPARE_RATE_PER_FID_IP):
        await _prepare(db_session, redis, device, client_ip="198.51.100.1")
    attacker = _prepare(db_session, redis, device, client_ip="198.51.100.1")
    assert (await _http_error(attacker))[0] == 429

    prepared = await _prepare(db_session, redis, device, client_ip=CLIENT_IP)

    assert prepared["prepare_id"]


@pytest.mark.asyncio
async def test_prepare_already_linked_409(
    db_session, redis, session_factory, chain, custody, device
):
    await _link(db_session, redis, session_factory, custody, device)
    chain["is_auth_address_active"].return_value = True

    assert await _http_error(_prepare(db_session, redis, device)) == (
        409,
        "already_linked",
    )
    chain["is_auth_address_active"].assert_awaited_with(FID, device.address)


@pytest.mark.asyncio
async def test_prepare_new_device_on_linked_account_is_allowed(
    db_session, redis, session_factory, chain, custody, device
):
    await _link(db_session, redis, session_factory, custody, device)
    # A different device address is not active yet: re-linking proceeds.
    prepared = await _prepare(db_session, redis, Account.create())
    assert prepared["prepare_id"]


@pytest.mark.asyncio
async def test_prepare_caps_fresh_pending_signers(
    db_session, redis, chain, device, monkeypatch
):
    monkeypatch.setattr(user_signer_service, "MAX_PENDING_SIGNERS_PER_FID", 3)
    for _ in range(user_signer_service.MAX_PENDING_SIGNERS_PER_FID):
        await _prepare(db_session, redis, device)
    redis.counters.clear()

    assert (await _http_error(_prepare(db_session, redis, device)))[0] == 429


@pytest.mark.asyncio
async def test_abandoned_prepares_expire_instead_of_locking_out_the_fid(
    db_session, redis, chain, device, monkeypatch
):
    """Unauthenticated prepares must not block a FID from linking forever."""
    monkeypatch.setattr(user_signer_service, "MAX_PENDING_SIGNERS_PER_FID", 3)
    for _ in range(user_signer_service.MAX_PENDING_SIGNERS_PER_FID):
        await _prepare(db_session, redis, device)
    stale = datetime.now(timezone.utc) - timedelta(
        seconds=user_signer_service.PREPARE_TTL_SECONDS + 60
    )
    for row in (await db_session.execute(select(UserSigner))).scalars():
        row.created_at = stale
    await db_session.commit()
    redis.counters.clear()

    prepared = await _prepare(db_session, redis, device)

    remaining = (await db_session.execute(select(UserSigner.id))).scalars().all()
    assert remaining == [uuid.UUID(prepared["prepare_id"])]


@pytest.mark.asyncio
async def test_prepare_sweeps_stale_pending_rows_of_every_fid(
    db_session, redis, chain, device
):
    """Bulk prepares across many FIDs must not leave orphaned keys behind."""
    other_fid = FID + 1
    await _prepare(db_session, redis, device, fid=other_fid)
    stale = datetime.now(timezone.utc) - timedelta(
        seconds=user_signer_service.PREPARE_TTL_SECONDS + 60
    )
    for row in (await db_session.execute(select(UserSigner))).scalars():
        row.created_at = stale
    await db_session.commit()

    prepared = await _prepare(db_session, redis, device)

    remaining = (await db_session.execute(select(UserSigner.id))).scalars().all()
    assert remaining == [uuid.UUID(prepared["prepare_id"])]


# ---------------------------------------------------------------------------
# register (validation only; nothing is relayed)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_register_accepts_and_defers_relay(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)

    body, should_relay = await _register(db_session, redis, custody, prepared)

    assert body == {"prepare_id": prepared["prepare_id"], "status": "pending"}
    assert should_relay is True
    chain["simulate_add_for"].assert_awaited_once()
    simulated = chain["simulate_add_for"].await_args.kwargs
    assert simulated["key"] == prepared["signer_public_key"]
    assert simulated["fid_owner"] == custody.address
    chain["send_add_for"].assert_not_awaited()
    state = json.loads(redis.store[f"signer_prepare:{prepared['prepare_id']}"])
    assert state["is_accepted"] is True
    # The validation lock is released.
    assert f"signer_register:{prepared['prepare_id']}" not in redis.store


@pytest.mark.asyncio
async def test_register_retry_is_idempotent(db_session, redis, chain, custody, device):
    prepared = await _prepare(db_session, redis, device)
    await _register(db_session, redis, custody, prepared)

    body, should_relay = await _register(
        db_session, redis, custody, prepared, signer_add_signature="0x00"
    )

    assert body == {"prepare_id": prepared["prepare_id"], "status": "pending"}
    assert should_relay is False
    chain["simulate_add_for"].assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field", ["signer_add_signature", "auth_address_add_signature"]
)
async def test_register_add_not_signed_by_custody_400(
    db_session, redis, chain, custody, device, field
):
    prepared = await _prepare(db_session, redis, device)
    typed_key = "signer" if field == "signer_add_signature" else "auth_address"
    forged = _sign_add(Account.create(), prepared["typed_data"][typed_key])

    call = _register(db_session, redis, custody, prepared, **{field: forged})

    assert await _http_error(call) == (400, "invalid_signature")
    chain["simulate_add_for"].assert_not_awaited()


@pytest.mark.asyncio
async def test_register_malformed_signature_400(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)
    call = _register(db_session, redis, custody, prepared, signer_add_signature="0x12")
    assert await _http_error(call) == (400, "invalid_signature")


@pytest.mark.asyncio
async def test_register_signatures_swapped_400(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)
    params = _register_params(custody, prepared)
    call = _register(
        db_session,
        redis,
        custody,
        prepared,
        signer_add_signature=params["auth_address_add_signature"],
        auth_address_add_signature=params["signer_add_signature"],
    )
    assert await _http_error(call) == (400, "invalid_signature")


@pytest.mark.asyncio
async def test_register_token_with_other_nonce_400(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)
    token, _ = make_token(custody, fid=FID, nonce="0123456789abcdef")

    call = _register(db_session, redis, custody, prepared, protocol_auth_token=token)

    assert await _http_error(call) == (400, "invalid_token")
    chain["simulate_add_for"].assert_not_awaited()


@pytest.mark.asyncio
async def test_register_token_not_signed_by_custody_400(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)
    token, _ = make_token(
        Account.create(), fid=FID, nonce=prepared["protocol_auth"]["nonce"]
    )
    call = _register(db_session, redis, custody, prepared, protocol_auth_token=token)
    assert await _http_error(call) == (400, "invalid_token")


@pytest.mark.asyncio
async def test_register_token_for_other_fid_400(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)
    token, _ = make_token(
        custody, fid=FID + 1, nonce=prepared["protocol_auth"]["nonce"]
    )
    call = _register(db_session, redis, custody, prepared, protocol_auth_token=token)
    assert await _http_error(call) == (400, "invalid_token")


@pytest.mark.asyncio
async def test_register_simulation_revert_400(
    db_session, redis, chain, custody, device
):
    chain["simulate_add_for"].side_effect = key_gateway.KeyGatewayError(
        "reverted", reason="InvalidSignature"
    )
    prepared = await _prepare(db_session, redis, device)

    call = _register(db_session, redis, custody, prepared)

    assert await _http_error(call) == (400, "invalid_signature")
    # Nothing accepted: a corrected retry is still possible.
    state = json.loads(redis.store[f"signer_prepare:{prepared['prepare_id']}"])
    assert state["is_accepted"] is False


@pytest.mark.asyncio
async def test_register_simulation_rpc_failure_502(
    db_session, redis, chain, custody, device
):
    chain["simulate_add_for"].side_effect = key_gateway.KeyGatewayError("rpc down")
    prepared = await _prepare(db_session, redis, device)
    call = _register(db_session, redis, custody, prepared)
    assert (await _http_error(call))[0] == 502


@pytest.mark.asyncio
async def test_register_expired_prepare_410(db_session, redis, chain, custody, device):
    prepared = await _prepare(db_session, redis, device)
    redis.store.pop(f"signer_prepare:{prepared['prepare_id']}")
    call = _register(db_session, redis, custody, prepared)
    assert await _http_error(call) == (410, "prepare_expired")


@pytest.mark.asyncio
async def test_register_concurrent_attempt_409(
    db_session, redis, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)
    redis.store[f"signer_register:{prepared['prepare_id']}"] = "other-worker"
    call = _register(db_session, redis, custody, prepared)
    assert await _http_error(call) == (409, "already_submitted")


@pytest.mark.asyncio
async def test_register_rate_limited_per_ip(db_session, redis, chain, custody, device):
    prepared = await _prepare(db_session, redis, device)
    redis.counters[f"signer_register_rate:ip:{CLIENT_IP}"] = (
        user_signer_service.REGISTER_RATE_PER_IP
    )
    assert (await _http_error(_register(db_session, redis, custody, prepared)))[
        0
    ] == 429


# ---------------------------------------------------------------------------
# background relay
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_relay_adds_signer_then_auth_address_and_approves(
    db_session, redis, session_factory, chain, custody, device
):
    db_session.add(User(fid=FID, username="tester", signer_status="none"))
    await db_session.commit()

    prepared = await _link(db_session, redis, session_factory, custody, device)

    sent = [call.kwargs for call in chain["send_add_for"].await_args_list]
    assert [add["key_type"] for add in sent] == [1, 2]
    assert sent[0]["key"] == prepared["signer_public_key"]
    assert sent[1]["key"] == "0x" + "00" * 12 + device.address[2:].lower()
    assert chain["wait_for_add_receipt"].await_count == 2
    row = await _row(session_factory, prepared)
    assert row.status == "approved"
    assert row.approved_at is not None
    assert row.add_tx_hash == TX_SIGNER
    assert row.auth_address_tx_hash == TX_AUTH
    async with session_factory() as session:
        auth = (await session.execute(select(AuthAddress))).scalar_one()
        user = (await session.execute(select(User))).scalar_one()
    assert auth.address == device.address
    assert auth.add_tx_hash == TX_AUTH
    assert user.signer_status == "approved"
    assert redis.store[f"auth_addr:{device.address.lower()}"] == str(FID)
    assert f"signer_relay:{prepared['prepare_id']}" not in redis.store


@pytest.mark.asyncio
async def test_relay_skips_keys_already_on_chain(
    db_session, redis, session_factory, chain, custody, device
):
    chain["key_data_of"].return_value = (key_gateway.KEY_STATE_ADDED, 1)
    chain["key_data_of"].side_effect = [
        (key_gateway.KEY_STATE_ADDED, 1),
        (key_gateway.KEY_STATE_NULL, 0),
    ]
    chain["send_add_for"].side_effect = [TX_AUTH]

    prepared = await _link(db_session, redis, session_factory, custody, device)

    assert chain["send_add_for"].await_count == 1
    assert chain["send_add_for"].await_args.kwargs["key_type"] == 2
    row = await _row(session_factory, prepared)
    assert row.status == "approved"
    assert row.add_tx_hash is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (key_gateway.KeyGatewayValidationError("bad", reason="x"), "invalid_signature"),
        (key_gateway.KeyGatewaySpendCapError("cap"), "relay_unavailable"),
        (key_gateway.KeyGatewayError("rpc down"), "relay_failed"),
    ],
)
async def test_relay_failure_marks_row_failed(
    db_session, redis, session_factory, chain, custody, device, error, code
):
    chain["send_add_for"].side_effect = error

    prepared = await _link(db_session, redis, session_factory, custody, device)

    row = await _row(session_factory, prepared)
    assert row.status == "failed"
    assert row.failure_reason == code
    progress = await _status(db_session, redis, prepared)
    assert progress.status == "failed"
    assert progress.error == code


@pytest.mark.asyncio
async def test_relay_auth_address_revert_fails_whole_link(
    db_session, redis, session_factory, chain, custody, device
):
    chain["wait_for_add_receipt"].side_effect = [
        None,
        key_gateway.KeyGatewayError("reverted", reason="reverted"),
    ]

    prepared = await _link(db_session, redis, session_factory, custody, device)

    row = await _row(session_factory, prepared)
    assert row.status == "failed"
    assert row.failure_reason == "reverted"
    assert row.add_tx_hash == TX_SIGNER


@pytest.mark.asyncio
async def test_relay_unexpected_error_marks_failed(
    db_session, redis, session_factory, chain, custody, device
):
    chain["send_add_for"].side_effect = RuntimeError("boom")

    prepared = await _link(db_session, redis, session_factory, custody, device)

    row = await _row(session_factory, prepared)
    assert row.status == "failed"
    assert row.failure_reason == "internal_error"


@pytest.mark.asyncio
async def test_relay_relayer_lock_busy_marks_unavailable(
    db_session, redis, session_factory, chain, custody, device, monkeypatch
):
    monkeypatch.setattr(user_signer_service, "RELAYER_LOCK_WAIT_SECONDS", 0.0)
    redis.store[user_signer_service.RELAYER_LOCK_KEY] = "other-worker"

    prepared = await _link(db_session, redis, session_factory, custody, device)

    row = await _row(session_factory, prepared)
    assert row.failure_reason == "relay_unavailable"
    chain["send_add_for"].assert_not_awaited()


@pytest.mark.asyncio
async def test_relay_runs_once(
    db_session, redis, session_factory, chain, custody, device
):
    prepared = await _link(db_session, redis, session_factory, custody, device)
    await _relay(redis, session_factory, custody, prepared)

    assert chain["send_add_for"].await_count == 2


@pytest.mark.asyncio
async def test_relay_skips_when_another_worker_holds_it(
    db_session, redis, session_factory, chain, custody, device
):
    prepared = await _prepare(db_session, redis, device)
    await _register(db_session, redis, custody, prepared)
    redis.store[f"signer_relay:{prepared['prepare_id']}"] = "other-worker"

    await _relay(redis, session_factory, custody, prepared)

    chain["send_add_for"].assert_not_awaited()


# ---------------------------------------------------------------------------
# status (progress only; never a session)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_confirming_reports_submitted_then_reconciles(
    db_session, redis, session_factory, chain, custody, device
):
    chain["is_ed25519_signer_active"].return_value = False
    prepared = await _link(db_session, redis, session_factory, custody, device)
    assert (await _row(session_factory, prepared)).status == "confirming"

    progress = await _status(db_session, redis, prepared)
    assert progress.status == "submitted"
    assert progress.signer_tx_hash == TX_SIGNER
    assert progress.auth_address_tx_hash == TX_AUTH

    chain["is_ed25519_signer_active"].return_value = True
    progress = await _status(db_session, redis, prepared)
    assert progress.status == "approved"
    assert progress.error is None
    # Progress carries no login capability (M2-custody).
    assert not hasattr(progress, "is_login_available")


@pytest.mark.asyncio
async def test_status_survives_hypersnap_outage(
    db_session, redis, session_factory, chain, custody, device
):
    chain["is_ed25519_signer_active"].side_effect = hypersnap.HypersnapError(
        "down", path="/v1/signersByFid"
    )
    prepared = await _link(db_session, redis, session_factory, custody, device)

    progress = await _status(db_session, redis, prepared)

    assert progress.status == "submitted"


@pytest.mark.asyncio
async def test_status_pending_then_expired(db_session, redis, chain, device):
    prepared = await _prepare(db_session, redis, device)
    assert (await _status(db_session, redis, prepared)).status == "pending"

    redis.store.pop(f"signer_prepare:{prepared['prepare_id']}")
    progress = await _status(db_session, redis, prepared)

    assert (progress.status, progress.error) == ("failed", "prepare_expired")


@pytest.mark.asyncio
async def test_status_unknown_prepare_404(db_session, redis, chain):
    call = user_signer_service.get_prepare_status(
        db_session, redis, prepare_id=uuid.uuid4(), client_ip=CLIENT_IP
    )
    assert (await _http_error(call))[0] == 404


@pytest.mark.asyncio
async def test_status_rate_limited_per_prepare(db_session, redis, chain, device):
    prepared = await _prepare(db_session, redis, device)
    redis.counters[f"signer_status_rate:prepare:{prepared['prepare_id']}"] = (
        user_signer_service.STATUS_RATE_PER_PREPARE
    )
    assert (await _http_error(_status(db_session, redis, prepared)))[0] == 429


@pytest.mark.asyncio
async def test_status_poll_never_marks_a_login_issued(
    db_session, redis, session_factory, chain, custody, device
):
    """Polling an approved prepare never records (or grants) a session."""
    prepared = await _link(db_session, redis, session_factory, custody, device)

    for _ in range(2):
        assert (await _status(db_session, redis, prepared)).status == "approved"

    row = await _row(session_factory, prepared)
    assert row.login_issued_at is None
    assert not hasattr(user_signer_service, "claim_login")


@pytest.mark.asyncio
async def test_prepare_marks_protocol_auth_nonce(db_session, redis, chain, device):
    """L5-custody: the register token's nonce is recognisable for its lifetime."""
    prepared = await _prepare(db_session, redis, device)
    nonce = prepared["protocol_auth"]["nonce"]

    assert await user_signer_service.is_prepare_nonce(redis, nonce) is True
    assert await user_signer_service.is_prepare_nonce(redis, "f" * 32) is False
    assert await user_signer_service.is_prepare_nonce(redis, "") is False
    assert redis.expiries[f"signer_prepare_nonce:{nonce}"] == (
        user_signer_service.PREPARE_TTL_SECONDS
        + user_signer_service.PROTOCOL_AUTH_MAX_TTL_SECONDS
    )


@pytest.mark.asyncio
async def test_relay_logs_never_carry_prepare_id(
    db_session, redis, session_factory, chain, custody, device, caplog
):
    """``prepare_id`` stays out of logs (it identifies an in-flight link)."""
    chain["send_add_for"].side_effect = RuntimeError("boom")
    prepared = await _prepare(db_session, redis, device)
    with caplog.at_level("INFO", logger=user_signer_service.__name__):
        await user_signer_service.register_signer(
            db_session, redis, **_register_params(custody, prepared)
        )
        await _relay(redis, session_factory, custody, prepared)

    assert "signer_register_accepted" in caplog.text
    assert "signer_relay_failed" in caplog.text
    assert prepared["prepare_id"] not in caplog.text


# ---------------------------------------------------------------------------
# users.signer_status + get_user_signer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_user_signer_status_never_downgrades(db_session):
    user = User(fid=FID, username="tester", signer_status="approved")
    db_session.add(user)
    await db_session.commit()

    await user_signer_service.apply_user_signer_status(
        db_session, user, is_approved=False
    )
    assert user.signer_status == "approved"

    user.signer_status = "none"
    await user_signer_service.apply_user_signer_status(
        db_session, user, is_approved=False
    )
    assert user.signer_status == "pending"


@pytest.mark.asyncio
async def test_get_user_signer_requires_an_approved_signer(
    db_session, redis, chain, device
):
    with pytest.raises(user_signer_service.SignerNotApprovedError):
        await user_signer_service.get_user_signer(db_session, FID)
    await _prepare(db_session, redis, device)
    # Pending signers are never served.
    with pytest.raises(user_signer_service.SignerNotApprovedError):
        await user_signer_service.get_user_signer(db_session, FID)


@pytest.mark.asyncio
async def test_get_user_signer_returns_ed25519_private_key(
    db_session, redis, session_factory, chain, custody, device
):
    prepared = await _link(db_session, redis, session_factory, custody, device)

    signer = await user_signer_service.get_user_signer(db_session, FID)

    assert isinstance(signer, ed25519.Ed25519PrivateKey)
    derived = signer.public_key().public_bytes_raw()
    assert "0x" + derived.hex() == prepared["signer_public_key"]


@pytest.mark.asyncio
async def test_get_user_signer_rejects_transplanted_ciphertext(
    db_session, redis, session_factory, chain, custody, device
):
    prepared = await _link(db_session, redis, session_factory, custody, device)
    other = await _prepare(db_session, redis, Account.create())
    row = await db_session.get(UserSigner, uuid.UUID(prepared["prepare_id"]))
    other_row = await db_session.get(UserSigner, uuid.UUID(other["prepare_id"]))
    # AAD binds the blob to its row id.
    row.encrypted_private_key = other_row.encrypted_private_key
    await db_session.commit()

    with pytest.raises(signer_crypto.SignerDecryptError):
        await user_signer_service.get_user_signer(db_session, FID)


# ---------------------------------------------------------------------------
# signer_registry
# ---------------------------------------------------------------------------

# Captured from haatz.quilibrium.com ``GET /v1/signersByFid?fid=3`` (trimmed):
# ``fid`` and ``keyType`` are JSON integers, keys are 0x-hex strings.
LIVE_SIGNERS_BY_FID = {
    "signers": [
        {
            "source": "SIGNER_SOURCE_ONCHAIN",
            "key": "0x" + "5f" * 32,
            "keyType": 1,
            "fid": 3,
            "addedAt": 1700000000,
            "onChainEvent": {"type": "EVENT_TYPE_SIGNER", "fid": 3},
        },
        {
            "source": "SIGNER_SOURCE_ONCHAIN",
            "key": "0x" + "00" * 12 + "ab" * 20,
            "keyType": 2,
            "fid": 3,
            "addedAt": 1700000001,
            "onChainEvent": {"type": "EVENT_TYPE_SIGNER", "fid": 3},
        },
    ],
    "nextPageToken": None,
    "gaslessSignerCount": 0,
    "gaslessSignerLimit": 0,
    "currentUserNonce": 0,
}


@pytest.mark.asyncio
async def test_list_active_ed25519_keys_reads_live_response_shape(monkeypatch):
    monkeypatch.setattr(
        hypersnap, "get_v1", AsyncMock(return_value=LIVE_SIGNERS_BY_FID)
    )
    assert await signer_registry.list_active_ed25519_keys(3) == {"0x" + "5f" * 32}


@pytest.mark.asyncio
async def test_list_active_ed25519_keys_paginates_and_filters(monkeypatch):
    pages = [
        {
            "signers": [
                {"key": "0xAA", "keyType": 1, "source": "SIGNER_SOURCE_ONCHAIN"},
                {"key": "0xbb", "keyType": 2, "source": "SIGNER_SOURCE_ONCHAIN"},
                {"key": "0xcc", "keyType": 1, "source": "SIGNER_SOURCE_OFFCHAIN"},
            ],
            "nextPageToken": "page2",
        },
        {
            "signers": [
                {
                    "key": "dd",
                    "keyType": 1,
                    "source": "SIGNER_SOURCE_ONCHAIN",
                    "fid": FID,
                },
                {
                    "key": "0xee",
                    "keyType": 1,
                    "source": "SIGNER_SOURCE_ONCHAIN",
                    "fid": FID + 1,
                },
            ],
            "nextPageToken": None,
        },
    ]
    get_v1 = AsyncMock(side_effect=pages)
    monkeypatch.setattr(hypersnap, "get_v1", get_v1)

    keys = await signer_registry.list_active_ed25519_keys(FID)

    assert keys == {"0xaa", "0xdd"}
    assert get_v1.await_count == 2
    assert get_v1.await_args_list[1].args[1]["pageToken"] == "page2"


@pytest.mark.asyncio
async def test_is_auth_address_active_reads_key_registry(monkeypatch):
    device = Account.create()
    key_data_of = AsyncMock(
        return_value=(key_gateway.KEY_STATE_ADDED, key_gateway.KEY_TYPE_AUTH_ADDRESS)
    )
    monkeypatch.setattr(key_gateway, "key_data_of", key_data_of)

    assert await signer_registry.is_auth_address_active(FID, device.address)
    fid, key = key_data_of.await_args.args
    assert fid == FID
    assert key == b"\x00" * 12 + bytes.fromhex(device.address[2:])

    key_data_of.return_value = (key_gateway.KEY_STATE_REMOVED, 2)
    assert not await signer_registry.is_auth_address_active(FID, device.address)
