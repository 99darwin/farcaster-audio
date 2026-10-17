"""Sign In With Farcaster (SIWF) and Protocol Auth — EIP-4361 / SIWE auth.

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
  the signature, confirm the recovered custody address owns an FID
  on-chain (``IdRegistry.idOf``), mint a Juke JWT.

Public surface:

- `mint_siwf_nonce(redis)` -> str
- `consume_siwf_nonce(redis, nonce)` -> bool
- `verify_siwf_message(message, signature, expected_domain, expected_nonce)`
  -> recovered custody address (lowercase hex)
- `lookup_fid_by_custody(address)` -> int | None  (``IdRegistry.idOf``)
- `verify_protocol_auth_token(token, ...)` -> ProtocolAuthClaims.
  Verifies a Protocol Auth (``hqa1.``) token locally: the SIWE message is
  signed by the FID's custody address or one of its KeyRegistry auth
  addresses (keyType 2). No third-party JWKS or API is involved.
"""

import base64
import binascii
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import HTTPException, status
from siwe import SiweMessage
from siwe.siwe import VerificationError

from app.clients import key_gateway
from app.services import signer_registry

logger = logging.getLogger(__name__)

# Short TTL — nonces are single-use and tied to a freshly initiated
# sign-in attempt. 10 minutes covers a generous "open Farcaster, scan
# QR, approve" cycle but doesn't leave a long replay window.
SIWF_NONCE_TTL_SECONDS = 600
SIWF_NONCE_PREFIX = "siwf_nonce:"

# Protocol Auth (``@farcasterorg/quick-auth`` ``hqa1.`` tokens).
PROTOCOL_AUTH_TOKEN_PREFIX = "hqa1."
PROTOCOL_AUTH_MAX_TTL_SECONDS = 60 * 60
PROTOCOL_AUTH_CLOCK_SKEW_SECONDS = 5 * 60
PROTOCOL_AUTH_CHAIN_ID = key_gateway.OPTIMISM_CHAIN_ID
PROTOCOL_AUTH_STATEMENT = "Authenticate as Farcaster FID {fid}."
FID_RESOURCE_RE = re.compile(r"^farcaster://fid/([1-9][0-9]{0,15})$")
SECP256K1_SIGNATURE_BYTES = 65
LINK_METHOD_CUSTODY = "custody"
LINK_METHOD_AUTH_ADDRESS = "authAddress"
ALLOWED_URI_SCHEMES = frozenset({"http", "https"})


def _generate_nonce() -> str:
    # EIP-4361 nonces must be alphanumeric: the siwe parser rejects the
    # ``-``/``_`` that base64url produces. 16 bytes = 32 hex chars.
    return secrets.token_hex(16)


