"""Optimism client for Farcaster signer registration via ``KeyGateway.addFor``.

Juke relays ``addFor`` (and pays gas) so a user's Ed25519 app signer or
auth address is added to the standard KeyRegistry, which Hypersnap reads.
``addFor`` carries two signatures, both produced off this server:

* ``metadata`` — ABI-encoded ``SignedKeyRequestMetadata`` whose signature
  comes from the Juke app FID's custody key
  (``key_request_signing.sign_key_request``).
* ``sig`` — the user's custody signature over the EIP-712 ``Add`` message
  (:func:`build_add_typed_data`).

The relayer key (``KEY_RELAYER_PRIVATE_KEY``) only pays gas. It is never
logged and never placed in exception messages. ``OPTIMISM_RPC_URL`` may embed
a provider API key, so RPC failures are re-raised with only the exception
type name and with the original exception chain suppressed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass
from typing import Any

import aiohttp
from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode
from eth_abi.exceptions import DecodingError
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_keys.exceptions import BadSignature
from eth_utils import ValidationError as EthValidationError
from eth_utils import keccak, to_checksum_address
from web3 import AsyncWeb3
from web3.exceptions import ContractCustomError, ContractLogicError, Web3Exception

from app.config import settings
from app.services.key_request_signing import _get_app_account

logger = logging.getLogger(__name__)
# web3's HTTP provider logs the full endpoint URI (which may embed the RPC
# provider's API key) at DEBUG/INFO. Keep it quiet regardless of LOG_LEVEL.
logging.getLogger("web3.providers").setLevel(logging.WARNING)

OPTIMISM_CHAIN_ID = 10
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
ID_REGISTRY_ADDRESS = to_checksum_address("0x00000000fc6c5f01fc30151999387bb99a9f489b")
KEY_REGISTRY_ADDRESS = to_checksum_address("0x00000000fc1237824fb747abde0ff18990e59b7e")
KEY_GATEWAY_ADDRESS = to_checksum_address("0x00000000fc56947c7e7183f8ca4b62398caadf0b")
SIGNED_KEY_REQUEST_VALIDATOR_ADDRESS = to_checksum_address(
    "0x00000000fc700472606ed4fa22623acf62c60553"
)

KEY_TYPE_ED25519 = 1
KEY_TYPE_AUTH_ADDRESS = 2
ED25519_KEY_BYTES = 32
# KeyRegistry stores keyType 2 keys as the address ABI-encoded to 32 bytes
# (12 zero bytes + 20-byte address); a raw 20-byte key is never "added".
AUTH_ADDRESS_KEY_BYTES = 32
AUTH_ADDRESS_KEY_PADDING = b"\x00" * 12
KEY_BYTES_BY_TYPE: dict[int, int] = {
    KEY_TYPE_ED25519: ED25519_KEY_BYTES,
    KEY_TYPE_AUTH_ADDRESS: AUTH_ADDRESS_KEY_BYTES,
}
METADATA_TYPE_SIGNED_KEY_REQUEST = 1
SIGNED_KEY_REQUEST_METADATA_ABI = "(uint256,address,bytes,uint256)"
GAS_LIMIT_BUFFER_NUMERATOR = 12
GAS_LIMIT_BUFFER_DENOMINATOR = 10
BASE_FEE_MULTIPLIER = 2
DEFAULT_RECEIPT_TIMEOUT_SECONDS = 120.0
TX_STATUS_SUCCESS = 1

# Upper bound on the ``Add`` signature deadline relative to now. Matches the
# TTL the spike (and the device flow) signs with.
MAX_ADD_DEADLINE_SECONDS = 60 * 60
# Upper bound on the SignedKeyRequest deadline relative to now. Matches
# ``key_request_signing.KEY_REQUEST_DEADLINE_SECONDS`` (24h).
MAX_KEY_REQUEST_DEADLINE_SECONDS = 24 * 60 * 60

# Relayer spend caps. ``send_add_for`` refuses (never clamps) when a computed
# value exceeds its cap, so a fee spike or a pathological call cannot drain
# the relayer. OP mainnet base fees are typically well under 0.01 gwei.
WEI_PER_GWEI = 10**9
MAX_FEE_PER_GAS_WEI = 1 * WEI_PER_GWEI
MAX_PRIORITY_FEE_PER_GAS_WEI = WEI_PER_GWEI // 10
# Cap on the buffered gas limit; an Ed25519 addFor uses roughly 200-250k.
MAX_ADD_FOR_GAS = 400_000

# What ``recover_add_signer`` raises for a malformed (wrong length, bad
# ``v``/``r``/``s``, non-hex) signature.
MALFORMED_SIGNATURE_ERRORS: tuple[type[Exception], ...] = (
    ValueError,
    BadSignature,
    EthValidationError,
)
# RPC transport failures that are not ``Web3Exception``s. Their ``str()``
# (e.g. ``aiohttp.ClientResponseError``) includes the keyed endpoint URL.
RPC_TRANSPORT_ERRORS: tuple[type[BaseException], ...] = (
    aiohttp.ClientError,
    asyncio.TimeoutError,
)

KEY_GATEWAY_EIP712_DOMAIN: dict[str, Any] = {
    "name": "Farcaster KeyGateway",
    "version": "1",
    "chainId": OPTIMISM_CHAIN_ID,
    "verifyingContract": KEY_GATEWAY_ADDRESS,
}
ADD_TYPES: dict[str, list[dict[str, str]]] = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "Add": [
        {"name": "owner", "type": "address"},
        {"name": "keyType", "type": "uint32"},
        {"name": "key", "type": "bytes"},
        {"name": "metadataType", "type": "uint8"},
        {"name": "metadata", "type": "bytes"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
    ],
}

ID_REGISTRY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "idOf",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "fid", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "custodyOf",
        "stateMutability": "view",
        "inputs": [{"name": "fid", "type": "uint256"}],
        "outputs": [{"name": "custody", "type": "address"}],
    },
]
KEY_REGISTRY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "keyDataOf",
        "stateMutability": "view",
        "inputs": [
            {"name": "fid", "type": "uint256"},
            {"name": "key", "type": "bytes"},
        ],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "state", "type": "uint8"},
                    {"name": "keyType", "type": "uint32"},
                ],
            }
        ],
    },
]
# KeyRegistry.KeyState
KEY_STATE_NULL = 0
KEY_STATE_ADDED = 1
KEY_STATE_REMOVED = 2
KEY_GATEWAY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "nonces",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "addFor",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "fidOwner", "type": "address"},
            {"name": "keyType", "type": "uint32"},
            {"name": "key", "type": "bytes"},
            {"name": "metadataType", "type": "uint8"},
            {"name": "metadata", "type": "bytes"},
            {"name": "deadline", "type": "uint256"},
            {"name": "sig", "type": "bytes"},
        ],
        "outputs": [],
    },
]
SIGNED_KEY_REQUEST_VALIDATOR_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "encodeMetadata",
        "stateMutability": "pure",
        "inputs": [
            {
                "name": "metadata",
                "type": "tuple",
                "components": [
                    {"name": "requestFid", "type": "uint256"},
                    {"name": "requestSigner", "type": "address"},
                    {"name": "signature", "type": "bytes"},
                    {"name": "deadline", "type": "uint256"},
                ],
            }
        ],
        "outputs": [{"name": "", "type": "bytes"}],
    },
]

# Custom errors KeyGateway / KeyRegistry / validator can revert with, keyed
# by 4-byte selector so simulation failures produce actionable reasons.
_CUSTOM_ERROR_SIGNATURES = (
    "InvalidSignature()",
    "SignatureExpired()",
    "InvalidMetadata()",
    "ExceedsMaximum()",
    "InvalidState()",
    "Unauthorized()",
    "ValidatorNotFound(uint32,uint8)",
    "InvalidAccountNonce(address,uint256)",
    "EnforcedPause()",
)
CUSTOM_ERRORS_BY_SELECTOR: dict[str, str] = {
    "0x" + keccak(text=signature)[:4].hex(): signature.split("(")[0]
    for signature in _CUSTOM_ERROR_SIGNATURES
}


class KeyGatewayError(Exception):
    """An ``addFor`` simulation/submission or registry read failed.

    ``reason`` is a decoded custom-error name (e.g. ``InvalidSignature``)
    or the node's revert message, when available.
    """

    def __init__(self, message: str, *, reason: str | None = None) -> None:
        super().__init__(message)
        self.reason = reason


class KeyGatewayConfigError(KeyGatewayError):
    """RPC URL or relayer key missing/invalid, or the RPC is not Optimism."""


class KeyGatewayValidationError(KeyGatewayError):
    """``addFor`` arguments failed a server-side invariant; nothing was sent."""


class KeyGatewaySpendCapError(KeyGatewayError):
    """A fee, gas or balance guard refused to send; nothing was sent."""


@dataclass(frozen=True)
class SignedKeyRequestMetadata:
    """Decoded ``SignedKeyRequestMetadata`` (see the validator contract)."""

    request_fid: int
    request_signer: str
    signature: bytes
    deadline: int


# ---------------------------------------------------------------------------
# Pure helpers (no RPC)
# ---------------------------------------------------------------------------


def encode_signed_key_request_metadata(
    request_fid: int, request_signer: str, signature: bytes | str, deadline: int
) -> bytes:
    """ABI-encode ``SignedKeyRequestMetadata`` exactly like the validator.

    ``abi.encode(SignedKeyRequestMetadata)`` of a struct with a dynamic
    ``bytes`` member starts with a 0x20 offset word. Omitting it (encoding
    the bare tuple fields) makes the on-chain decoder read ``requestFid``
    as the offset and revert with ``InvalidMetadata``.
    """
    if request_fid <= 0:
        raise ValueError("request_fid must be positive")
    if deadline <= 0:
        raise ValueError("deadline must be positive")
    signature_bytes = _to_bytes(signature)
    return abi_encode(
        [SIGNED_KEY_REQUEST_METADATA_ABI],
        [(request_fid, to_checksum_address(request_signer), signature_bytes, deadline)],
    )


def decode_signed_key_request_metadata(
    metadata: bytes | str,
) -> SignedKeyRequestMetadata:
    """Inverse of :func:`encode_signed_key_request_metadata`.

    Strict: the input must be the canonical encoding (re-encoding the decoded
    fields reproduces it byte-for-byte), so trailing or padded garbage is
    rejected. Raises ``ValueError`` on any malformed input.
    """
    raw = _to_bytes(metadata)
    try:
        ((request_fid, request_signer, signature, deadline),) = abi_decode(
            [SIGNED_KEY_REQUEST_METADATA_ABI], raw
        )
    except DecodingError:
        raise ValueError(
            "metadata is not ABI-encoded SignedKeyRequestMetadata"
        ) from None
    decoded = SignedKeyRequestMetadata(
        request_fid=int(request_fid),
        request_signer=to_checksum_address(request_signer),
        signature=bytes(signature),
        deadline=int(deadline),
    )
    canonical = encode_signed_key_request_metadata(
        decoded.request_fid,
        decoded.request_signer,
        decoded.signature,
        decoded.deadline,
    )
    if canonical != raw:
        raise ValueError("metadata is not canonically encoded")
    return decoded


def validate_add_for_shape(
    *, key_type: int, key: bytes | str, deadline: int, now: int | None = None
) -> None:
    """Check ``addFor`` arguments that need no RPC or signature work.

    ``key_type`` must be ed25519 (32-byte key) or auth address (32-byte
    ABI-encoded address: 12 zero bytes + 20 address bytes) and
    ``now < deadline <= now + MAX_ADD_DEADLINE_SECONDS``.
    """
    expected_key_bytes = KEY_BYTES_BY_TYPE.get(key_type)
    if expected_key_bytes is None:
        raise KeyGatewayValidationError(
            f"unsupported key_type {key_type}", reason="InvalidKeyType"
        )
    try:
        key_bytes = _to_bytes(key)
    except ValueError:
        raise KeyGatewayValidationError(
            "key is not valid hex", reason="InvalidKey"
        ) from None
    if len(key_bytes) != expected_key_bytes:
        raise KeyGatewayValidationError(
            f"key for key_type {key_type} must be {expected_key_bytes} bytes",
            reason="InvalidKey",
        )
    if key_type == KEY_TYPE_AUTH_ADDRESS and not key_bytes.startswith(
        AUTH_ADDRESS_KEY_PADDING
    ):
        raise KeyGatewayValidationError(
            "auth address key must be 12 zero bytes + the address",
            reason="InvalidKey",
        )
    _require_deadline_in_window(
        deadline, max_seconds=MAX_ADD_DEADLINE_SECONDS, label="Add", now=now
    )


def _require_deadline_in_window(
    deadline: int, *, max_seconds: int, label: str, now: int | None = None
) -> None:
    current = int(time.time()) if now is None else now
    if deadline <= current:
        raise KeyGatewayValidationError(
            f"{label} deadline has passed", reason="SignatureExpired"
        )
    if deadline > current + max_seconds:
        raise KeyGatewayValidationError(
            f"{label} deadline is more than {max_seconds}s in the future",
            reason="DeadlineTooFar",
        )


def build_add_typed_data(
    owner: str,
    key_type: int,
    key: bytes | str,
    metadata: bytes | str,
    nonce: int,
    deadline: int,
) -> dict[str, Any]:
    """Full EIP-712 payload the FID custody key signs to authorize ``addFor``.

    Bytes fields are 0x-hex strings so the payload is JSON-serializable and
    can be handed to the device (viem ``signTypedData``) as-is.
    """
    if key_type not in KEY_BYTES_BY_TYPE:
        raise ValueError("key_type must be 1 (ed25519) or 2 (auth address)")
    if nonce < 0:
        raise ValueError("nonce must be non-negative")
    return {
        "types": ADD_TYPES,
        "primaryType": "Add",
        "domain": dict(KEY_GATEWAY_EIP712_DOMAIN),
        "message": {
            "owner": to_checksum_address(owner),
            "keyType": key_type,
            "key": "0x" + _to_bytes(key).hex(),
            "metadataType": METADATA_TYPE_SIGNED_KEY_REQUEST,
            "metadata": "0x" + _to_bytes(metadata).hex(),
            "nonce": nonce,
            "deadline": deadline,
        },
    }


def recover_add_signer(typed_data: Mapping[str, Any], signature: bytes | str) -> str:
    """Return the checksummed address that signed ``typed_data``."""
    signable = encode_typed_data(full_message=dict(typed_data))
    return to_checksum_address(
        Account.recover_message(signable, signature=_to_bytes(signature))
    )


def _to_bytes(value: bytes | str) -> bytes:
    if isinstance(value, bytes):
        return value
    return bytes.fromhex(value.removeprefix("0x"))


async def _call_rpc[T](
    operation: str, request: Awaitable[T], *, decode_reverts: bool = False
) -> T:
    """Await ``request``, mapping every RPC failure to :class:`KeyGatewayError`.

    The message carries only ``operation`` and the exception type name, and
    the original exception is dropped entirely (no ``__cause__``, no
    ``__context__``): aiohttp and web3 errors can embed the keyed RPC URL.
    With ``decode_reverts``, contract reverts keep their decoded reason.
    """
    try:
        return await request
    except (ContractCustomError, ContractLogicError) as exc:
        if decode_reverts:
            reason = _revert_reason(exc)
            failure = KeyGatewayError(f"{operation} reverted: {reason}", reason=reason)
        else:
            failure = KeyGatewayError(f"{operation} failed: {type(exc).__name__}")
    except (Web3Exception, *RPC_TRANSPORT_ERRORS) as exc:
        failure = KeyGatewayError(f"{operation} failed: {type(exc).__name__}")
    # Raised outside the ``except`` blocks so no exception context is attached.
    raise failure from None


# ---------------------------------------------------------------------------
# RPC
# ---------------------------------------------------------------------------

_web3: AsyncWeb3 | None = None
_chain_verified = False
# Serializes relayer nonce allocation within this process.
_relayer_lock = asyncio.Lock()


def get_web3() -> AsyncWeb3:
    """Return the lazily-created Optimism client."""
    global _web3
    if _web3 is None:
        if not settings.OPTIMISM_RPC_URL:
            raise KeyGatewayConfigError("OPTIMISM_RPC_URL is not configured")
        _web3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(settings.OPTIMISM_RPC_URL))
    return _web3


def set_web3(w3: AsyncWeb3 | None) -> None:
    """Replace the shared client (tests)."""
    global _web3, _chain_verified
    _web3 = w3
    _chain_verified = False


async def _verified_web3(w3: AsyncWeb3 | None) -> AsyncWeb3:
    """Fail fast unless the RPC is Optimism mainnet (chain id 10)."""
    global _chain_verified
    client = w3 or get_web3()
    if w3 is None and _chain_verified:
        return client
    chain_id = await _call_rpc("chain id lookup", client.eth.chain_id)
    if chain_id != OPTIMISM_CHAIN_ID:
        raise KeyGatewayConfigError(
            f"RPC chain id {chain_id} is not Optimism ({OPTIMISM_CHAIN_ID})"
        )
    if w3 is None:
        _chain_verified = True
    return client


async def id_of(address: str, *, w3: AsyncWeb3 | None = None) -> int:
    """FID owned (as custody) by ``address``; 0 when none."""
    client = await _verified_web3(w3)
    registry = client.eth.contract(address=ID_REGISTRY_ADDRESS, abi=ID_REGISTRY_ABI)
    request = registry.functions.idOf(to_checksum_address(address)).call()
    return int(await _call_rpc("idOf", request))


async def custody_of(fid: int, *, w3: AsyncWeb3 | None = None) -> str | None:
    """Checksummed custody address of ``fid``; ``None`` when unregistered."""
    client = await _verified_web3(w3)
    registry = client.eth.contract(address=ID_REGISTRY_ADDRESS, abi=ID_REGISTRY_ABI)
    custody = await _call_rpc("custodyOf", registry.functions.custodyOf(fid).call())
    if int(custody, 16) == 0:
        return None
    return to_checksum_address(custody)


def auth_address_key(address: str) -> bytes:
    """The 32-byte KeyRegistry key for auth address ``address``."""
    return AUTH_ADDRESS_KEY_PADDING + bytes.fromhex(to_checksum_address(address)[2:])


async def key_data_of(
    fid: int, key: bytes | str, *, w3: AsyncWeb3 | None = None
) -> tuple[int, int]:
    """``KeyRegistry.keyDataOf(fid, key)`` as ``(state, key_type)``."""
    client = await _verified_web3(w3)
    registry = client.eth.contract(address=KEY_REGISTRY_ADDRESS, abi=KEY_REGISTRY_ABI)
    request = registry.functions.keyDataOf(fid, _to_bytes(key)).call()
    state, key_type = await _call_rpc("keyDataOf", request)
    return int(state), int(key_type)


async def key_gateway_nonce(owner: str, *, w3: AsyncWeb3 | None = None) -> int:
    """Current ``KeyGateway.nonces(owner)`` for the ``Add`` signature."""
    client = await _verified_web3(w3)
    gateway = client.eth.contract(address=KEY_GATEWAY_ADDRESS, abi=KEY_GATEWAY_ABI)
    request = gateway.functions.nonces(to_checksum_address(owner)).call()
    return int(await _call_rpc("KeyGateway nonce lookup", request))


async def encode_metadata_onchain(
    request_fid: int,
    request_signer: str,
    signature: bytes | str,
    deadline: int,
    *,
    w3: AsyncWeb3 | None = None,
) -> bytes:
    """``SignedKeyRequestValidator.encodeMetadata`` (reference for tests)."""
    client = await _verified_web3(w3)
    validator = client.eth.contract(
        address=SIGNED_KEY_REQUEST_VALIDATOR_ADDRESS,
        abi=SIGNED_KEY_REQUEST_VALIDATOR_ABI,
    )
    metadata = (
        request_fid,
        to_checksum_address(request_signer),
        _to_bytes(signature),
        deadline,
    )
    request = validator.functions.encodeMetadata(metadata).call()
    return bytes(await _call_rpc("encodeMetadata", request))


def _relayer_account() -> Any:
    if not settings.KEY_RELAYER_PRIVATE_KEY:
        raise KeyGatewayConfigError("KEY_RELAYER_PRIVATE_KEY is not configured")
    try:
        return Account.from_key(settings.KEY_RELAYER_PRIVATE_KEY)
    except (ValueError, TypeError):
        # Never chain the original exception: its args may echo key material.
        raise KeyGatewayConfigError("KEY_RELAYER_PRIVATE_KEY is invalid") from None


def _simulation_sender() -> str:
    """``from`` for ``eth_call``: the relayer when configured, else zero.

    ``addFor`` is not sender-gated, so a dry run needs no relayer key.
    """
    if not settings.KEY_RELAYER_PRIVATE_KEY:
        return ZERO_ADDRESS
    return _relayer_account().address


def _add_for_call(
    client: AsyncWeb3,
    *,
    fid_owner: str,
    key_type: int,
    key: bytes | str,
    metadata: bytes | str,
    deadline: int,
    signature: bytes | str,
) -> Any:
    validate_add_for_shape(key_type=key_type, key=key, deadline=deadline)
    gateway = client.eth.contract(address=KEY_GATEWAY_ADDRESS, abi=KEY_GATEWAY_ABI)
    return gateway.functions.addFor(
        to_checksum_address(fid_owner),
        key_type,
        _to_bytes(key),
        METADATA_TYPE_SIGNED_KEY_REQUEST,
        _to_bytes(metadata),
        deadline,
        _to_bytes(signature),
    )


def _revert_reason(exc: Exception) -> str | None:
    data = getattr(exc, "data", None)
    if isinstance(data, str) and data.startswith("0x") and len(data) >= 10:
        name = CUSTOM_ERRORS_BY_SELECTOR.get(data[:10].lower())
        if name:
            return name
    message = getattr(exc, "message", None) or (exc.args[0] if exc.args else None)
    return str(message) if message else None


async def simulate_add_for(
    *,
    fid_owner: str,
    key_type: int,
    key: bytes | str,
    metadata: bytes | str,
    deadline: int,
    signature: bytes | str,
    w3: AsyncWeb3 | None = None,
) -> None:
    """``eth_call`` ``addFor``; returns normally when it would succeed.

    ``addFor`` has no return value (KeyGateway.sol), so success is the
    absence of a revert.

    Raises :class:`KeyGatewayValidationError` for malformed arguments, or
    :class:`KeyGatewayError` with the decoded revert reason (e.g.
    ``InvalidSignature``, ``SignatureExpired``, ``InvalidMetadata``).
    """
    client = await _verified_web3(w3)
    call = _add_for_call(
        client,
        fid_owner=fid_owner,
        key_type=key_type,
        key=key,
        metadata=metadata,
        deadline=deadline,
        signature=signature,
    )
    await _call_rpc(
        "addFor simulation",
        call.call({"from": _simulation_sender()}),
        decode_reverts=True,
    )


def _app_request_signer() -> str:
    """Checksummed address of the Juke app key that signs SignedKeyRequests."""
    try:
        return _get_app_account().address
    except (ValueError, EthValidationError):
        # Never chain: eth_account echoes the mnemonic words when invalid.
        raise KeyGatewayConfigError(
            "FARCASTER_APP_MNEMONIC is missing or invalid"
        ) from None


def _validate_signed_key_request(metadata: bytes | str) -> None:
    """Require the metadata to be Juke's own, unexpired SignedKeyRequest."""
    if settings.FARCASTER_APP_FID <= 0:
        raise KeyGatewayConfigError("FARCASTER_APP_FID is not configured")
    try:
        decoded = decode_signed_key_request_metadata(metadata)
    except ValueError:
        raise KeyGatewayValidationError(
            "metadata is malformed", reason="InvalidMetadata"
        ) from None
    if decoded.request_fid != settings.FARCASTER_APP_FID:
        raise KeyGatewayValidationError(
            "metadata requestFid is not the Juke app FID", reason="InvalidMetadata"
        )
    if decoded.request_signer != _app_request_signer():
        raise KeyGatewayValidationError(
            "metadata requestSigner is not the Juke app account",
            reason="InvalidMetadata",
        )
    _require_deadline_in_window(
        decoded.deadline,
        max_seconds=MAX_KEY_REQUEST_DEADLINE_SECONDS,
        label="SignedKeyRequest",
    )


