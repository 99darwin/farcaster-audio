"""Tests for app.clients.key_gateway (encoding, EIP-712 Add, RPC and spend guards)."""

from __future__ import annotations

import logging
import os
import time

import aiohttp
import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
from multidict import CIMultiDict, CIMultiDictProxy
from web3.providers.async_base import AsyncBaseProvider
from yarl import URL

from app.clients import key_gateway as kg

REQUEST_FID = 9152
REQUEST_SIGNER = "0x1111111111111111111111111111111111111111"
SIGNATURE_65 = bytes(range(65))
DEADLINE = 1700000000

# Hand-computed abi.encode(SignedKeyRequestMetadata) for the inputs above.
# Words: [0] tuple offset 0x20, [1] requestFid, [2] requestSigner,
# [3] offset of `signature` within the tuple (0x80), [4] deadline,
# [5] signature length (65), [6..8] signature padded to 96 bytes.
# Cross-checked against SignedKeyRequestValidator.encodeMetadata on OP mainnet.
EXPECTED_METADATA_HEX = "".join(
    [
        f"{0x20:064x}",
        f"{REQUEST_FID:064x}",
        REQUEST_SIGNER[2:].rjust(64, "0"),
        f"{0x80:064x}",
        f"{DEADLINE:064x}",
        f"{65:064x}",
        SIGNATURE_65.hex().ljust(192, "0"),
    ]
)


def test_metadata_encoding_matches_hand_computed_abi():
    encoded = kg.encode_signed_key_request_metadata(
        REQUEST_FID, REQUEST_SIGNER, SIGNATURE_65, DEADLINE
    )
    assert encoded.hex() == EXPECTED_METADATA_HEX
    assert len(encoded) == 32 * 9


def test_metadata_accepts_hex_signature():
    as_bytes = kg.encode_signed_key_request_metadata(
        REQUEST_FID, REQUEST_SIGNER, SIGNATURE_65, DEADLINE
    )
    as_hex = kg.encode_signed_key_request_metadata(
        REQUEST_FID, REQUEST_SIGNER, "0x" + SIGNATURE_65.hex(), DEADLINE
    )
    assert as_bytes == as_hex


@pytest.mark.parametrize("fid,deadline", [(0, DEADLINE), (REQUEST_FID, 0)])
def test_metadata_rejects_invalid(fid, deadline):
    with pytest.raises(ValueError):
        kg.encode_signed_key_request_metadata(
            fid, REQUEST_SIGNER, SIGNATURE_65, deadline
        )


def test_addresses_are_checksummed():
    assert kg.ID_REGISTRY_ADDRESS == "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b"
    assert kg.KEY_REGISTRY_ADDRESS == "0x00000000Fc1237824fb747aBDE0FF18990E59b7e"
    assert kg.KEY_GATEWAY_ADDRESS == "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B"
    assert (
        kg.SIGNED_KEY_REQUEST_VALIDATOR_ADDRESS
        == "0x00000000FC700472606ED4fA22623Acf62c60553"
    )


def test_custom_error_selectors():
    assert kg.CUSTOM_ERRORS_BY_SELECTOR["0x8baa579f"] == "InvalidSignature"
    assert kg.CUSTOM_ERRORS_BY_SELECTOR["0x0819bdcd"] == "SignatureExpired"


def _typed_data(owner: str) -> dict:
    return kg.build_add_typed_data(
        owner,
        kg.KEY_TYPE_ED25519,
        "0x" + "ab" * 32,
        bytes(288),
        nonce=4,
        deadline=DEADLINE,
    )


def test_add_typed_data_shape():
    account = Account.create()
    typed = _typed_data(account.address.lower())
    assert typed["primaryType"] == "Add"
    assert typed["domain"] == {
        "name": "Farcaster KeyGateway",
        "version": "1",
        "chainId": 10,
        "verifyingContract": kg.KEY_GATEWAY_ADDRESS,
    }
    message = typed["message"]
    assert message["owner"] == account.address
    assert message["metadataType"] == 1
    assert message["key"] == "0x" + "ab" * 32
    assert message["nonce"] == 4


def test_add_sign_recover_roundtrip():
    account = Account.create()
    typed = _typed_data(account.address)
    signed = account.sign_message(encode_typed_data(full_message=typed))
    assert kg.recover_add_signer(typed, signed.signature) == account.address
    assert kg.recover_add_signer(typed, "0x" + signed.signature.hex()) == (
        account.address
    )


