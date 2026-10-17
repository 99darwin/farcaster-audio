"""Custody-minted Direct Casts token: validation, recovery, storage, routes."""

import base64
import logging
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.clients import key_gateway
from app.config import settings
from app.database import Base
from app.dependencies import get_db, get_farcaster_spaces_service
from app.main import app
from app.models.user_farcaster_token import UserFarcasterToken
from app.models.user_signer import UserSigner
from app.schemas.farcaster_token import DirectCastAuthRequest
from app.services import farcaster_token_service as svc
from app.services import signer_crypto
from app.services.auth_service import create_jwt
from app.services.farcaster_spaces_service import _canonicalize

FID = 4242
NOW_MS = 1_800_000_000_000
NOW = datetime.fromtimestamp(NOW_MS / 1000, UTC)
SECRET = "MK-upstream-secret-value"
ENABLE_URL = "/v1/messages/enable"


def _request(*, timestamp: int = NOW_MS, expires_at: int | None = None) -> dict:
    return {
        "method": "generateToken",
        "params": {
            "timestamp": timestamp,
            "expiresAt": expires_at or timestamp + svc.DC_TOKEN_TTL_MS,
        },
    }


def _sign(account, payload: dict) -> str:
    signed = account.sign_message(encode_defunct(text=_canonicalize(payload)))
    return "eip191:" + base64.b64encode(signed.signature).decode()


def _parsed(payload: dict) -> DirectCastAuthRequest:
    return DirectCastAuthRequest.model_validate(payload)


class FakeSpaces:
    """Stands in for ``FarcasterSpacesService.mint_bearer_from_signed_request``."""

    def __init__(self, *, expires_at_ms: int | None = None, error=None):
        self.expires_at_ms = expires_at_ms or NOW_MS + 1000 * svc.DAY_MS
        self.error = error
        self.calls: list[tuple[dict, str]] = []

    async def mint_bearer_from_signed_request(self, auth_request, bearer, *, log_label):
        self.calls.append((auth_request, bearer))
        if self.error is not None:
            raise self.error
        return SECRET, self.expires_at_ms


@pytest.fixture(autouse=True)
def encryption_key(monkeypatch):
    monkeypatch.setattr(
        settings,
        "SIGNER_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(b"\x09" * 32).decode(),
    )


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
            tables=[UserFarcasterToken.__table__, UserSigner.__table__],
        )
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
async def db(session_factory):
    async with session_factory() as session:
        yield session


@pytest.fixture
def custody():
    return Account.create()


def _resolver(address):
    async def resolve(fid):
        return address

    return resolve


async def _enable(db, custody, payload=None, *, signer=None, spaces=None, **kw):
    payload = payload or _request()
    return await svc.enable_direct_casts(
        db,
        fid=FID,
        auth_request=_parsed(payload),
        signature=_sign(signer or custody, payload),
        spaces_service=spaces or FakeSpaces(),
        custody_resolver=kw.pop("resolver", _resolver(custody.address)),
        now_ms=NOW_MS,
    )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        _request(timestamp=NOW_MS + svc.CLOCK_SKEW_MS + 1),  # future
        _request(timestamp=NOW_MS - svc.MAX_REQUEST_AGE_MS - 1),  # stale
        _request(expires_at=NOW_MS - 1),  # already expired
        _request(expires_at=NOW_MS + svc.DC_TOKEN_TTL_MS + svc.CLOCK_SKEW_MS + 1),
    ],
)
def test_validate_rejects_bad_timestamps(payload):
    with pytest.raises(svc.FarcasterTokenError) as exc:
        svc.validate_auth_request(_parsed(payload), now_ms=NOW_MS)
    assert (exc.value.status_code, exc.value.code) == (400, "invalid_auth_request")


def test_validate_returns_requested_expiry():
    payload = _request()
    assert (
        svc.validate_auth_request(_parsed(payload), now_ms=NOW_MS)
        == payload["params"]["expiresAt"]
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"method": "signIn", "params": {"timestamp": 1, "expiresAt": 2}},
        {"method": "generateToken", "params": {"timestamp": 1}},
        {"method": "generateToken", "params": {"timestamp": "1", "expiresAt": 2}},
        {
            "method": "generateToken",
            "params": {"timestamp": 1, "expiresAt": 2, "extra": 3},
        },
    ],
)
def test_schema_rejects_non_canonical_shapes(payload):
    with pytest.raises(ValueError):
        DirectCastAuthRequest.model_validate(payload)


