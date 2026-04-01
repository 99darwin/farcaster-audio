"""Auth address registration for miniapp signIn (SIWF).

Generates EIP-712 signed key requests using the app's Farcaster account
and registers them with Neynar's auth address API.
"""

import time
from functools import lru_cache

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data

from app.config import settings

KEY_REQUEST_DEADLINE_SECONDS = 86400  # 24 hours

# Farcaster SignedKeyRequestValidator on OP Mainnet
SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN = {
    "name": "Farcaster SignedKeyRequestValidator",
    "version": "1",
    "chainId": 10,
    "verifyingContract": "0x00000000fc700472606ed4fa22623acf62c60553",
}

SIGNED_KEY_REQUEST_TYPES = {
    "SignedKeyRequest": [
        {"name": "requestFid", "type": "uint256"},
        {"name": "key", "type": "bytes"},
        {"name": "deadline", "type": "uint256"},
    ],
}

NEYNAR_AUTH_ADDRESS_URL = (
    "https://api.neynar.com/v2/farcaster/auth_address"
    "/developer_managed/signed_key"
)


@lru_cache(maxsize=1)
def _get_app_account() -> Account:
    """Derive the app's Ethereum account from the configured mnemonic."""
    if not settings.FARCASTER_APP_MNEMONIC:
        raise ValueError("FARCASTER_APP_MNEMONIC is not configured")
    Account.enable_unaudited_hdwallet_features()
    return Account.from_mnemonic(settings.FARCASTER_APP_MNEMONIC)


def _encode_auth_address_as_key(auth_address: str) -> bytes:
    """ABI-encode an address into the `key` field format expected by the validator.

    The Neynar docs show: encodeAbiParameters([{type: 'address'}], [address])
    which is just the address zero-padded to 32 bytes.
    """
    addr_bytes = bytes.fromhex(auth_address[2:].lower())
    return b"\x00" * 12 + addr_bytes


def generate_signed_key_request(auth_address: str) -> tuple[str, int]:
    """Sign an EIP-712 key request for the given auth address.

    Returns (signature_hex, deadline).
    """
    if settings.FARCASTER_APP_FID <= 0:
        raise ValueError("FARCASTER_APP_FID is not configured")

    app_account = _get_app_account()
    deadline = int(time.time()) + KEY_REQUEST_DEADLINE_SECONDS

    key = _encode_auth_address_as_key(auth_address)

    message = {
        "requestFid": settings.FARCASTER_APP_FID,
        "key": key,
        "deadline": deadline,
    }

    signable = encode_typed_data(
        domain_data=SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN,
        message_types=SIGNED_KEY_REQUEST_TYPES,
        primary_type="SignedKeyRequest",
        message_data=message,
    )

    signed = app_account.sign_message(signable)
    return f"0x{signed.signature.hex()}", deadline


async def register_auth_address_with_neynar(
    auth_address: str,
    signature: str,
    deadline: int,
) -> dict:
    """Register an auth address with Neynar's developer-managed signed key API."""
    payload = {
        "address": auth_address,
        "app_fid": settings.FARCASTER_APP_FID,
        "deadline": deadline,
        "signature": signature,
        "sponsor": {
            "fid": settings.FARCASTER_APP_FID,
            "sponsored_by_neynar": True,
        },
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.post(
            NEYNAR_AUTH_ADDRESS_URL,
            json=payload,
            headers={
                "x-api-key": settings.NEYNAR_API_KEY,
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def check_auth_address_status(auth_address: str) -> dict:
    """Check the registration status of an auth address via Neynar."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.get(
            "https://api.neynar.com/v2/farcaster/auth_address/developer_managed/",
            params={"address": auth_address},
            headers={"x-api-key": settings.NEYNAR_API_KEY},
        )
        resp.raise_for_status()
        return resp.json()
