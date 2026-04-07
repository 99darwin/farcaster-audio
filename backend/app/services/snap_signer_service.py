"""Ed25519 signer registration for Farcaster Snap interactivity.

The Farcaster Snap server package (`@farcaster/snap`) strictly requires POST
bodies to be JSON Farcaster Signatures signed with an `app_key` (Ed25519)
that is actively registered on the hub for the user's FID. Auth addresses
(secp256k1) are explicitly rejected.

This service mirrors `auth_address_service.py` but for Ed25519 keys: it
signs an EIP-712 SignedKeyRequest with the app's Farcaster account and
registers the user's on-device Ed25519 public key with Neynar's
developer-managed signer API.
"""

import time

import httpx
from eth_account.messages import encode_typed_data

from app.config import settings
from app.services.auth_address_service import (
    SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN,
    SIGNED_KEY_REQUEST_TYPES,
    _get_app_account,
)

KEY_REQUEST_DEADLINE_SECONDS = 86400  # 24 hours

NEYNAR_SIGNER_REGISTER_URL = (
    "https://api.neynar.com/v2/farcaster/signer"
    "/developer_managed/signed_key/"
)
NEYNAR_SIGNER_STATUS_URL = (
    "https://api.neynar.com/v2/farcaster/signer/developer_managed"
)


def _decode_pubkey_hex(public_key_hex: str) -> bytes:
    """Validate and decode a 0x-prefixed 32-byte Ed25519 public key."""
    if not public_key_hex.startswith("0x"):
        raise ValueError("public_key must be 0x-prefixed")
    raw = bytes.fromhex(public_key_hex[2:])
    if len(raw) != 32:
        raise ValueError("Ed25519 public key must be 32 bytes")
    return raw


def generate_signed_key_request_for_ed25519(
    public_key_hex: str,
) -> tuple[str, int]:
    """Sign an EIP-712 SignedKeyRequest authorizing an Ed25519 app_key.

    The `key` field carries the raw 32-byte public key (not zero-padded —
    it is already exactly 32 bytes). Returns (signature_hex, deadline).
    """
    if settings.FARCASTER_APP_FID <= 0:
        raise ValueError("FARCASTER_APP_FID is not configured")

    key_bytes = _decode_pubkey_hex(public_key_hex)

    app_account = _get_app_account()
    deadline = int(time.time()) + KEY_REQUEST_DEADLINE_SECONDS

    message = {
        "requestFid": settings.FARCASTER_APP_FID,
        "key": key_bytes,
        "deadline": deadline,
    }

    signable = encode_typed_data(
        domain_data=SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN,
        message_types=SIGNED_KEY_REQUEST_TYPES,
        message_data=message,
    )

    signed = app_account.sign_message(signable)
    return f"0x{signed.signature.hex()}", deadline


async def register_ed25519_signer_with_neynar(
    public_key_hex: str,
    signature: str,
    deadline: int,
) -> dict:
    """Register an Ed25519 public key with Neynar as a developer-managed signer."""
    payload = {
        "public_key": public_key_hex,
        "app_fid": settings.FARCASTER_APP_FID,
        "deadline": deadline,
        "signature": signature,
        "sponsor": {
            "sponsored_by_neynar": True,
        },
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.post(
            NEYNAR_SIGNER_REGISTER_URL,
            json=payload,
            headers={
                "x-api-key": settings.NEYNAR_API_KEY,
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def check_ed25519_signer_status(public_key_hex: str) -> dict:
    """Check the registration status of a developer-managed Ed25519 signer."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.get(
            NEYNAR_SIGNER_STATUS_URL,
            params={"public_key": public_key_hex},
            headers={"x-api-key": settings.NEYNAR_API_KEY},
        )
        resp.raise_for_status()
        return resp.json()