def test_add_recover_detects_tampering():
    account = Account.create()
    typed = _typed_data(account.address)
    signed = account.sign_message(encode_typed_data(full_message=typed))
    typed["message"]["nonce"] = 5
    assert kg.recover_add_signer(typed, signed.signature) != account.address


@pytest.mark.parametrize("key_type,nonce", [(3, 0), (1, -1)])
def test_add_typed_data_rejects_invalid(key_type, nonce):
    with pytest.raises(ValueError):
        kg.build_add_typed_data(
            REQUEST_SIGNER, key_type, b"\x00" * 32, b"", nonce, DEADLINE
        )


def test_relayer_key_errors_do_not_leak(monkeypatch):
    monkeypatch.setattr(kg.settings, "KEY_RELAYER_PRIVATE_KEY", "not-a-key-sekrit")
    with pytest.raises(kg.KeyGatewayConfigError) as info:
        kg._relayer_account()
    assert "sekrit" not in str(info.value)
    assert info.value.__cause__ is None


def test_missing_rpc_url(monkeypatch):
    monkeypatch.setattr(kg.settings, "OPTIMISM_RPC_URL", "")
    kg.set_web3(None)
    with pytest.raises(kg.KeyGatewayConfigError):
        kg.get_web3()


class _FakeEth:
    def __init__(self, chain_id: int) -> None:
        self._chain_id = chain_id

    @property
    async def chain_id(self) -> int:
        return self._chain_id


class _FakeWeb3:
    def __init__(self, chain_id: int) -> None:
        self.eth = _FakeEth(chain_id)


async def test_wrong_chain_rejected():
    with pytest.raises(kg.KeyGatewayConfigError):
        await kg.id_of(REQUEST_SIGNER, w3=_FakeWeb3(1))  # type: ignore[arg-type]


def test_revert_reason_decodes_selector():
    class _Revert(Exception):
        data = "0x8baa579f"

    assert kg._revert_reason(_Revert("execution reverted")) == "InvalidSignature"


@pytest.mark.skipif(
    not os.environ.get("OPTIMISM_RPC_URL"),
    reason="set OPTIMISM_RPC_URL to compare with on-chain encodeMetadata",
)
async def test_metadata_matches_onchain_encode_metadata():
    from web3 import AsyncWeb3

    w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(os.environ["OPTIMISM_RPC_URL"]))
    onchain = await kg.encode_metadata_onchain(
        REQUEST_FID, REQUEST_SIGNER, SIGNATURE_65, DEADLINE, w3=w3
    )
    assert onchain.hex() == EXPECTED_METADATA_HEX


def test_simulation_sender_without_relayer_is_zero(monkeypatch):
    monkeypatch.setattr(kg.settings, "KEY_RELAYER_PRIVATE_KEY", "")
    assert kg._simulation_sender() == kg.ZERO_ADDRESS


def test_simulation_sender_uses_relayer_when_configured(monkeypatch):
    relayer = Account.create()
    monkeypatch.setattr(kg.settings, "KEY_RELAYER_PRIVATE_KEY", relayer.key.hex())
    assert kg._simulation_sender() == relayer.address


def test_optimism_rpc_url_reads_wallet_alias(monkeypatch):
    from app.config import Settings

    monkeypatch.delenv("OPTIMISM_RPC_URL", raising=False)
    monkeypatch.setenv("FARCASTER_VERIFICATION_OP_RPC_URL", "https://op.example")
    assert Settings(_env_file=None).OPTIMISM_RPC_URL == "https://op.example"


def test_add_for_abi_has_no_outputs():
    # KeyGateway.addFor returns nothing; declaring an output makes eth_call
    # raise BadFunctionCallOutput on a successful simulation.
    add_for = next(e for e in kg.KEY_GATEWAY_ABI if e.get("name") == "addFor")
    assert add_for["outputs"] == []


# ---------------------------------------------------------------------------
# H1: RPC failures never leak the keyed RPC URL
# ---------------------------------------------------------------------------

SECRET_RPC_URL = "https://opt-mainnet.example/v2/SECRETKEY"


def _client_response_error() -> aiohttp.ClientResponseError:
    url = URL(SECRET_RPC_URL)
    request_info = aiohttp.RequestInfo(
        url=url, method="POST", headers=CIMultiDictProxy(CIMultiDict()), real_url=url
    )
    return aiohttp.ClientResponseError(
        request_info, (), status=401, message="Unauthorized"
    )