def test_canonical_payload_matches_client_bytes():
    assert _canonicalize(_parsed(_request()).to_upstream()) == (
        '{"method":"generateToken","params":'
        f'{{"expiresAt":{NOW_MS + svc.DC_TOKEN_TTL_MS},"timestamp":{NOW_MS}}}}}'
    )


# ---------------------------------------------------------------------------
# Signature / custody
# ---------------------------------------------------------------------------


def test_recover_returns_signer(custody):
    payload = _request()
    assert (
        svc.recover_auth_request_signer(_parsed(payload), _sign(custody, payload))
        == custody.address
    )


@pytest.mark.parametrize(
    "signature",
    [
        "0x" + "11" * 65,
        "eip191:not base64!",
        "eip191:" + base64.b64encode(b"x").decode(),
    ],
)
def test_recover_rejects_malformed_signatures(signature):
    with pytest.raises(svc.FarcasterTokenError) as exc:
        svc.recover_auth_request_signer(_parsed(_request()), signature)
    assert exc.value.code == "invalid_signature"


async def test_enable_rejects_non_custody_signer(db, custody):
    spaces = FakeSpaces()
    with pytest.raises(svc.FarcasterTokenError) as exc:
        await _enable(db, custody, signer=Account.create(), spaces=spaces)
    assert exc.value.code == "invalid_signature"
    assert spaces.calls == []  # never forwarded upstream
    assert await db.get(UserFarcasterToken, FID) is None


@pytest.mark.parametrize(
    ("resolver_result", "code"),
    [
        (None, "fid_not_found"),
        (key_gateway.KeyGatewayError("rpc"), "registry_unavailable"),
    ],
)
async def test_enable_maps_custody_lookup_failures(db, custody, resolver_result, code):
    async def resolve(fid):
        if isinstance(resolver_result, Exception):
            raise resolver_result
        return resolver_result

    with pytest.raises(svc.FarcasterTokenError) as exc:
        await _enable(db, custody, resolver=resolve)
    assert exc.value.code == code


@pytest.mark.parametrize(
    ("status_code", "code"), [(401, "token_rejected"), (503, "upstream_error")]
)
async def test_enable_maps_upstream_errors(db, custody, status_code, code):
    request = httpx.Request("PUT", "https://client.farcaster.xyz/v2/onboarding-state")
    error = httpx.HTTPStatusError(
        "boom", request=request, response=httpx.Response(status_code, request=request)
    )
    with pytest.raises(svc.FarcasterTokenError) as exc:
        await _enable(db, custody, spaces=FakeSpaces(error=error))
    assert exc.value.code == code


async def test_enable_without_encryption_key_never_mints(db, custody, monkeypatch):
    monkeypatch.setattr(settings, "SIGNER_ENCRYPTION_KEY", "")
    spaces = FakeSpaces()
    with pytest.raises(svc.FarcasterTokenError) as exc:
        await _enable(db, custody, spaces=spaces)
    assert (exc.value.status_code, exc.value.code) == (503, "messaging_unavailable")
    assert spaces.calls == []


# ---------------------------------------------------------------------------
# Store / read / delete
# ---------------------------------------------------------------------------


async def test_enable_stores_encrypted_token_and_forwards_signature(db, custody):
    payload = _request()
    spaces = FakeSpaces()
    status = await _enable(db, custody, payload, spaces=spaces)

    assert status.token_status == "active" and status.is_enabled
    # Capped at the requested 90 days even though upstream offered 1000.
    expected = datetime.fromtimestamp(payload["params"]["expiresAt"] / 1000, UTC)
    assert status.expires_at == expected
    assert spaces.calls == [(payload, _sign(custody, payload))]

    row = await db.get(UserFarcasterToken, FID)
    assert SECRET not in row.encrypted_token
    assert await svc.get_direct_cast_bearer(db, FID, now=NOW) == SECRET


async def test_enable_uses_shorter_upstream_expiry(db, custody):
    upstream = NOW_MS + 7 * svc.DAY_MS
    status = await _enable(db, custody, spaces=FakeSpaces(expires_at_ms=upstream))
    assert status.expires_at == datetime.fromtimestamp(upstream / 1000, UTC)


async def test_enable_twice_upserts(db, custody):
    await _enable(db, custody)
    await _enable(db, custody)
    assert await svc.get_direct_cast_bearer(db, FID, now=NOW) == SECRET