async def _verify_add_signature(
    client: AsyncWeb3,
    *,
    fid_owner: str,
    key_type: int,
    key: bytes | str,
    metadata: bytes | str,
    deadline: int,
    signature: bytes | str,
) -> None:
    """Rebuild the ``Add`` typed data at the live nonce; require ``fid_owner``."""
    nonce = await key_gateway_nonce(fid_owner, w3=client)
    typed_data = build_add_typed_data(
        fid_owner, key_type, key, metadata, nonce, deadline
    )
    try:
        recovered = recover_add_signer(typed_data, signature)
    except MALFORMED_SIGNATURE_ERRORS:
        raise KeyGatewayValidationError(
            "Add signature is malformed", reason="InvalidSignature"
        ) from None
    if recovered != to_checksum_address(fid_owner):
        raise KeyGatewayValidationError(
            "Add signature was not made by fid_owner", reason="InvalidSignature"
        )


def _require_within_cap(value: int, cap: int, label: str) -> None:
    if value > cap:
        raise KeyGatewaySpendCapError(
            f"{label} {value} exceeds cap {cap}; refusing to send",
            reason="SpendCapExceeded",
        )


async def _check_relayer_balance(
    client: AsyncWeb3, relayer_address: str, max_cost_wei: int
) -> None:
    """Refuse when the relayer cannot cover ``max_cost_wei``; warn when low.

    ``max_cost_wei`` covers L2 execution only; the OP L1 data fee is extra
    but small, and ``KEY_RELAYER_MIN_BALANCE_WEI`` is the operational margin.
    """
    balance = int(
        await _call_rpc(
            "relayer balance lookup", client.eth.get_balance(relayer_address)
        )
    )
    if balance < settings.KEY_RELAYER_MIN_BALANCE_WEI:
        # No amounts or address: they would tie the balance to the relayer key.
        logger.warning(
            "[key_gateway] relayer balance below KEY_RELAYER_MIN_BALANCE_WEI; "
            "top up the relayer"
        )
    if balance < max_cost_wei:
        raise KeyGatewaySpendCapError(
            "relayer balance cannot cover addFor max cost",
            reason="InsufficientRelayerBalance",
        )


