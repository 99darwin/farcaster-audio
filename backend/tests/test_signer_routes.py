"""HTTP contract for /v1/auth/signer/*, /v1/auth/protocol and miniapp hqa1."""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from eth_account import Account
from jose import jwt as jose_jwt

from app.clients import key_gateway
from app.config import settings
from app.models.user import User
from app.services.auth_service import create_jwt
from app.services.siwf_service import ProtocolAuthClaims, ProtocolAuthError
from app.services.user_signer_service import PrepareStatus
from tests.protocol_auth_helpers import make_token

FID = 7777
PREPARE_ID = "6f1c1f36-5d43-4c47-9d0c-0d8f8f1b2a10"
PUBLIC_KEY = "0x" + "ab" * 32
DEVICE = "0x" + "12" * 20
TX_SIGNER = "0x" + "cd" * 32
TX_AUTH = "0x" + "ef" * 32

PREPARED = {
    "prepare_id": PREPARE_ID,
    "custody_address": "0x8ba1f109551bd432803012645ac136ddd64dba72",
    "signer_public_key": PUBLIC_KEY,
    "typed_data": {
        "signer": {"primaryType": "Add", "message": {"keyType": 1}},
        "auth_address": {"primaryType": "Add", "message": {"keyType": 2}},
    },
    "protocol_auth": {
        "domain": "juke.audio",
        "uri": "https://juke.audio",
        "nonce": "0123456789abcdef0123456789abcdef",
        "expires_at": 1_900_000_000,
    },
    "expires_at": 1_900_000_000,
}

REGISTER_BODY = {
    "prepare_id": PREPARE_ID,
    "signer_add_signature": "0x" + "11" * 65,
    "auth_address_add_signature": "0x" + "22" * 65,
    "protocol_auth_token": "hqa1.e30.e30",
}

PROFILE = {
    "username": "tester",
    "display_name": "Tester",
    "pfp_url": None,
    "custody_address": None,
}


def _bearer(fid: int = FID) -> dict:
    token, _ = create_jwt(fid)
    return {"Authorization": f"Bearer {token}"}


def _user(signer_status: str = "approved") -> User:
    return User(
        fid=FID,
        username="tester",
        display_name="Tester",
        signer_status=signer_status,
        is_admin=False,
    )


def _progress(status: str = "approved"):
    return PrepareStatus(
        prepare_id=uuid.UUID(PREPARE_ID),
        fid=FID,
        status=status,
        signer_tx_hash=TX_SIGNER,
        auth_address_tx_hash=TX_AUTH,
        error=None,
    )


def _service(name: str, **kwargs):
    return patch(
        f"app.routers.auth.user_signer_service.{name}", new_callable=AsyncMock, **kwargs
    )


@pytest.fixture(autouse=True)
def _no_approved_signer_lookup():
    """``/protocol`` checks for an approved signer; keep these tests DB-free."""
    with _service("has_approved_signer", return_value=False) as lookup:
        yield lookup


# ---------------------------------------------------------------------------
# POST /signer/prepare
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prepare_returns_contract_payload(client):
    with _service("prepare_signer", return_value=PREPARED) as prepare:
        response = await client.post(
            "/v1/auth/signer/prepare", json={"fid": FID, "auth_address": DEVICE}
        )

    assert response.status_code == 200, response.text
    assert response.json() == PREPARED
    assert prepare.await_args.kwargs["fid"] == FID
    assert prepare.await_args.kwargs["auth_address"] == DEVICE


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"fid": FID},
        {"fid": 0, "auth_address": DEVICE},
        {"fid": -3, "auth_address": DEVICE},
        {"fid": "abc", "auth_address": DEVICE},
    ],
)
async def test_prepare_validates_body(client, body):
    response = await client.post("/v1/auth/signer/prepare", json=body)
    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ValueError("FARCASTER_APP_MNEMONIC is not configured"), 503),
        (key_gateway.KeyGatewayError("rpc down"), 502),
    ],
)
async def test_prepare_maps_upstream_errors(client, error, code):
    with _service("prepare_signer", side_effect=error):
        response = await client.post(
            "/v1/auth/signer/prepare", json={"fid": FID, "auth_address": DEVICE}
        )

    assert response.status_code == code
    # Configuration details never leak to the client.
    assert "MNEMONIC" not in response.text