async def test_status_and_bearer_lifecycle(db, custody):
    missing = await svc.get_token_status(db, FID, now=NOW)
    assert (missing.token_status, missing.expires_at) == ("missing", None)
    assert await svc.get_direct_cast_bearer(db, FID, now=NOW) is None

    status = await _enable(db, custody)
    later = status.expires_at - svc.EXPIRY_MARGIN + timedelta(seconds=1)
    assert (await svc.get_token_status(db, FID, now=later)).token_status == "expired"
    assert await svc.get_direct_cast_bearer(db, FID, now=later) is None

    await svc.delete_direct_cast_token(db, FID)
    await svc.delete_direct_cast_token(db, FID)  # idempotent
    assert (await svc.get_token_status(db, FID, now=NOW)).token_status == "missing"


async def test_token_bound_to_fid(db, custody):
    await _enable(db, custody)
    row = await db.get(UserFarcasterToken, FID)
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(
            row.encrypted_token,
            aad=f"fid:{FID + 1}",
            purpose=signer_crypto.SignerPurpose.FARCASTER_TOKEN,
        )


async def test_secrets_never_logged(db, custody, caplog):
    payload = _request()
    signature = _sign(custody, payload)
    caplog.set_level(logging.DEBUG)
    await _enable(db, custody, payload)
    with pytest.raises(svc.FarcasterTokenError):
        await _enable(db, custody, payload, signer=Account.create())
    assert SECRET not in caplog.text
    assert signature not in caplog.text
    assert signature.removeprefix("eip191:") not in caplog.text


async def test_enable_after_register_is_best_effort(session_factory, custody):
    import uuid

    prepare_id = uuid.uuid4()
    async with session_factory() as db:
        db.add(
            UserSigner(
                id=prepare_id,
                fid=FID,
                public_key="0x" + "ab" * 32,
                encrypted_private_key="x",
                status="pending",
            )
        )
        await db.commit()

    payload = _request(timestamp=svc._now_ms())
    resolver = AsyncMock(return_value=custody.address)
    with patch.object(key_gateway, "custody_of", resolver):
        await svc.enable_after_signer_register(
            session_factory=session_factory,
            spaces_service=FakeSpaces(),
            prepare_id=prepare_id,
            auth_request=_parsed(payload),
            signature=_sign(custody, payload),
        )
        # A bad signature is swallowed (the link must not fail).
        await svc.enable_after_signer_register(
            session_factory=session_factory,
            spaces_service=FakeSpaces(),
            prepare_id=prepare_id,
            auth_request=_parsed(payload),
            signature=_sign(Account.create(), payload),
        )
        # Unknown prepare id is a no-op.
        await svc.enable_after_signer_register(
            session_factory=session_factory,
            spaces_service=FakeSpaces(),
            prepare_id=uuid.uuid4(),
            auth_request=_parsed(payload),
            signature=_sign(custody, payload),
        )
    resolver.assert_awaited_with(FID)

    async with session_factory() as db:
        assert await svc.get_direct_cast_bearer(db, FID) == SECRET


def test_encrypt_secret_rejects_empty():
    with pytest.raises(ValueError):
        signer_crypto.encrypt_secret(
            b"", aad="fid:1", purpose=signer_crypto.SignerPurpose.FARCASTER_TOKEN
        )


# ---------------------------------------------------------------------------
# POST /v1/messages/enable
# ---------------------------------------------------------------------------


@pytest.fixture
def enable_overrides(monkeypatch, db):
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", True)

    async def fake_db():
        yield db

    app.dependency_overrides[get_db] = fake_db
    app.dependency_overrides[get_farcaster_spaces_service] = lambda: FakeSpaces()
    yield
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_farcaster_spaces_service, None)


def _auth(fid: int = FID) -> dict:
    token, _ = create_jwt(fid)
    return {"Authorization": f"Bearer {token}"}


async def test_enable_route_returns_token_status(client, enable_overrides, custody):
    payload = _request()
    signature = _sign(custody, payload)
    expires = datetime.fromtimestamp(payload["params"]["expiresAt"] / 1000, UTC)
    with patch.object(
        svc,
        "enable_direct_casts",
        AsyncMock(return_value=svc.DirectCastTokenStatus("active", expires)),
    ) as enable:
        response = await client.post(
            ENABLE_URL,
            json={"dc_auth_request": payload, "dc_auth_signature": signature},
            headers=_auth(),
        )
    assert response.status_code == 200, response.text
    assert response.json()["token_status"] == "active"
    assert enable.await_args.kwargs["fid"] == FID
    assert signature not in response.text


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"dc_auth_request": _request()},
        {"dc_auth_request": {"method": "x"}, "dc_auth_signature": "eip191:SECRETSIG"},
        ["not", "an", "object"],
    ],
)
async def test_enable_route_malformed_body_is_opaque_400(
    client, enable_overrides, body
):
    response = await client.post(ENABLE_URL, json=body, headers=_auth())
    assert response.status_code == 400
    assert response.json() == {"detail": "invalid_auth_request"}
    assert "SECRETSIG" not in response.text