class _ScriptedProvider(AsyncBaseProvider):
    """Answers ``eth_chainId`` (optionally) and raises for everything else."""

    def __init__(self, error: BaseException, *, answer_chain_id: bool) -> None:
        super().__init__()
        self._error = error
        self._answer_chain_id = answer_chain_id

    async def make_request(self, method, params):  # type: ignore[override]
        if self._answer_chain_id and method == "eth_chainId":
            return {"jsonrpc": "2.0", "id": 1, "result": hex(kg.OPTIMISM_CHAIN_ID)}
        raise self._error

    async def is_connected(self, show_traceback: bool = False) -> bool:
        return True


def _leaky_web3(*, answer_chain_id: bool, error: BaseException | None = None):
    from web3 import AsyncWeb3

    provider = _ScriptedProvider(
        error or _client_response_error(), answer_chain_id=answer_chain_id
    )
    return AsyncWeb3(provider)


def _assert_sanitized(exc: BaseException) -> None:
    assert "SECRETKEY" not in str(exc)
    assert "SECRETKEY" not in repr(exc)
    assert exc.__cause__ is None
    assert exc.__context__ is None
    assert exc.__suppress_context__ is True


def test_client_response_error_str_contains_url():
    # Precondition for the tests below: aiohttp really does echo the URL.
    assert "SECRETKEY" in str(_client_response_error())


@pytest.mark.parametrize("answer_chain_id", [False, True])
async def test_id_of_does_not_leak_rpc_url(answer_chain_id):
    w3 = _leaky_web3(answer_chain_id=answer_chain_id)
    with pytest.raises(kg.KeyGatewayError) as info:
        await kg.id_of(REQUEST_SIGNER, w3=w3)
    _assert_sanitized(info.value)
    assert "ClientResponseError" in str(info.value)


async def test_nonce_lookup_does_not_leak_rpc_url():
    with pytest.raises(kg.KeyGatewayError) as info:
        await kg.key_gateway_nonce(REQUEST_SIGNER, w3=_leaky_web3(answer_chain_id=True))
    _assert_sanitized(info.value)


async def test_timeout_is_mapped_and_sanitized():
    w3 = _leaky_web3(answer_chain_id=True, error=TimeoutError(SECRET_RPC_URL))
    with pytest.raises(kg.KeyGatewayError) as info:
        await kg.id_of(REQUEST_SIGNER, w3=w3)
    _assert_sanitized(info.value)
    assert "TimeoutError" in str(info.value)


async def test_simulation_does_not_leak_rpc_url(monkeypatch):
    monkeypatch.setattr(kg.settings, "KEY_RELAYER_PRIVATE_KEY", "")
    with pytest.raises(kg.KeyGatewayError) as info:
        await kg.simulate_add_for(
            fid_owner=REQUEST_SIGNER,
            key_type=kg.KEY_TYPE_ED25519,
            key=bytes(32),
            metadata=b"",
            deadline=int(time.time()) + 60,
            signature=SIGNATURE_65,
            w3=_leaky_web3(answer_chain_id=True),
        )
    _assert_sanitized(info.value)


async def test_receipt_wait_does_not_leak_rpc_url():
    with pytest.raises(kg.KeyGatewayError) as info:
        await kg.wait_for_add_receipt(
            "0x" + "11" * 32, timeout_seconds=1, w3=_leaky_web3(answer_chain_id=True)
        )
    _assert_sanitized(info.value)


async def test_web3_exception_is_sanitized():
    from web3.exceptions import Web3RPCError

    w3 = _leaky_web3(answer_chain_id=True, error=Web3RPCError(SECRET_RPC_URL))
    with pytest.raises(kg.KeyGatewayError) as info:
        await kg.id_of(REQUEST_SIGNER, w3=w3)
    _assert_sanitized(info.value)


async def test_revert_keeps_reason_without_chaining():
    from web3.exceptions import ContractCustomError

    async def revert():
        raise ContractCustomError("0x8baa579f", data="0x8baa579f")

    with pytest.raises(kg.KeyGatewayError) as info:
        await kg._call_rpc("addFor simulation", revert(), decode_reverts=True)
    assert info.value.reason == "InvalidSignature"
    assert info.value.__cause__ is None and info.value.__context__ is None