# ---------------------------------------------------------------------------
# POST /signer/register
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_register_returns_202_and_schedules_relay(client):
    accepted = {"prepare_id": PREPARE_ID, "status": "pending"}
    with (
        _service("register_signer", return_value=(accepted, True)),
        _service("relay_prepared_signer") as relay,
    ):
        response = await client.post("/v1/auth/signer/register", json=REGISTER_BODY)

    assert response.status_code == 202, response.text
    assert response.json() == accepted
    relay.assert_awaited_once()
    kwargs = relay.await_args.kwargs
    assert kwargs["prepare_id"] == uuid.UUID(PREPARE_ID)
    assert kwargs["signer_add_signature"] == REGISTER_BODY["signer_add_signature"]
    assert (
        kwargs["auth_address_add_signature"]
        == REGISTER_BODY["auth_address_add_signature"]
    )


@pytest.mark.asyncio
async def test_register_retry_does_not_relay_twice(client):
    accepted = {"prepare_id": PREPARE_ID, "status": "submitted"}
    with (
        _service("register_signer", return_value=(accepted, False)),
        _service("relay_prepared_signer") as relay,
    ):
        response = await client.post("/v1/auth/signer/register", json=REGISTER_BODY)

    assert response.status_code == 202
    assert response.json()["status"] == "submitted"
    relay.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing", ["auth_address_add_signature", "protocol_auth_token", "prepare_id"]
)
async def test_register_requires_every_field(client, missing):
    body = {k: v for k, v in REGISTER_BODY.items() if k != missing}
    response = await client.post("/v1/auth/signer/register", json=body)
    assert response.status_code == 422


DC_SIGNATURE = "eip191:" + "Q" * 88


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        # dc_auth_signature without dc_auth_request (model validator)
        {"dc_auth_signature": DC_SIGNATURE},
        # malformed dc_auth_request next to a valid-looking signature
        {"dc_auth_request": {"method": "nope"}, "dc_auth_signature": DC_SIGNATURE},
        # every signature present, one field type-invalid
        {"dc_auth_signature": DC_SIGNATURE, "prepare_id": "not-a-uuid"},
        # signature itself too long
        {"dc_auth_request": None, "dc_auth_signature": DC_SIGNATURE * 10},
    ],
)
async def test_register_422_never_echoes_signatures(client, overrides):
    body = {**REGISTER_BODY, **overrides}
    response = await client.post("/v1/auth/signer/register", json=body)
    assert response.status_code == 422
    for secret in (
        DC_SIGNATURE,
        "Q" * 88,
        REGISTER_BODY["signer_add_signature"],
        REGISTER_BODY["auth_address_add_signature"],
        REGISTER_BODY["protocol_auth_token"],
    ):
        assert secret not in response.text
    detail = response.json()["detail"]
    assert detail and all(set(e) <= {"type", "loc", "msg"} for e in detail)


# ---------------------------------------------------------------------------
# GET /signer/status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_requires_prepare_id(client):
    response = await client.get("/v1/auth/signer/status")
    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("progress_status", ["submitted", "approved"])
async def test_status_reports_progress_without_login(client, progress_status):
    with _service("get_prepare_status", return_value=_progress(progress_status)):
        response = await client.get(
            "/v1/auth/signer/status", params={"prepare_id": PREPARE_ID}
        )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "prepare_id": PREPARE_ID,
        "status": progress_status,
        "signer_tx_hash": TX_SIGNER,
        "auth_address_tx_hash": TX_AUTH,
        "error": None,
        "login": None,
    }


@pytest.mark.asyncio
async def test_status_never_issues_session_even_for_legacy_cookie_poll(client):
    """M2-custody: knowing a prepare_id grants nothing, even right after approval.

    Older app builds still poll with ``use_cookie``; they get ``login: null``
    and fall back to ``/v1/auth/protocol`` with their auth address.
    """
    with (
        _service("get_prepare_status", return_value=_progress("approved")),
        patch("app.routers.auth._issue_login", new_callable=AsyncMock) as issue,
    ):
        response = await client.get(
            "/v1/auth/signer/status",
            params={"prepare_id": PREPARE_ID, "use_cookie": "true"},
        )

    assert response.status_code == 200, response.text
    assert response.json()["login"] is None
    assert "set-cookie" not in response.headers
    issue.assert_not_awaited()


