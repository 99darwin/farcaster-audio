"""Developer-managed signer flow for the web SIWN dashboard.

Replaces the legacy popup-based SIWN flow that relied on
`window.opener.postMessage()` from `app.neynar.com` — Neynar's web
auth page now doesn't reliably postMessage in all cases, so we own
the auth lifecycle end-to-end on the backend:

1. POST /v1/auth/signer/create
   → backend: POST Neynar /v2/farcaster/signer/   (createSigner)
   → backend: EIP-712-sign the returned public_key with the app's
     custody account
   → backend: POST Neynar /v2/farcaster/signer/signed_key
     (registerSignedKey)
   ← returns {signer_uuid, signer_approval_url}

2. Client opens signer_approval_url in a popup. User approves the
   signer in their Farcaster client.

3. GET /v1/auth/signer/status?signer_uuid=...
   → backend: GET Neynar /v2/farcaster/signer?signer_uuid=...
   ← returns {status, fid}

4. On status="approved": client calls /v1/auth/login with the
   {fid, signer_uuid} pair (existing endpoint).

The SignedKeyRequestValidator EIP-712 plumbing is duplicated with
`auth_address_service.py` rather than refactored into a shared module
— the two services sign different `key` shapes (raw 32-byte Ed25519
pubkey here vs zero-padded 20-byte address there) and pre-deploying
a shared dependency would risk regressing the iOS auth-address flow.
"""

import time

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data
from fastapi import HTTPException, status as http_status

from app.config import settings

# Farcaster SignedKeyRequestValidator on OP Mainnet — same on-chain
# contract used by `auth_address_service.py`.
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

NEYNAR_SIGNER_URL = "https://api.neynar.com/v2/farcaster/signer/"
NEYNAR_SIGNER_SIGNED_KEY_URL = (
    "https://api.neynar.com/v2/farcaster/signer/signed_key"
)
KEY_REQUEST_DEADLINE_SECONDS = 86400  # 24h


def _get_app_account():
    if not settings.FARCASTER_APP_MNEMONIC:
        raise ValueError("FARCASTER_APP_MNEMONIC is not configured")
    Account.enable_unaudited_hdwallet_features()
    return Account.from_mnemonic(settings.FARCASTER_APP_MNEMONIC)


def _sign_signer_public_key(public_key_hex: str) -> tuple[str, int]:
    """EIP-712-sign an Ed25519 signer public key with the app's custody key.

    The validator expects `key` to be the raw 32-byte Ed25519 public
    key — different from `auth_address_service`, which zero-pads a
    20-byte address to 32 bytes.
    """
    if settings.FARCASTER_APP_FID <= 0:
        raise ValueError("FARCASTER_APP_FID is not configured")

    hex_part = (
        public_key_hex[2:]
        if public_key_hex.startswith("0x")
        else public_key_hex
    )
    if len(hex_part) != 64:
        raise ValueError(
            f"Expected 32-byte Ed25519 public key, got {len(hex_part) // 2} bytes"
        )
    key_bytes = bytes.fromhex(hex_part)

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
    signed = _get_app_account().sign_message(signable)
    return f"0x{signed.signature.hex()}", deadline


async def create_and_register_signer() -> dict:
    """Create a Neynar signer + register its signed key for approval.

    Returns: {signer_uuid, signer_approval_url, public_key}.
    """
    if not settings.NEYNAR_API_KEY:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Neynar API key not configured",
        )

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        # 1. createSigner — generates a fresh signer_uuid + Ed25519 key.
        create_resp = await client.post(
            NEYNAR_SIGNER_URL,
            headers={"x-api-key": settings.NEYNAR_API_KEY},
        )
        create_resp.raise_for_status()
        created = create_resp.json()
        signer_uuid = created["signer_uuid"]
        public_key = created["public_key"]

        # 2. Sign the public_key with the app's custody key (EIP-712).
        signature, deadline = _sign_signer_public_key(public_key)

        # 3. registerSignedKey — mints `signer_approval_url`. Sponsored
        #    by Neynar so the user pays nothing on-chain.
        register_resp = await client.post(
            NEYNAR_SIGNER_SIGNED_KEY_URL,
            json={
                "signer_uuid": signer_uuid,
                "app_fid": settings.FARCASTER_APP_FID,
                "deadline": deadline,
                "signature": signature,
                "sponsor": {
                    "fid": settings.FARCASTER_APP_FID,
                    "sponsored_by_neynar": True,
                },
            },
            headers={
                "x-api-key": settings.NEYNAR_API_KEY,
                "Content-Type": "application/json",
            },
        )
        register_resp.raise_for_status()
        registered = register_resp.json()

    return {
        "signer_uuid": registered["signer_uuid"],
        "signer_approval_url": registered["signer_approval_url"],
        "public_key": registered["public_key"],
    }


async def lookup_signer_status(signer_uuid: str) -> dict:
    """Poll Neynar for the signer's current status.

    Returns the raw response body — callers care about `status` and
    `fid` (set once the user approves).
    """
    if not settings.NEYNAR_API_KEY:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Neynar API key not configured",
        )

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.get(
            NEYNAR_SIGNER_URL,
            params={"signer_uuid": signer_uuid},
            headers={"x-api-key": settings.NEYNAR_API_KEY},
        )
        resp.raise_for_status()
        return resp.json()