async def test_enable_route_maps_service_errors(client, enable_overrides, custody):
    payload = _request()
    with patch.object(
        svc,
        "enable_direct_casts",
        AsyncMock(side_effect=svc.FarcasterTokenError(400, "invalid_signature")),
    ):
        response = await client.post(
            ENABLE_URL,
            json={
                "dc_auth_request": payload,
                "dc_auth_signature": _sign(custody, payload),
            },
            headers=_auth(),
        )
    assert response.status_code == 400
    assert response.json() == {"detail": "invalid_signature"}


async def test_enable_route_requires_jwt(client, enable_overrides):
    response = await client.post(ENABLE_URL, json={})
    assert response.status_code in (401, 403)


async def test_enable_route_404_when_messaging_disabled(
    client, enable_overrides, monkeypatch
):
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", False)
    response = await client.post(ENABLE_URL, json={}, headers=_auth())
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /v1/messages/token (L3)
# ---------------------------------------------------------------------------

TOKEN_URL = "/v1/messages/token"


@pytest.mark.parametrize("messaging_enabled", [True, False])
async def test_delete_token_route_forgets_only_callers_token(
    client, enable_overrides, db, custody, monkeypatch, messaging_enabled
):
    await _enable(db, custody)
    other = UserFarcasterToken(
        fid=FID + 1, encrypted_token="v1:x", expires_at=NOW + timedelta(days=1)
    )
    db.add(other)
    await db.commit()
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", messaging_enabled)

    response = await client.delete(TOKEN_URL, headers=_auth())
    assert response.status_code == 204
    assert (await svc.get_token_status(db, FID, now=NOW)).token_status == "missing"
    assert await db.get(UserFarcasterToken, FID + 1) is not None

    again = await client.delete(TOKEN_URL, headers=_auth())
    assert again.status_code == 204  # idempotent


async def test_delete_token_route_requires_first_party_jwt(client, enable_overrides):
    from app.services.auth_service import create_partner_jwt

    assert (await client.delete(TOKEN_URL)).status_code in (401, 403)
    partner, _ = create_partner_jwt(fid=FID, partner_app_id="app", ttl_seconds=60)
    response = await client.delete(
        TOKEN_URL, headers={"Authorization": f"Bearer {partner}"}
    )
    assert response.status_code in (401, 403)


async def test_revoke_rejected_token_compare_and_delete(db, custody):
    await _enable(db, custody)
    # A different (e.g. freshly re-enabled) token is left alone.
    assert not await svc.revoke_rejected_token(db, FID, bearer="MK-other-token")
    assert (await svc.get_token_status(db, FID, now=NOW)).token_status == "active"

    assert await svc.revoke_rejected_token(db, FID, bearer=SECRET)
    assert (await svc.get_token_status(db, FID, now=NOW)).token_status == "missing"
    assert not await svc.revoke_rejected_token(db, FID, bearer=SECRET)  # idempotent


async def test_rejected_token_flips_status_to_missing(session_factory, custody):
    from app.services.direct_cast_service import revoke_rejected_token

    async with session_factory() as db:
        await _enable(db, custody)
    await revoke_rejected_token(session_factory, FID, SECRET)
    async with session_factory() as db:
        status = await svc.get_token_status(db, FID, now=NOW)
    assert status.token_status == "missing"


async def test_enable_route_validation_never_echoes_signature(client, enable_overrides):
    signature = "eip191:" + "S" * 80
    body = {
        "dc_auth_request": {"method": "generateToken"},
        "dc_auth_signature": signature,
    }
    response = await client.post(ENABLE_URL, json=body, headers=_auth())
    assert response.status_code in (400, 422)
    assert signature not in response.text
    assert "S" * 80 not in response.text


# ---------------------------------------------------------------------------
# Round 4: atomic upsert, background boundary
# ---------------------------------------------------------------------------