# ---------------------------------------------------------------------------
# POST /protocol
# ---------------------------------------------------------------------------


def _claims(fid: int = FID) -> ProtocolAuthClaims:
    now = datetime.now(timezone.utc)
    return ProtocolAuthClaims(
        fid=fid,
        address=Account.create().address,
        method="authAddress",
        domain="juke.audio",
        nonce="0123456789abcdef",
        issued_at=now,
        expires_at=now + timedelta(minutes=5),
    )


@pytest.mark.asyncio
async def test_protocol_login_issues_session_and_consumes_nonce(client):
    with (
        patch(
            "app.routers.auth.verify_protocol_auth_token",
            new_callable=AsyncMock,
            return_value=_claims(),
        ) as verify,
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
        ) as consume,
        patch(
            "app.routers.auth.fetch_user_profile",
            new_callable=AsyncMock,
            return_value=PROFILE,
        ),
        patch(
            "app.routers.auth.get_or_create_user",
            new_callable=AsyncMock,
            return_value=_user(),
        ),
    ):
        response = await client.post(
            "/v1/auth/protocol", json={"token": "hqa1.e30.e30"}
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["jwt"] and body["refresh_token"]
    assert body["user"]["signer_status"] == "approved"
    consume.assert_awaited_once_with(consume.await_args.args[0], "0123456789abcdef")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("has_signer", "expected_status"), [(True, "approved"), (False, None)]
)
async def test_protocol_login_reflects_linked_signer(
    client, _no_approved_signer_lookup, has_signer, expected_status
):
    """The first login after a phrase link (now via /protocol) marks approved."""
    _no_approved_signer_lookup.return_value = has_signer
    with (
        patch(
            "app.routers.auth.verify_protocol_auth_token",
            new_callable=AsyncMock,
            return_value=_claims(),
        ),
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch(
            "app.routers.auth.fetch_user_profile",
            new_callable=AsyncMock,
            return_value=PROFILE,
        ),
        patch(
            "app.routers.auth.get_or_create_user",
            new_callable=AsyncMock,
            return_value=_user(),
        ) as get_user,
    ):
        response = await client.post(
            "/v1/auth/protocol", json={"token": "hqa1.e30.e30"}
        )

    assert response.status_code == 200, response.text
    assert get_user.await_args.kwargs["signer_status"] == expected_status
    _no_approved_signer_lookup.assert_awaited_once()


@pytest.mark.asyncio
async def test_protocol_login_rejects_replayed_nonce(client):
    with (
        patch(
            "app.routers.auth.verify_protocol_auth_token",
            new_callable=AsyncMock,
            return_value=_claims(),
        ),
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        response = await client.post(
            "/v1/auth/protocol", json={"token": "hqa1.e30.e30"}
        )

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid_token"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reason", "code", "detail"),
    [
        ("signer_not_linked", 403, "signer_not_linked"),
        ("bad_signature", 401, "invalid_token"),
        ("expired", 401, "invalid_token"),
    ],
)
async def test_protocol_login_maps_verification_errors(client, reason, code, detail):
    with (
        patch(
            "app.routers.auth.verify_protocol_auth_token",
            new_callable=AsyncMock,
            side_effect=ProtocolAuthError(reason),
        ),
        patch("app.routers.auth.consume_siwf_nonce", new_callable=AsyncMock) as consume,
    ):
        response = await client.post(
            "/v1/auth/protocol", json={"token": "hqa1.e30.e30"}
        )

    assert response.status_code == code
    assert response.json()["detail"] == detail
    # A rejected token never burns the nonce.
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_protocol_login_end_to_end_with_custody_token(client, monkeypatch):
    """Real hqa1 verification: custody-signed token with an issued nonce."""
    account = Account.create()

    async def _id_of(address):
        return FID if address.lower() == account.address.lower() else 0

    monkeypatch.setattr(key_gateway, "id_of", _id_of)
    monkeypatch.setattr(settings, "QUICKAUTH_ALLOWED_AUDIENCES", "juke.audio")
    token, _ = make_token(account, fid=FID, nonce="0123456789abcdef")
    with (
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch(
            "app.routers.auth.fetch_user_profile",
            new_callable=AsyncMock,
            return_value=PROFILE,
        ),
        patch(
            "app.routers.auth.get_or_create_user",
            new_callable=AsyncMock,
            return_value=_user(signer_status="none"),
        ),
    ):
        response = await client.post("/v1/auth/protocol", json={"token": token})

    assert response.status_code == 200, response.text
    assert response.json()["user"]["signer_status"] == "none"