async def mint_siwf_nonce(redis) -> str:
    """Generate a fresh SIWF nonce, persist it in Redis with a short TTL.

    The nonce is opaque to the client — it's used verbatim in the SIWE
    message and verified on submission. Server-issued nonces give us
    replay protection and let us bound a single sign-in attempt to a
    short window without trusting client clocks.
    """
    nonce = _generate_nonce()
    await redis.set(f"{SIWF_NONCE_PREFIX}{nonce}", "1", ex=SIWF_NONCE_TTL_SECONDS)
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
        logger.warning(
            "siwf_verify_parse_failed",
            extra={
                "error_class": exc.__class__.__name__,
                "error": str(exc)[:200],
            },
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid SIWF message.",
        )

    try:
        # siwe-py 4.x `verify` is synchronous and raises VerificationError
        # subclasses on any mismatch (DomainMismatch, NonceMismatch,
        # InvalidSignature, ExpiredMessage, NotYetValidMessage, etc.).
        siwe_msg.verify(
            signature=signature,
            domain=expected_domain,
            nonce=expected_nonce,
        )
    except VerificationError as exc:
        # Log the *specific* subclass so production failures are
        # diagnosable (domain mismatch vs nonce vs signature vs
        # expiry). Also log the parsed message's domain so we can
        # spot host-variant issues (e.g. www.juke.audio vs
        # juke.audio). The user-visible detail stays generic so we
        # don't leak which check failed.
        logger.warning(
            "siwf_verify_failed",
            extra={
                "error_class": exc.__class__.__name__,
                "error": str(exc)[:200],
                "msg_domain": getattr(siwe_msg, "domain", None),
                "expected_domain": expected_domain,
                "msg_nonce_prefix": (getattr(siwe_msg, "nonce", "") or "")[:6],
            },
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
    """Resolve a custody address to its FID via ``IdRegistry.idOf``.

    Returns None when the address is not a custody address. Chain read
    failures surface as 502.
    """
    try:
        fid = await key_gateway.id_of(address)
    except (key_gateway.KeyGatewayError, ValueError):
        logger.error("custody_lookup_failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not resolve Farcaster account.",
        ) from None
    return fid or None


# ---------------------------------------------------------------------------
# Protocol Auth (hqa1 tokens)
# ---------------------------------------------------------------------------


class ProtocolAuthError(Exception):
    """A Protocol Auth token failed verification.

    ``reason`` is a short machine-readable code for logs; callers return a
    generic 401 so the failing check is not disclosed.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ProtocolAuthClaims:
    fid: int
    address: str  # EIP-55 checksummed signer address
    method: str  # LINK_METHOD_CUSTODY | LINK_METHOD_AUTH_ADDRESS
    domain: str
    nonce: str
    issued_at: datetime
    expires_at: datetime


@dataclass(frozen=True)
class ParsedProtocolAuthMessage:
    siwe: SiweMessage
    fid: int
    domain: str
    issued_at: datetime
    expires_at: datetime


def allowed_protocol_auth_domains(raw: str) -> set[str]:
    """Parse a comma-separated domain list (``QUICKAUTH_ALLOWED_AUDIENCES``)."""
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def _b64url_decode(segment: str) -> bytes:
    padded = segment + "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def decode_protocol_auth_token(token: str) -> tuple[str, bytes]:
    """Split an ``hqa1.<msg>.<sig>`` token into (SIWE message, signature)."""
    if not isinstance(token, str) or not token.startswith(PROTOCOL_AUTH_TOKEN_PREFIX):
        raise ProtocolAuthError("not_protocol_token")
    parts = token[len(PROTOCOL_AUTH_TOKEN_PREFIX) :].split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ProtocolAuthError("malformed_token")
    try:
        message = _b64url_decode(parts[0]).decode("utf-8")
        signature = _b64url_decode(parts[1])
    except (binascii.Error, UnicodeError, ValueError):
        raise ProtocolAuthError("malformed_token") from None
    if len(signature) != SECP256K1_SIGNATURE_BYTES:
        raise ProtocolAuthError("malformed_signature")
    return message, signature


def _parse_timestamp(value: object) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        raise ValueError("timestamp without timezone")
    return parsed


def _fid_from_resources(resources: list[str] | None) -> int:
    if not resources or len(resources) != 1:
        raise ProtocolAuthError("bad_resources")
    match = FID_RESOURCE_RE.match(str(resources[0]))
    if match is None:
        raise ProtocolAuthError("bad_resources")
    return int(match.group(1))


def _check_domain_and_uri(siwe_msg: SiweMessage, allowed_domains: set[str]) -> str:
    domain = (siwe_msg.domain or "").lower()
    if domain not in allowed_domains:
        raise ProtocolAuthError("domain_mismatch")
    uri = urlsplit(str(siwe_msg.uri))
    if uri.scheme not in ALLOWED_URI_SCHEMES or uri.netloc.lower() != domain:
        raise ProtocolAuthError("uri_mismatch")
    return domain


def _check_times(siwe_msg: SiweMessage, now: datetime) -> tuple[datetime, datetime]:
    try:
        issued_at = _parse_timestamp(siwe_msg.issued_at)
        expires_at = _parse_timestamp(siwe_msg.expiration_time)
        not_before = _parse_timestamp(siwe_msg.not_before)
    except ValueError:
        raise ProtocolAuthError("bad_timestamp") from None
    if issued_at is None or expires_at is None:
        raise ProtocolAuthError("missing_timestamp")
    now_ts = int(now.timestamp())
    iat = int(issued_at.timestamp())
    exp = int(expires_at.timestamp())
    if iat > now_ts + PROTOCOL_AUTH_CLOCK_SKEW_SECONDS:
        raise ProtocolAuthError("issued_in_future")
    if exp <= now_ts:
        raise ProtocolAuthError("expired")
    if exp - iat > PROTOCOL_AUTH_MAX_TTL_SECONDS:
        raise ProtocolAuthError("lifetime_too_long")
    if (
        not_before is not None
        and int(not_before.timestamp()) > now_ts + PROTOCOL_AUTH_CLOCK_SKEW_SECONDS
    ):
        raise ProtocolAuthError("not_yet_valid")
    return issued_at, expires_at


def parse_protocol_auth_message(
    message: str, *, allowed_domains: set[str], now: datetime
) -> ParsedProtocolAuthMessage:
    """Validate a token message's SIWE fields (no signature or link checks)."""
    try:
        siwe_msg = SiweMessage.from_message(message)
    except Exception:  # noqa: BLE001 - siwe raises a mix of parse errors
        raise ProtocolAuthError("unparseable_message") from None
    # Re-serializing must reproduce the signed text exactly, so no field can
    # hide in whitespace or ordering the parser tolerates.
    if siwe_msg.prepare_message() != message:
        raise ProtocolAuthError("non_canonical_message")
    domain = _check_domain_and_uri(siwe_msg, allowed_domains)
    if str(getattr(siwe_msg.version, "value", siwe_msg.version)) != "1":
        raise ProtocolAuthError("bad_version")
    if siwe_msg.chain_id != PROTOCOL_AUTH_CHAIN_ID:
        raise ProtocolAuthError("chain_id_mismatch")
    fid = _fid_from_resources(siwe_msg.resources)
    if siwe_msg.statement != PROTOCOL_AUTH_STATEMENT.format(fid=fid):
        raise ProtocolAuthError("bad_statement")
    if not siwe_msg.nonce:
        raise ProtocolAuthError("missing_nonce")
    issued_at, expires_at = _check_times(siwe_msg, now)
    return ParsedProtocolAuthMessage(
        siwe=siwe_msg,
        fid=fid,
        domain=domain,
        issued_at=issued_at,
        expires_at=expires_at,
    )


async def _link_method(fid: int, address: str) -> str:
    """How ``address`` is tied to ``fid``: custody or a keyType 2 key."""
    if await key_gateway.id_of(address) == fid:
        return LINK_METHOD_CUSTODY
    if await signer_registry.is_auth_address_active(fid, address):
        return LINK_METHOD_AUTH_ADDRESS
    raise ProtocolAuthError("signer_not_linked")


async def verify_protocol_auth_token(
    token: str,
    *,
    allowed_domains: set[str],
    now: datetime | None = None,
) -> ProtocolAuthClaims:
    """Verify an ``hqa1.`` Protocol Auth token (signature and linkage only).

    Checks, in order: token shape; canonical EIP-4361 message; domain and
    URI host in ``allowed_domains``; version 1; chain id 10; exactly one
    ``farcaster://fid/<fid>`` resource and the pinned statement; issued-at,
    expiry and not-before (5 min skew) with a 1h maximum lifetime; an
    EIP-191 signature recovering to the message address; that address is
    the FID's custody (``idOf``) or an added KeyRegistry auth address
    (keyType 2).

    Replay protection is the caller's: ``/v1/auth/protocol`` consumes the
    server-issued SIWF nonce, signer register binds the prepare nonce, and
    the miniapp exchange treats the token as a short-lived bearer
    credential that must not grant anything outliving ``expires_at``.

    Raises :class:`ProtocolAuthError` on any token failure and
    ``KeyGatewayError`` when the chain cannot be read.
    """
    current = now or datetime.now(timezone.utc)
    message, signature = decode_protocol_auth_token(token)
    domains = {domain.lower() for domain in allowed_domains}
    parsed = parse_protocol_auth_message(message, allowed_domains=domains, now=current)
    try:
        recovered = Account.recover_message(
            encode_defunct(text=message), signature=signature
        )
    except Exception:  # noqa: BLE001 - eth_account raises several types
        raise ProtocolAuthError("bad_signature") from None
    if recovered.lower() != parsed.siwe.address.lower():
        raise ProtocolAuthError("bad_signature")
    method = await _link_method(parsed.fid, recovered)
    return ProtocolAuthClaims(
        fid=parsed.fid,
        address=recovered,
        method=method,
        domain=parsed.domain,
        nonce=parsed.siwe.nonce,
        issued_at=parsed.issued_at,
        expires_at=parsed.expires_at,
    )


# ---------------------------------------------------------------------------
# Miniapp ``sdk.actions.signIn`` (SIWF) messages
# ---------------------------------------------------------------------------

# A miniapp sign-in message must be used within this long of ``issuedAt``
# (the server nonce it carries already expires after 5 minutes).
MINIAPP_SIWF_MAX_AGE_SECONDS = 10 * 60


def _check_miniapp_times(siwe_msg: SiweMessage, now: datetime) -> None:
    try:
        issued_at = _parse_timestamp(siwe_msg.issued_at)
        expires_at = _parse_timestamp(siwe_msg.expiration_time)
        not_before = _parse_timestamp(siwe_msg.not_before)
    except ValueError:
        raise ProtocolAuthError("bad_timestamp") from None
    if issued_at is None:
        raise ProtocolAuthError("missing_timestamp")
    now_ts = int(now.timestamp())
    iat = int(issued_at.timestamp())
    if iat > now_ts + PROTOCOL_AUTH_CLOCK_SKEW_SECONDS:
        raise ProtocolAuthError("issued_in_future")
    if now_ts - iat > MINIAPP_SIWF_MAX_AGE_SECONDS:
        raise ProtocolAuthError("expired")
    if expires_at is not None and int(expires_at.timestamp()) <= now_ts:
        raise ProtocolAuthError("expired")
    if (
        not_before is not None
        and int(not_before.timestamp()) > now_ts + PROTOCOL_AUTH_CLOCK_SKEW_SECONDS
    ):
        raise ProtocolAuthError("not_yet_valid")


async def verify_miniapp_siwf_message(
    message: str,
    signature: str,
    *,
    expected_nonce: str,
    allowed_domains: set[str],
    now: datetime | None = None,
) -> ProtocolAuthClaims:
    """Verify a miniapp ``signIn`` SIWF message for its ``farcaster://fid``.

    Checks: parseable EIP-4361; domain and URI host allowed; chain id 10;
    the message nonce equals ``expected_nonce`` (which the caller has
    already consumed); issued within :data:`MINIAPP_SIWF_MAX_AGE_SECONDS`,
    not expired and not before ``notBefore``; exactly one
    ``farcaster://fid/<fid>`` resource; EIP-191 signature recovers to the
    message address; and that address is the FID's custody or an added
    auth address. Raises :class:`ProtocolAuthError` on failure and
    ``KeyGatewayError`` when the chain cannot be read.
    """
    current = now or datetime.now(timezone.utc)
    try:
        siwe_msg = SiweMessage.from_message(message)
    except Exception:  # noqa: BLE001 - siwe raises a mix of parse errors
        raise ProtocolAuthError("unparseable_message") from None
    domains = {domain.lower() for domain in allowed_domains}
    domain = _check_domain_and_uri(siwe_msg, domains)
    if siwe_msg.chain_id != PROTOCOL_AUTH_CHAIN_ID:
        raise ProtocolAuthError("chain_id_mismatch")
    if not expected_nonce or siwe_msg.nonce != expected_nonce:
        raise ProtocolAuthError("nonce_mismatch")
    _check_miniapp_times(siwe_msg, current)
    fid = _fid_from_resources(siwe_msg.resources)
    try:
        recovered = Account.recover_message(
            encode_defunct(text=message), signature=signature
        )
    except Exception:  # noqa: BLE001 - eth_account raises several types
        raise ProtocolAuthError("bad_signature") from None
    if recovered.lower() != siwe_msg.address.lower():
        raise ProtocolAuthError("bad_signature")
    method = await _link_method(fid, recovered)
    issued_at = _parse_timestamp(siwe_msg.issued_at) or current
    expires_at = _parse_timestamp(siwe_msg.expiration_time)
    return ProtocolAuthClaims(
        fid=fid,
        address=recovered,
        method=method,
        domain=domain,
        nonce=siwe_msg.nonce,
        issued_at=issued_at,
        expires_at=expires_at or current,
    )
