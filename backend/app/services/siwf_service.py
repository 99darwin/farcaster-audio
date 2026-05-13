"""Sign In With Farcaster (SIWF) — EIP-4361 / SIWE-based auth.

Replaces the legacy `createSigner + registerSignedKey` "managed-signer"
flow for web/embed sign-in. Why:

- SIWF is purpose-built for *authentication* (prove FID ownership) —
  it doesn't grant write access, doesn't create on-chain state.
- The signed message is EIP-4361 (SIWE) format and includes the
  requesting `domain` as a first-class field. The Farcaster client
  surfaces that domain to the user at approval time — so a victim
  scanning a QR generated on `evil.com` sees "evil.com wants you to
  sign in" rather than the registered app name only. This structurally
  closes the QR-phishing chain that the managed-signer flow couldn't
  defend against.
- The relay is operated by the Farcaster team
  (`https://relay.farcaster.xyz`); the client (`@farcaster/auth-client`
  in our frontend) handles channel creation, status polling, and the
  signed-message return. Our backend's job is the last mile: verify
  the signature, confirm the recovered custody address belongs to the
  claimed FID via Neynar, mint a Juke JWT.

Public surface used by `routers/auth.py`:

- `mint_siwf_nonce(redis)` -> str
- `consume_siwf_nonce(redis, nonce)` -> bool
- `verify_siwf_message(message, signature, expected_domain, expected_nonce)`
  -> recovered custody address (lowercase hex)
- `lookup_fid_by_custody(address)` -> int | None  (via Neynar)
"""

import logging
import secrets

import httpx
from fastapi import HTTPException, status
from siwe import SiweMessage
from siwe.siwe import VerificationError

from app.config import settings

logger = logging.getLogger(__name__)

# Short TTL — nonces are single-use and tied to a freshly initiated
# sign-in attempt. 10 minutes covers a generous "open Farcaster, scan
# QR, approve" cycle but doesn't leave a long replay window.
SIWF_NONCE_TTL_SECONDS = 600
SIWF_NONCE_PREFIX = "siwf_nonce:"

# Neynar's bulk-by-address endpoint accepts comma-separated 0x addresses.
# Returns a map keyed by lowercased address.
NEYNAR_BULK_BY_ADDRESS_URL = (
    "https://api.neynar.com/v2/farcaster/user/bulk-by-address"
)


def _generate_nonce() -> str:
    # SIWE recommends at least 8 alphanumeric chars; we use 16 bytes
    # (~22 base64url chars) for ample entropy.
    return secrets.token_urlsafe(16).rstrip("=")


async def mint_siwf_nonce(redis) -> str:
    """Generate a fresh SIWF nonce, persist it in Redis with a short TTL.

    The nonce is opaque to the client — it's used verbatim in the SIWE
    message and verified on submission. Server-issued nonces give us
    replay protection and let us bound a single sign-in attempt to a
    short window without trusting client clocks.
    """
    nonce = _generate_nonce()
    await redis.set(
        f"{SIWF_NONCE_PREFIX}{nonce}", "1", ex=SIWF_NONCE_TTL_SECONDS
    )
    return nonce


async def consume_siwf_nonce(redis, nonce: str) -> bool:
    """Check that `nonce` was previously minted and not yet consumed.

    Atomic delete-if-exists semantics: returns True iff the nonce was
    present (and is now gone). Concurrent submissions of the same nonce
    only succeed once.
    """
    if not nonce or not isinstance(nonce, str):
        return False
    deleted = await redis.delete(f"{SIWF_NONCE_PREFIX}{nonce}")
    try:
        return int(deleted) > 0
    except (TypeError, ValueError):
        return bool(deleted)


async def verify_siwf_message(
    *,
    message: str,
    signature: str,
    expected_domain: str,
    expected_nonce: str,
) -> str:
    """Parse + cryptographically verify the SIWE message.

    Returns the recovered custody address (lowercase, 0x-prefixed). The
    siwe library raises `VerificationError` on any mismatch (bad
    signature, wrong domain, wrong nonce, expired timestamps, etc.).
    We translate that to 401 with a generic detail so we don't leak
    which specific check failed.
    """
    try:
        siwe_msg = SiweMessage.from_message(message)
    except Exception as exc:  # noqa: BLE001 — siwe lib raises a mix
        logger.info("siwf_verify_parse_failed", extra={"error": str(exc)})
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid SIWF message.",
        )

    try:
        await siwe_msg.verify(
            signature=signature,
            domain=expected_domain,
            nonce=expected_nonce,
        )
    except VerificationError as exc:
        logger.info(
            "siwf_verify_failed",
            extra={"error": exc.__class__.__name__},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid SIWF signature.",
        )

    address = (siwe_msg.address or "").lower()
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid SIWF signer address.",
        )
    return address


async def lookup_fid_by_custody(address: str) -> int | None:
    """Resolve a custody (or verified) address to a Farcaster FID.

    Uses Neynar's bulk-by-address endpoint. We trust Neynar as the
    authoritative directory — same trust assumption as the rest of the
    backend. Returns None if no Farcaster account is associated with
    the address.
    """
    if not settings.NEYNAR_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Neynar API key not configured.",
        )
    normalized = address.lower()
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        resp = await client.get(
            NEYNAR_BULK_BY_ADDRESS_URL,
            params={"addresses": normalized},
            headers={"x-api-key": settings.NEYNAR_API_KEY},
        )
    if resp.status_code == 404:
        return None
    if not resp.is_success:
        logger.error(
            "neynar_lookup_failed",
            extra={"status": resp.status_code, "body": resp.text[:200]},
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not resolve Farcaster account.",
        )
    body = resp.json()
    # Neynar keys the response map by the lowercased input address.
    users = body.get(normalized) or body.get(address) or []
    if not users:
        return None
    # If multiple users share a verified address, prefer the one whose
    # custody address matches; otherwise take the first. Custody is
    # 1:1 with FID, so when the message was signed by a custody key
    # the match is unambiguous.
    for user in users:
        if (user.get("custody_address") or "").lower() == normalized:
            return int(user["fid"])
    first = users[0]
    return int(first["fid"]) if first.get("fid") else None