def test_web3_provider_logger_is_not_debug():
    assert logging.getLogger("web3.providers").level == logging.WARNING
    child = logging.getLogger("web3.providers.AsyncHTTPProvider")
    assert not child.isEnabledFor(logging.INFO)


# ---------------------------------------------------------------------------
# M2: send_add_for invariants
# ---------------------------------------------------------------------------

APP_FID = 9152
LIVE_NONCE = 4
TX_HASH = b"\x12" * 32


def _now() -> int:
    return int(time.time())


def test_decode_metadata_roundtrip():
    encoded = kg.encode_signed_key_request_metadata(
        REQUEST_FID, REQUEST_SIGNER, SIGNATURE_65, DEADLINE
    )
    decoded = kg.decode_signed_key_request_metadata("0x" + encoded.hex())
    assert decoded == kg.SignedKeyRequestMetadata(
        request_fid=REQUEST_FID,
        request_signer=REQUEST_SIGNER,
        signature=SIGNATURE_65,
        deadline=DEADLINE,
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda raw: raw + b"\x00" * 32,  # trailing word
        lambda raw: raw[:-32],  # truncated
        lambda raw: b"",
        lambda raw: bytes(32) + raw[32:],  # bad tuple offset
    ],
)
def test_decode_metadata_rejects_malformed(mutate):
    encoded = kg.encode_signed_key_request_metadata(
        REQUEST_FID, REQUEST_SIGNER, SIGNATURE_65, DEADLINE
    )
    with pytest.raises(ValueError):
        kg.decode_signed_key_request_metadata(mutate(encoded))


@pytest.mark.parametrize(
    "key_type,key_len,ok",
    [
        (kg.KEY_TYPE_ED25519, 32, True),
        (kg.KEY_TYPE_AUTH_ADDRESS, 32, True),
        (kg.KEY_TYPE_ED25519, 20, False),
        (kg.KEY_TYPE_AUTH_ADDRESS, 20, False),
        (3, 32, False),
        (0, 32, False),
    ],
)
def test_validate_add_for_shape_key(key_type, key_len, ok):
    args = {"key_type": key_type, "key": bytes(key_len), "deadline": _now() + 60}
    if ok:
        kg.validate_add_for_shape(**args)
        return
    with pytest.raises(kg.KeyGatewayValidationError):
        kg.validate_add_for_shape(**args)


@pytest.mark.parametrize(
    "offset,reason",
    [
        (0, "SignatureExpired"),
        (-1, "SignatureExpired"),
        (kg.MAX_ADD_DEADLINE_SECONDS + 1, "DeadlineTooFar"),
    ],
)
def test_validate_add_for_shape_deadline(offset, reason):
    now = 1_800_000_000
    with pytest.raises(kg.KeyGatewayValidationError) as info:
        kg.validate_add_for_shape(
            key_type=kg.KEY_TYPE_ED25519,
            key=bytes(32),
            deadline=now + offset,
            now=now,
        )
    assert info.value.reason == reason


def test_validate_add_for_shape_deadline_at_bound_ok():
    now = 1_800_000_000
    kg.validate_add_for_shape(
        key_type=kg.KEY_TYPE_ED25519,
        key=bytes(32),
        deadline=now + kg.MAX_ADD_DEADLINE_SECONDS,
        now=now,
    )


async def test_simulate_validates_shape_before_rpc():
    with pytest.raises(kg.KeyGatewayValidationError):
        await kg.simulate_add_for(
            fid_owner=REQUEST_SIGNER,
            key_type=3,
            key=bytes(32),
            metadata=b"",
            deadline=_now() + 60,
            signature=SIGNATURE_65,
            w3=_FakeWeb3(kg.OPTIMISM_CHAIN_ID),  # type: ignore[arg-type]
        )