@pytest.mark.asyncio
async def test_user_response_hides_demo_signer_status(client):
    with (
        patch(
            "app.routers.auth.verify_protocol_auth_token",
            new_callable=AsyncMock,
            return_value=_claims(),
        ),
        patch(
            "app.routers.auth.consume_siwf_nonce",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch(
            "app.routers.auth.fetch_user_profile",
            new_callable=AsyncMock,
            return_value=PROFILE,
        ),
        patch(
            "app.routers.auth.get_or_create_user",
            new_callable=AsyncMock,
            return_value=_user(signer_status="demo"),
        ),
    ):
        response = await client.post(
            "/v1/auth/protocol", json={"token": "hqa1.e30.e30"}
        )

    assert response.status_code == 200
    assert response.json()["user"]["signer_status"] == "none"


@pytest.mark.asyncio
async def test_legacy_auth_address_route_is_gone(client):
    response = await client.post(
        "/v1/auth/auth-address",
        json={"address": Account.create().address},
        headers=_bearer(),
    )
    assert response.status_code == 410


# ---------------------------------------------------------------------------
# /miniapp-quickauth now takes an hqa1 token
# ---------------------------------------------------------------------------


@pytest.fixture
def custody_chain(monkeypatch):
    accounts: dict[str, int] = {}

    async def _id_of(address):
        return accounts.get(address.lower(), 0)

    monkeypatch.setattr(key_gateway, "id_of", _id_of)
    monkeypatch.setattr(settings, "QUICKAUTH_ALLOWED_AUDIENCES", "juke.audio")
    return accounts


@pytest.mark.asyncio
async def test_quickauth_accepts_hqa1_and_caps_session(client, custody_chain):
    account = Account.create()
    custody_chain[account.address.lower()] = FID
    issued = datetime.now(timezone.utc)
    token, _ = make_token(
        account, fid=FID, issued_at=issued, lifetime=timedelta(minutes=5)
    )

    with patch(
        "app.routers.auth._ensure_miniapp_user", new_callable=AsyncMock
    ) as ensure_user:
        first = await client.post("/v1/auth/miniapp-quickauth", json={"token": token})
        # Not single-use: a cached token may be exchanged again within its life.
        second = await client.post("/v1/auth/miniapp-quickauth", json={"token": token})

    assert first.status_code == 200, first.text
    assert second.status_code == 200
    body = first.json()
    assert body["fid"] == FID
    claims = jose_jwt.decode(
        body["token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
    )
    assert claims["fid"] == FID
    # Session never outlives the Protocol Auth token.
    assert claims["exp"] <= int((issued + timedelta(minutes=5)).timestamp())
    ensure_user.assert_awaited_with(ensure_user.await_args.args[0], FID)


@pytest.mark.asyncio
async def test_quickauth_rejects_unlinked_signer(client, custody_chain, monkeypatch):
    from app.services import signer_registry

    monkeypatch.setattr(
        signer_registry, "is_auth_address_active", AsyncMock(return_value=False)
    )
    token, _ = make_token(fid=FID)

    response = await client.post("/v1/auth/miniapp-quickauth", json={"token": token})

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_quickauth_rejects_signer_link_token(client, custody_chain):
    """L5-custody: a custody-signed register token is not a miniapp session."""
    account = Account.create()
    custody_chain[account.address.lower()] = FID
    link_nonce = PREPARED["protocol_auth"]["nonce"]
    token, _ = make_token(account, fid=FID, nonce=link_nonce)

    async def _get(key):
        return "1" if key == f"signer_prepare_nonce:{link_nonce}" else None

    redis = client._transport.app.state.redis
    redis.get.side_effect = _get
    with patch(
        "app.routers.auth._ensure_miniapp_user", new_callable=AsyncMock
    ) as ensure_user:
        response = await client.post(
            "/v1/auth/miniapp-quickauth", json={"token": token}
        )

    assert response.status_code == 401
    ensure_user.assert_not_awaited()


@pytest.mark.asyncio
async def test_protocol_login_rejects_signer_link_token(client, custody_chain):
    """L5-custody: the register token's prepare nonce is not a SIWF nonce."""
    account = Account.create()
    custody_chain[account.address.lower()] = FID
    link_nonce = PREPARED["protocol_auth"]["nonce"]
    token, _ = make_token(account, fid=FID, nonce=link_nonce)

    async def _delete(key):
        # Only /siwf/nonce mints into this namespace; the prepare nonce never is.
        return 1 if key == "siwf_nonce:minted-by-siwf" else 0

    redis = client._transport.app.state.redis
    redis.delete.side_effect = _delete
    with patch(
        "app.routers.auth.get_or_create_user", new_callable=AsyncMock
    ) as get_user:
        response = await client.post("/v1/auth/protocol", json={"token": token})

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid_token"
    redis.delete.assert_any_await(f"siwf_nonce:{link_nonce}")
    get_user.assert_not_awaited()


@pytest.mark.asyncio
async def test_quickauth_rejects_jwt(client, custody_chain):
    response = await client.post(
        "/v1/auth/miniapp-quickauth", json={"token": "eyJhbGciOiJFUzI1NiJ9.e30.sig"}
    )
    assert response.status_code == 401


DC_AUTH_REQUEST = {
    "method": "generateToken",
    "params": {"timestamp": 1_800_000_000_000, "expiresAt": 1_807_776_000_000},
}
DC_AUTH_SIGNATURE = "eip191:" + "A" * 88


@pytest.mark.asyncio
async def test_register_schedules_dc_token_enable_when_signed(client):
    accepted = {"prepare_id": PREPARE_ID, "status": "pending"}
    body = {
        **REGISTER_BODY,
        "dc_auth_request": DC_AUTH_REQUEST,
        "dc_auth_signature": DC_AUTH_SIGNATURE,
    }
    with (
        _service("register_signer", return_value=(accepted, True)),
        _service("relay_prepared_signer"),
        patch(
            "app.routers.auth.farcaster_token_service.enable_after_signer_register",
            new_callable=AsyncMock,
        ) as enable,
    ):
        response = await client.post("/v1/auth/signer/register", json=body)

    assert response.status_code == 202, response.text
    enable.assert_awaited_once()
    kwargs = enable.await_args.kwargs
    assert kwargs["prepare_id"] == uuid.UUID(PREPARE_ID)
    assert kwargs["auth_request"].to_upstream() == DC_AUTH_REQUEST
    assert kwargs["signature"] == DC_AUTH_SIGNATURE


@pytest.mark.asyncio
@pytest.mark.parametrize("relay_now", [True, False])
async def test_register_without_dc_fields_or_on_retry_skips_enable(client, relay_now):
    accepted = {"prepare_id": PREPARE_ID, "status": "pending"}
    body = REGISTER_BODY
    if not relay_now:
        body = {
            **REGISTER_BODY,
            "dc_auth_request": DC_AUTH_REQUEST,
            "dc_auth_signature": DC_AUTH_SIGNATURE,
        }
    with (
        _service("register_signer", return_value=(accepted, relay_now)),
        _service("relay_prepared_signer"),
        patch(
            "app.routers.auth.farcaster_token_service.enable_after_signer_register",
            new_callable=AsyncMock,
        ) as enable,
    ):
        response = await client.post("/v1/auth/signer/register", json=body)

    assert response.status_code == 202
    enable.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("present", ["dc_auth_request", "dc_auth_signature"])
async def test_register_requires_dc_fields_together(client, present):
    value = DC_AUTH_REQUEST if present == "dc_auth_request" else DC_AUTH_SIGNATURE
    body = {**REGISTER_BODY, present: value}
    response = await client.post("/v1/auth/signer/register", json=body)
    assert response.status_code == 422
