"""SignedKeyRequest signing with the Juke app FID's custody account.

Every key Juke adds through ``KeyGateway.addFor`` (a user's Ed25519 app
signer, a device auth address, a snap key, a bot key) carries metadata
signed here. The app account is derived from ``FARCASTER_APP_MNEMONIC``;
neither the mnemonic nor the derived private key is ever logged.

Kept dependency-free of :mod:`app.clients.key_gateway` so that module can
import :func:`_get_app_account` without an import cycle.
"""

import time
from functools import lru_cache

from eth_account import Account
from eth_account.messages import encode_typed_data

from app.config import settings

KEY_REQUEST_DEADLINE_SECONDS = 24 * 60 * 60

# Farcaster SignedKeyRequestValidator on OP Mainnet.
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


@lru_cache(maxsize=1)
def _get_app_account() -> Account:
    """Derive the app's Ethereum account from the configured mnemonic."""
    if not settings.FARCASTER_APP_MNEMONIC:
        raise ValueError("FARCASTER_APP_MNEMONIC is not configured")
    Account.enable_unaudited_hdwallet_features()
    return Account.from_mnemonic(settings.FARCASTER_APP_MNEMONIC)


def sign_key_request(key: bytes) -> tuple[str, int]:
    """Sign a SignedKeyRequest for ``key`` (the exact ``addFor`` key bytes).

    Returns ``(signature_hex, deadline)``. Raises ``ValueError`` when the
    app FID or mnemonic is not configured.
    """
    if settings.FARCASTER_APP_FID <= 0:
        raise ValueError("FARCASTER_APP_FID is not configured")
    deadline = int(time.time()) + KEY_REQUEST_DEADLINE_SECONDS
    signable = encode_typed_data(
        domain_data=SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN,
        message_types=SIGNED_KEY_REQUEST_TYPES,
        message_data={
            "requestFid": settings.FARCASTER_APP_FID,
            "key": key,
            "deadline": deadline,
        },
    )
    signed = _get_app_account().sign_message(signable)
    return f"0x{signed.signature.hex()}", deadline