class _SendHarness:
    """Real signatures and metadata; RPC, simulation and broadcast faked."""

    def __init__(self, monkeypatch) -> None:
        self.app = Account.create()
        self.custody = Account.create()
        self.relayer = Account.create()
        self.simulated: list[dict] = []
        self.sent: list[object] = []
        self.chain_nonce = LIVE_NONCE
        self.simulate_error: Exception | None = None
        monkeypatch.setattr(kg.settings, "FARCASTER_APP_FID", APP_FID)
        monkeypatch.setattr(
            kg.settings, "KEY_RELAYER_PRIVATE_KEY", self.relayer.key.hex()
        )
        monkeypatch.setattr(kg, "_get_app_account", lambda: self.app)

        async def verified(_w3):
            return _FakeWeb3(kg.OPTIMISM_CHAIN_ID)

        async def nonce(owner, *, w3=None):
            return self.chain_nonce

        async def simulate(**kwargs):
            self.simulated.append(kwargs)
            if self.simulate_error is not None:
                raise self.simulate_error

        async def sign_and_send(client, relayer, call):
            self.sent.append(call)
            return TX_HASH

        monkeypatch.setattr(kg, "_verified_web3", verified)
        monkeypatch.setattr(kg, "key_gateway_nonce", nonce)
        monkeypatch.setattr(kg, "simulate_add_for", simulate)
        monkeypatch.setattr(kg, "_add_for_call", lambda client, **kw: kw)
        monkeypatch.setattr(kg, "_sign_and_send", sign_and_send)

    def metadata(self, *, fid=APP_FID, signer=None, deadline=None) -> bytes:
        return kg.encode_signed_key_request_metadata(
            fid,
            signer or self.app.address,
            SIGNATURE_65,
            deadline if deadline is not None else _now() + 3600,
        )

    def args(
        self,
        *,
        metadata: bytes | None = None,
        deadline: int | None = None,
        signer=None,
        nonce: int = LIVE_NONCE,
        key_type: int = kg.KEY_TYPE_ED25519,
        key: bytes = b"\xab" * 32,
    ) -> dict:
        metadata = metadata if metadata is not None else self.metadata()
        deadline = deadline if deadline is not None else _now() + 600
        typed = kg.build_add_typed_data(
            self.custody.address, key_type, key, metadata, nonce, deadline
        )
        signed = (signer or self.custody).sign_message(
            encode_typed_data(full_message=typed)
        )
        return {
            "fid_owner": self.custody.address,
            "key_type": key_type,
            "key": key,
            "metadata": metadata,
            "deadline": deadline,
            "signature": signed.signature,
        }


async def test_send_add_for_happy_path(monkeypatch):
    harness = _SendHarness(monkeypatch)
    tx_hash = await kg.send_add_for(**harness.args())
    assert tx_hash == "0x" + TX_HASH.hex()
    assert len(harness.simulated) == 1
    assert len(harness.sent) == 1


async def test_send_add_for_auth_address_key(monkeypatch):
    harness = _SendHarness(monkeypatch)
    key = kg.auth_address_key("0x" + "01" * 20)
    args = harness.args(key_type=kg.KEY_TYPE_AUTH_ADDRESS, key=key)
    await kg.send_add_for(**args)
    assert len(harness.sent) == 1


def test_validate_add_for_shape_rejects_unpadded_auth_address_key():
    key = b"\x01" * 32
    with pytest.raises(kg.KeyGatewayValidationError):
        kg.validate_add_for_shape(
            key_type=kg.KEY_TYPE_AUTH_ADDRESS, key=key, deadline=_now() + 60
        )


def test_auth_address_key_is_abi_encoded_address():
    address = "0x610e1e225978964b6c642901db2178374888dc60"
    key = kg.auth_address_key(address)
    assert len(key) == 32
    assert key.hex() == "00" * 12 + address[2:]


def _metadata_cases():
    return {
        "wrong_fid": lambda h: h.metadata(fid=APP_FID + 1),
        "wrong_signer": lambda h: h.metadata(signer=Account.create().address),
        "expired": lambda h: h.metadata(deadline=_now() - 1),
        "too_far": lambda h: h.metadata(
            deadline=_now() + kg.MAX_KEY_REQUEST_DEADLINE_SECONDS + 600
        ),
        "malformed": lambda h: h.metadata() + b"\x00" * 32,
    }


@pytest.mark.parametrize("case", sorted(_metadata_cases()))
async def test_send_add_for_rejects_bad_metadata(monkeypatch, case):
    harness = _SendHarness(monkeypatch)
    args = harness.args(metadata=_metadata_cases()[case](harness))
    with pytest.raises(kg.KeyGatewayValidationError):
        await kg.send_add_for(**args)
    assert harness.simulated == [] and harness.sent == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"key_type": 3},
        {"key": b"\xab" * 20},
        {"deadline": 1},
        {"deadline": 10**12},
    ],
)
async def test_send_add_for_rejects_bad_shape(monkeypatch, overrides):
    harness = _SendHarness(monkeypatch)
    args = harness.args() | overrides
    with pytest.raises(kg.KeyGatewayValidationError):
        await kg.send_add_for(**args)
    assert harness.sent == []