async def test_store_token_upserts_over_row_written_by_another_session(
    session_factory, custody
):
    """Two enables in different sessions (signer-register background task +
    "Enable messages") must not collide; the session that already holds the
    row sees the new value."""
    first_expiry = NOW_MS + 7 * svc.DAY_MS
    second_expiry = NOW_MS + 30 * svc.DAY_MS
    async with session_factory() as a, session_factory() as b:
        await _enable(a, custody, spaces=FakeSpaces(expires_at_ms=first_expiry))
        held = await a.get(UserFarcasterToken, FID)  # a now holds the row
        await _enable(b, custody, spaces=FakeSpaces(expires_at_ms=second_expiry))
        await _enable(a, custody, spaces=FakeSpaces(expires_at_ms=second_expiry))
        status = await svc.get_token_status(a, FID, now=NOW)
        assert held is await a.get(UserFarcasterToken, FID)
    assert status.expires_at == datetime.fromtimestamp(second_expiry / 1000, UTC)
    async with session_factory() as db:
        from sqlalchemy import func, select

        count = await db.scalar(select(func.count()).select_from(UserFarcasterToken))
        assert count == 1


async def test_enable_after_register_contains_unexpected_errors(
    session_factory, custody, caplog
):
    import uuid

    prepare_id = uuid.uuid4()
    async with session_factory() as db:
        db.add(
            UserSigner(
                id=prepare_id,
                fid=FID,
                public_key="0x" + "ab" * 32,
                encrypted_private_key="x",
                status="pending",
            )
        )
        await db.commit()

    leaked = "eip191:LEAKY-SIGNATURE-TEXT"
    payload = _request(timestamp=svc._now_ms())
    caplog.set_level(logging.DEBUG)
    with patch.object(
        svc, "enable_direct_casts", AsyncMock(side_effect=RuntimeError(leaked))
    ):
        # Must not raise out of the background task.
        await svc.enable_after_signer_register(
            session_factory=session_factory,
            spaces_service=FakeSpaces(),
            prepare_id=prepare_id,
            auth_request=_parsed(payload),
            signature=_sign(custody, payload),
        )
    assert f"fid={FID}" in caplog.text
    assert "RuntimeError" in caplog.text
    assert leaked not in caplog.text


async def test_enable_after_register_contains_session_errors(caplog):
    import uuid

    class _BrokenSession:
        async def __aenter__(self):
            raise OSError("db down: postgres://user:pw@host")

        async def __aexit__(self, *exc):
            return False

    caplog.set_level(logging.DEBUG)
    payload = _request()
    await svc.enable_after_signer_register(
        session_factory=_BrokenSession,
        spaces_service=FakeSpaces(),
        prepare_id=uuid.uuid4(),
        auth_request=_parsed(payload),
        signature="eip191:x",
    )
    assert "fid=None error=OSError" in caplog.text
    assert "pw@host" not in caplog.text


async def test_store_token_survives_insert_race(session_factory, monkeypatch):
    """Session ``a`` decided "no row yet" before ``b`` inserted one: a
    read-then-INSERT store would hit the primary key; the upsert can't."""
    async with session_factory() as a, session_factory() as b:
        await svc._store_token(b, fid=FID, secret="first", expires_at_ms=NOW_MS)

        async def stale_get(*args, **kwargs):
            return None  # what ``a`` would have read before ``b`` committed

        monkeypatch.setattr(a, "get", stale_get)
        later = NOW_MS + svc.DAY_MS
        await svc._store_token(a, fid=FID, secret="second", expires_at_ms=later)
    async with session_factory() as db:
        assert await svc.get_direct_cast_bearer(db, FID, now=NOW) == "second"


@pytest.mark.parametrize(
    "kwargs",
    [
        {},  # no body
        {"content": b"not json", "headers": {"content-type": "application/json"}},
    ],
)
async def test_enable_route_missing_or_unparseable_body_is_redacted_422(
    client, enable_overrides, kwargs
):
    """Only a body that parses as JSON reaches the opaque-400 path; a missing
    or non-JSON body is FastAPI's 422 with ``input``/``ctx`` dropped."""
    headers = {**_auth(), **kwargs.pop("headers", {})}
    response = await client.post(ENABLE_URL, headers=headers, **kwargs)
    assert response.status_code == 422
    for entry in response.json()["detail"]:
        assert set(entry) <= {"type", "loc", "msg"}
    assert "not json" not in response.text


def test_clock_skew_is_sixty_seconds():
    assert svc.CLOCK_SKEW_MS == 60 * svc.MS_PER_SECOND  # docs section 2