async def send_add_for(
    *,
    fid_owner: str,
    key_type: int,
    key: bytes | str,
    metadata: bytes | str,
    deadline: int,
    signature: bytes | str,
    w3: AsyncWeb3 | None = None,
) -> str:
    """Sign and broadcast ``addFor`` from the relayer; return the tx hash.

    Enforced here before any gas is spent (each failure raises
    :class:`KeyGatewayValidationError` and sends nothing):

    * ``key_type``/``key`` shape and ``now < deadline <= now +``
      :data:`MAX_ADD_DEADLINE_SECONDS`;
    * ``metadata`` decodes to a SignedKeyRequest from the Juke app FID and
      app account, with a deadline within
      :data:`MAX_KEY_REQUEST_DEADLINE_SECONDS`;
    * the ``Add`` typed data, rebuilt at the live ``KeyGateway.nonces``,
      recovers to ``fid_owner``;
    * :func:`simulate_add_for` succeeds.

    Spend guards raise :class:`KeyGatewaySpendCapError`: the buffered gas
    limit, ``maxFeePerGas`` and ``maxPriorityFeePerGas`` must be within
    :data:`MAX_ADD_FOR_GAS`, :data:`MAX_FEE_PER_GAS_WEI` and
    :data:`MAX_PRIORITY_FEE_PER_GAS_WEI` (refused, never clamped), and the
    relayer balance must cover ``gas * maxFeePerGas``.

    Idempotency (one addFor per key), per-user rate limiting and the
    cross-worker relayer lock are the caller's job
    (``user_signer_service``); this function does none of them.

    Nonce allocation is serialized per process; gas is estimated with a 20%
    buffer and EIP-1559 fees are ``2 * baseFee + priorityFee``.
    """
    validate_add_for_shape(key_type=key_type, key=key, deadline=deadline)
    _validate_signed_key_request(metadata)
    client = await _verified_web3(w3)
    relayer = _relayer_account()
    add_args: dict[str, Any] = {
        "fid_owner": fid_owner,
        "key_type": key_type,
        "key": key,
        "metadata": metadata,
        "deadline": deadline,
        "signature": signature,
    }
    await _verify_add_signature(client, **add_args)
    await simulate_add_for(**add_args, w3=client)
    call = _add_for_call(client, **add_args)
    async with _relayer_lock:
        tx_hash = await _call_rpc(
            "addFor submission",
            _sign_and_send(client, relayer, call),
            decode_reverts=True,
        )
    tx_hash_hex = "0x" + bytes(tx_hash).hex()
    logger.info(
        "[key_gateway] addFor sent tx=%s owner=%s key_type=%d",
        tx_hash_hex,
        to_checksum_address(fid_owner),
        key_type,
    )
    return tx_hash_hex