async def test_send_add_for_rejects_signature_from_other_account(monkeypatch):
    harness = _SendHarness(monkeypatch)
    args = harness.args(signer=Account.create())
    with pytest.raises(kg.KeyGatewayValidationError) as info:
        await kg.send_add_for(**args)
    assert info.value.reason == "InvalidSignature"
    assert harness.simulated == [] and harness.sent == []


async def test_send_add_for_rejects_signature_at_stale_nonce(monkeypatch):
    harness = _SendHarness(monkeypatch)
    args = harness.args(nonce=LIVE_NONCE - 1)
    with pytest.raises(kg.KeyGatewayValidationError):
        await kg.send_add_for(**args)
    assert harness.sent == []


async def test_send_add_for_rejects_malformed_signature(monkeypatch):
    harness = _SendHarness(monkeypatch)
    args = harness.args() | {"signature": b"\x01" * 10}
    with pytest.raises(kg.KeyGatewayValidationError):
        await kg.send_add_for(**args)
    assert harness.sent == []


async def test_send_add_for_simulates_before_sending(monkeypatch):
    harness = _SendHarness(monkeypatch)
    harness.simulate_error = kg.KeyGatewayError("would revert", reason="InvalidState")
    with pytest.raises(kg.KeyGatewayError) as info:
        await kg.send_add_for(**harness.args())
    assert info.value.reason == "InvalidState"
    assert harness.sent == []


async def test_send_add_for_requires_app_fid(monkeypatch):
    harness = _SendHarness(monkeypatch)
    args = harness.args()
    monkeypatch.setattr(kg.settings, "FARCASTER_APP_FID", 0)
    with pytest.raises(kg.KeyGatewayConfigError):
        await kg.send_add_for(**args)


# ---------------------------------------------------------------------------
# M1: relayer spend caps and balance guard
# ---------------------------------------------------------------------------

SAFE_BASE_FEE_WEI = 1_000_000  # 0.001 gwei
SAFE_PRIORITY_FEE_WEI = 1_000
SAFE_GAS_ESTIMATE = 200_000
RICH_BALANCE_WEI = 10**18


class _SpendEth:
    def __init__(self, *, base_fee: int, priority_fee: int, balance: int) -> None:
        self._base_fee = base_fee
        self._priority_fee = priority_fee
        self._balance = balance
        self.sent_raw: list[bytes] = []

    async def get_transaction_count(self, address, block):
        return 7

    async def get_block(self, block):
        return {"baseFeePerGas": self._base_fee}

    @property
    async def max_priority_fee(self) -> int:
        return self._priority_fee

    async def get_balance(self, address):
        return self._balance

    async def send_raw_transaction(self, raw):
        self.sent_raw.append(raw)
        return TX_HASH


class _SpendWeb3:
    def __init__(self, **kwargs) -> None:
        self.eth = _SpendEth(**kwargs)


class _FakeCall:
    def __init__(self, gas_estimate: int) -> None:
        self._gas_estimate = gas_estimate
        self.built: dict | None = None

    async def estimate_gas(self, params):
        return self._gas_estimate

    async def build_transaction(self, params):
        self.built = dict(params)
        return {
            **params,
            "to": kg.KEY_GATEWAY_ADDRESS,
            "data": "0x",
            "value": 0,
        }


def _spend_setup(
    *,
    base_fee: int = SAFE_BASE_FEE_WEI,
    priority_fee: int = SAFE_PRIORITY_FEE_WEI,
    balance: int = RICH_BALANCE_WEI,
    gas_estimate: int = SAFE_GAS_ESTIMATE,
):
    w3 = _SpendWeb3(base_fee=base_fee, priority_fee=priority_fee, balance=balance)
    return w3, _FakeCall(gas_estimate), Account.create()


async def test_sign_and_send_within_caps(monkeypatch):
    monkeypatch.setattr(kg.settings, "KEY_RELAYER_MIN_BALANCE_WEI", 0)
    w3, call, relayer = _spend_setup()
    assert await kg._sign_and_send(w3, relayer, call) == TX_HASH
    assert len(w3.eth.sent_raw) == 1
    assert call.built["gas"] == SAFE_GAS_ESTIMATE * 12 // 10
    assert call.built["maxFeePerGas"] == SAFE_BASE_FEE_WEI * 2 + SAFE_PRIORITY_FEE_WEI


