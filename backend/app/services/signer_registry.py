"""Read-side checks for keys registered on the Farcaster KeyRegistry.

* Ed25519 app signers (keyType 1) are read from Hypersnap's
  ``/v1/signersByFid``, which lists a FID's active on-chain keys.
* Auth addresses (keyType 2) are not surfaced by Hypersnap's signer
  endpoints, so they are read straight from ``KeyRegistry.keyDataOf`` on
  Optimism with the 32-byte ABI-encoded address as the key.

Upstream failures propagate (``HypersnapError`` / ``KeyGatewayError``); a
failed lookup is never reported as "not registered".
"""

from __future__ import annotations

from app.clients import hypersnap, key_gateway

SIGNERS_BY_FID_PATH = "/signersByFid"
SIGNERS_PAGE_SIZE = 1000
# Hard stop on pagination; a FID with more keys than this is pathological.
MAX_SIGNER_PAGES = 10
SIGNER_SOURCE_ONCHAIN = "SIGNER_SOURCE_ONCHAIN"


def _normalize_key(key: str) -> str:
    return "0x" + key.removeprefix("0x").lower()


async def list_active_ed25519_keys(fid: int) -> set[str]:
    """Active on-chain Ed25519 keys of ``fid`` as lowercase ``0x`` hex."""
    keys: set[str] = set()
    params: dict[str, object] = {"fid": fid, "pageSize": SIGNERS_PAGE_SIZE}
    seen_tokens: set[str] = set()
    for _ in range(MAX_SIGNER_PAGES):
        page = await hypersnap.get_v1(SIGNERS_BY_FID_PATH, params)
        for signer in page.get("signers") or []:
            if signer.get("source") != SIGNER_SOURCE_ONCHAIN:
                continue
            if signer.get("keyType") != key_gateway.KEY_TYPE_ED25519:
                continue
            if signer.get("fid") not in (None, fid):
                continue
            key = signer.get("key")
            if isinstance(key, str):
                keys.add(_normalize_key(key))
        token = page.get("nextPageToken")
        if not token or token in seen_tokens:
            break
        seen_tokens.add(token)
        params["pageToken"] = token
    return keys


async def is_ed25519_signer_active(fid: int, public_key: str) -> bool:
    """True when Hypersnap lists ``public_key`` as an active key of ``fid``."""
    return _normalize_key(public_key) in await list_active_ed25519_keys(fid)


async def is_auth_address_active(fid: int, address: str) -> bool:
    """True when ``address`` is an added keyType 2 key of ``fid`` on-chain."""
    state, key_type = await key_gateway.key_data_of(
        fid, key_gateway.auth_address_key(address)
    )
    return (
        state == key_gateway.KEY_STATE_ADDED
        and key_type == key_gateway.KEY_TYPE_AUTH_ADDRESS
    )