async def _sign_and_send(client: AsyncWeb3, relayer: Any, call: Any) -> Any:
    """Build, cap-check, sign and broadcast ``call``. Hold ``_relayer_lock``."""
    nonce = await client.eth.get_transaction_count(relayer.address, "pending")
    gas_estimate = await call.estimate_gas({"from": relayer.address})
    gas_limit = (
        gas_estimate * GAS_LIMIT_BUFFER_NUMERATOR // GAS_LIMIT_BUFFER_DENOMINATOR
    )
    _require_within_cap(gas_limit, MAX_ADD_FOR_GAS, "gas limit")
    latest = await client.eth.get_block("latest")
    priority_fee = int(await client.eth.max_priority_fee)
    _require_within_cap(
        priority_fee, MAX_PRIORITY_FEE_PER_GAS_WEI, "maxPriorityFeePerGas"
    )
    max_fee = int(latest["baseFeePerGas"]) * BASE_FEE_MULTIPLIER + priority_fee
    _require_within_cap(max_fee, MAX_FEE_PER_GAS_WEI, "maxFeePerGas")
    await _check_relayer_balance(client, relayer.address, gas_limit * max_fee)
    tx = await call.build_transaction(
        {
            "from": relayer.address,
            "chainId": OPTIMISM_CHAIN_ID,
            "nonce": nonce,
            "gas": gas_limit,
            "maxPriorityFeePerGas": priority_fee,
            "maxFeePerGas": max_fee,
        }
    )
    signed = relayer.sign_transaction(tx)
    return await client.eth.send_raw_transaction(signed.raw_transaction)


async def wait_for_add_receipt(
    tx_hash: str,
    *,
    timeout_seconds: float = DEFAULT_RECEIPT_TIMEOUT_SECONDS,
    w3: AsyncWeb3 | None = None,
) -> Mapping[str, Any]:
    """Wait for ``tx_hash`` to be mined; raise if it reverted or timed out."""
    client = await _verified_web3(w3)
    receipt = await _call_rpc(
        "addFor receipt wait",
        client.eth.wait_for_transaction_receipt(tx_hash, timeout=timeout_seconds),
    )
    if receipt["status"] != TX_STATUS_SUCCESS:
        raise KeyGatewayError("addFor transaction reverted", reason="reverted")
    return receipt