@pytest.mark.parametrize(
    "overrides",
    [
        {"gas_estimate": kg.MAX_ADD_FOR_GAS},  # buffered limit exceeds cap
        {"priority_fee": kg.MAX_PRIORITY_FEE_PER_GAS_WEI + 1},
        {"base_fee": kg.MAX_FEE_PER_GAS_WEI // 2 + 1},
        {"balance": SAFE_GAS_ESTIMATE},  # cannot cover gas * maxFee
    ],
)
async def test_sign_and_send_refuses_over_cap(monkeypatch, overrides):
    monkeypatch.setattr(kg.settings, "KEY_RELAYER_MIN_BALANCE_WEI", 0)
    w3, call, relayer = _spend_setup(**overrides)
    with pytest.raises(kg.KeyGatewaySpendCapError):
        await kg._sign_and_send(w3, relayer, call)
    assert w3.eth.sent_raw == []
    assert call.built is None  # refused, never clamped


async def test_low_balance_warns_without_amounts(monkeypatch, caplog):
    balance = 123_456_789_012_345
    monkeypatch.setattr(kg.settings, "KEY_RELAYER_MIN_BALANCE_WEI", balance + 1)
    w3, call, relayer = _spend_setup(balance=balance)
    with caplog.at_level(logging.WARNING, logger=kg.logger.name):
        await kg._sign_and_send(w3, relayer, call)
    assert len(w3.eth.sent_raw) == 1
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("KEY_RELAYER_MIN_BALANCE_WEI" in message for message in warnings)
    for message in warnings:
        assert str(balance) not in message
        assert relayer.address.lower() not in message.lower()


def test_spend_caps_are_sane():
    assert kg.MAX_PRIORITY_FEE_PER_GAS_WEI < kg.MAX_FEE_PER_GAS_WEI
    assert kg.MAX_FEE_PER_GAS_WEI == 10**9
    assert kg.MAX_ADD_FOR_GAS == 400_000


def test_app_request_signer_never_echoes_mnemonic(monkeypatch):
    words = "abandon " * 11 + "zoo"
    monkeypatch.setattr(kg.settings, "FARCASTER_APP_MNEMONIC", words)
    with pytest.raises(kg.KeyGatewayConfigError) as info:
        kg._app_request_signer()
    assert "abandon" not in str(info.value)
    assert info.value.__cause__ is None and info.value.__suppress_context__


# ---------------------------------------------------------------------------
# Production config: the RPC is a trust anchor and must be https
# ---------------------------------------------------------------------------


def _settings(monkeypatch, *, environment: str, rpc_url: str | None):
    from app.config import Settings

    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("HYPERSNAP_HTTP_URL", "https://node.test")
    monkeypatch.delenv("FARCASTER_VERIFICATION_OP_RPC_URL", raising=False)
    if rpc_url is None:
        monkeypatch.delenv("OPTIMISM_RPC_URL", raising=False)
    else:
        monkeypatch.setenv("OPTIMISM_RPC_URL", rpc_url)
    return Settings(_env_file=None)


@pytest.mark.parametrize("url", ["http://rpc.test/key", "rpc.test", "https://"])
def test_settings_reject_non_https_rpc_url_in_production(monkeypatch, url):
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="OPTIMISM_RPC_URL") as info:
        _settings(monkeypatch, environment="production", rpc_url=url)
    # The URL may embed a provider key; it must never be echoed.
    assert "rpc.test" not in str(info.value)


def test_settings_accept_https_or_unset_rpc_url_in_production(monkeypatch):
    rpc_url = "https://rpc.test/key"
    configured = _settings(monkeypatch, environment="production", rpc_url=rpc_url)
    assert configured.OPTIMISM_RPC_URL == rpc_url
    unset = _settings(monkeypatch, environment="production", rpc_url=None)
    assert unset.OPTIMISM_RPC_URL == ""


def test_settings_allow_http_rpc_url_outside_production(monkeypatch):
    rpc_url = "http://localhost:8545"
    configured = _settings(monkeypatch, environment="development", rpc_url=rpc_url)
    assert configured.OPTIMISM_RPC_URL == rpc_url
