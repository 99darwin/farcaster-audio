"""Protocol Auth (``hqa1.``) token and miniapp SIWF message verification."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from eth_account import Account

from app.clients import key_gateway
from app.services import signer_registry
from app.services.siwf_service import (
    LINK_METHOD_AUTH_ADDRESS,
    LINK_METHOD_CUSTODY,
    ProtocolAuthError,
    verify_miniapp_siwf_message,
    verify_protocol_auth_token,
)
from tests.protocol_auth_helpers import (
    DOMAIN,
    encode_token,
    make_token,
    sign_message,
    siwe_message,
)

FID = 7777
DOMAINS = {DOMAIN}


@pytest.fixture
def chain(monkeypatch):
    """Custody lookups resolve to FID; no auth addresses unless a test says so."""
    state = {"custody": {}, "auth_address_active": False}

    async def _id_of(address):
        return state["custody"].get(address.lower(), 0)

    monkeypatch.setattr(key_gateway, "id_of", _id_of)
    monkeypatch.setattr(
        signer_registry,
        "is_auth_address_active",
        AsyncMock(side_effect=lambda fid, addr: state["auth_address_active"]),
    )
    return state


def _custody_token(chain, **kwargs):
    token, account = make_token(fid=kwargs.pop("fid", FID), **kwargs)
    chain["custody"][account.address.lower()] = FID
    return token, account


async def _verify(token, **kwargs):
    return await verify_protocol_auth_token(token, allowed_domains=DOMAINS, **kwargs)


async def _reason(token, **kwargs) -> str:
    with pytest.raises(ProtocolAuthError) as exc_info:
        await _verify(token, **kwargs)
    return exc_info.value.reason


@pytest.mark.asyncio
async def test_custody_token_verifies(chain):
    token, account = _custody_token(chain)

    claims = await _verify(token)

    assert claims.fid == FID
    assert claims.address == account.address
    assert claims.method == LINK_METHOD_CUSTODY
    assert claims.domain == DOMAIN


@pytest.mark.asyncio
async def test_auth_address_signer_is_accepted(chain):
    token, _ = make_token(fid=FID)  # not the custody address
    chain["auth_address_active"] = True

    claims = await _verify(token)

    assert claims.method == LINK_METHOD_AUTH_ADDRESS


@pytest.mark.asyncio
async def test_unlinked_signer_is_rejected(chain):
    token, _ = make_token(fid=FID)
    assert await _reason(token) == "signer_not_linked"


@pytest.mark.asyncio
async def test_custody_of_another_fid_is_rejected(chain):
    token, account = make_token(fid=FID)
    chain["custody"][account.address.lower()] = FID + 1
    assert await _reason(token) == "signer_not_linked"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"domain": "evil.example"}, "domain_mismatch"),
        ({"uri": "https://evil.example"}, "uri_mismatch"),
        ({"chain_id": 1}, "chain_id_mismatch"),
        ({"statement": "Sign in to Juke."}, "bad_statement"),
        (
            {"resources": ["farcaster://fid/7777", "farcaster://fid/8888"]},
            "bad_resources",
        ),
        ({"resources": ["farcaster://fids/7777"]}, "bad_resources"),
        ({"lifetime": timedelta(hours=2)}, "lifetime_too_long"),
        ({"lifetime": None}, "missing_timestamp"),
        (
            {
                "issued_at": datetime.now(timezone.utc) - timedelta(minutes=30),
                "lifetime": timedelta(minutes=10),
            },
            "expired",
        ),
        (
            {"issued_at": datetime.now(timezone.utc) + timedelta(minutes=30)},
            "issued_in_future",
        ),
    ],
)
async def test_message_field_checks(chain, kwargs, reason):
    token, _ = _custody_token(chain, **kwargs)
    assert await _reason(token) == reason


@pytest.mark.asyncio
async def test_non_canonical_message_is_rejected(chain):
    account = Account.create()
    chain["custody"][account.address.lower()] = FID
    # Extra whitespace the signer saw but re-serialization would drop.
    message = siwe_message(address=account.address, fid=FID) + "\n"
    token = encode_token(message, sign_message(account, message))
    assert await _reason(token) in {"non_canonical_message", "unparseable_message"}


@pytest.mark.asyncio
async def test_signature_from_other_key_is_rejected(chain):
    account = Account.create()
    chain["custody"][account.address.lower()] = FID
    message = siwe_message(address=account.address, fid=FID)
    token = encode_token(message, sign_message(Account.create(), message))
    assert await _reason(token) == "bad_signature"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("token", "reason"),
    [
        ("eyJhbGciOi.jwt.token", "not_protocol_token"),
        ("hqa1.onlyonepart", "malformed_token"),
        ("hqa1.e30.e30", "malformed_signature"),
    ],
)
async def test_malformed_tokens(chain, token, reason):
    assert await _reason(token) == reason


@pytest.mark.asyncio
async def test_chain_error_propagates(monkeypatch):
    token, _ = make_token(fid=FID)
    monkeypatch.setattr(
        key_gateway,
        "id_of",
        AsyncMock(side_effect=key_gateway.KeyGatewayError("rpc down")),
    )
    with pytest.raises(key_gateway.KeyGatewayError):
        await _verify(token)


# ---------------------------------------------------------------------------
# Miniapp sdk.actions.signIn messages
# ---------------------------------------------------------------------------


def _miniapp(chain, *, nonce="servernonce123", **kwargs):
    account = Account.create()
    chain["custody"][account.address.lower()] = FID
    message = siwe_message(
        address=account.address,
        fid=FID,
        nonce=nonce,
        statement="Farcaster Auth",
        **kwargs,
    )
    return message, "0x" + sign_message(account, message).hex(), account


@pytest.mark.asyncio
async def test_miniapp_message_verifies(chain):
    message, signature, account = _miniapp(chain)

    claims = await verify_miniapp_siwf_message(
        message,
        signature,
        expected_nonce="servernonce123",
        allowed_domains=DOMAINS,
    )

    assert claims.fid == FID
    assert claims.address == account.address
    assert claims.method == LINK_METHOD_CUSTODY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kwargs", "expected_nonce", "reason"),
    [
        ({}, "othernonce", "nonce_mismatch"),
        ({}, "", "nonce_mismatch"),
        ({"domain": "evil.example"}, "servernonce123", "domain_mismatch"),
        (
            {
                "issued_at": datetime.now(timezone.utc) - timedelta(minutes=20),
                "lifetime": None,
            },
            "servernonce123",
            "expired",
        ),
        (
            {"resources": ["farcaster://fids/7777"]},
            "servernonce123",
            "bad_resources",
        ),
    ],
)
async def test_miniapp_message_rejections(chain, kwargs, expected_nonce, reason):
    message, signature, _ = _miniapp(chain, **kwargs)
    with pytest.raises(ProtocolAuthError) as exc_info:
        await verify_miniapp_siwf_message(
            message,
            signature,
            expected_nonce=expected_nonce,
            allowed_domains=DOMAINS,
        )
    assert exc_info.value.reason == reason


def test_generated_nonce_parses_as_siwe() -> None:
    """Base64url nonces (``-``/``_``) fail the siwe grammar; ours must not."""
    from siwe import SiweMessage

    from app.services.siwf_service import _generate_nonce

    for _ in range(64):
        nonce = _generate_nonce()
        assert nonce.isalnum()
        message = (
            "juke.audio wants you to sign in with your Ethereum account:\n"
            "0x0000000000000000000000000000000000000001\n\nSign in to Juke\n\n"
            "URI: https://juke.audio\nVersion: 1\nChain ID: 10\n"
            f"Nonce: {nonce}\nIssued At: 2026-10-16T00:00:00Z"
        )
        assert SiweMessage.from_message(message).nonce == nonce
