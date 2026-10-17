"""Verification of Farcaster Mini App webhook events (JSON Farcaster Signatures).

Farcaster clients POST server events (``miniapp_added``, ``notifications_
enabled`` …) to the Mini App's webhook URL as a JFS envelope::

    {"header": b64url(json), "payload": b64url(json), "signature": b64url(sig)}

The header is ``{"fid": int, "type": "app_key", "key": "0x<ed25519 pubkey>"}``
and the signature is Ed25519 over the ASCII bytes ``"<header>.<payload>"``
(the base64url strings, not the decoded JSON). An event is authentic only
when the signature verifies under ``header.key`` *and* that key is an active
KeyRegistry app key (keyType 1) of ``header.fid`` — otherwise anyone could
mint a key pair and claim any FID.

See https://miniapps.farcaster.xyz/docs/guides/notifications.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pydantic import BaseModel, Field

from app.services import signer_registry

JFS_TYPE_APP_KEY = "app_key"
ED25519_SIGNATURE_BYTES = 64
_ED25519_KEY_PATTERN = re.compile(r"^0x[0-9a-fA-F]{64}$")
_BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]*={0,2}$")

# Generous bounds on the encoded parts; real envelopes are a few hundred bytes.
MAX_JFS_HEADER_CHARS = 1024
MAX_JFS_PAYLOAD_CHARS = 8 * 1024
MAX_JFS_SIGNATURE_CHARS = 256


class JfsEnvelope(BaseModel):
    """The raw JFS envelope, exactly as the Farcaster client sent it."""

    header: str = Field(min_length=1, max_length=MAX_JFS_HEADER_CHARS)
    payload: str = Field(min_length=1, max_length=MAX_JFS_PAYLOAD_CHARS)
    signature: str = Field(min_length=1, max_length=MAX_JFS_SIGNATURE_CHARS)


class JfsVerificationError(Exception):
    """The envelope is malformed or its signature does not verify."""


@dataclass(frozen=True)
class VerifiedJfs:
    """A JFS whose Ed25519 signature verified under ``key``.

    ``key`` is not yet known to belong to ``fid``; see
    :func:`is_app_key_active_for_fid`.
    """

    fid: int
    key: str
    payload: dict[str, Any]


def _decode_base64url(value: str) -> bytes:
    if not _BASE64URL_PATTERN.fullmatch(value):
        raise JfsVerificationError("invalid base64url encoding")
    stripped = value.rstrip("=")
    try:
        return base64.urlsafe_b64decode(stripped + "=" * (-len(stripped) % 4))
    except (binascii.Error, ValueError):
        raise JfsVerificationError("invalid base64url encoding") from None


def _decode_json_object(value: str) -> dict[str, Any]:
    try:
        decoded = json.loads(_decode_base64url(value))
    except (UnicodeDecodeError, ValueError):
        raise JfsVerificationError("invalid JSON") from None
    if not isinstance(decoded, dict):
        raise JfsVerificationError("expected a JSON object")
    return decoded


def verify_jfs_signature(envelope: JfsEnvelope) -> VerifiedJfs:
    """Check structure and the Ed25519 signature of an ``app_key`` JFS.

    Raises :class:`JfsVerificationError` on any failure. Pure (no I/O).
    """
    header = _decode_json_object(envelope.header)
    fid = header.get("fid")
    # bool is an int subclass; ``{"fid": true}`` must not read as FID 1.
    if not isinstance(fid, int) or isinstance(fid, bool) or fid <= 0:
        raise JfsVerificationError("invalid fid")
    if header.get("type") != JFS_TYPE_APP_KEY:
        raise JfsVerificationError("unsupported signature type")
    key = header.get("key")
    if not isinstance(key, str) or not _ED25519_KEY_PATTERN.fullmatch(key):
        raise JfsVerificationError("invalid key")

    # Decoded before verifying so a non-base64url payload can't reach the
    # ASCII encode of the signed input below.
    payload = _decode_json_object(envelope.payload)
    signature = _decode_base64url(envelope.signature)
    if len(signature) != ED25519_SIGNATURE_BYTES:
        raise JfsVerificationError("invalid signature length")

    signed_input = f"{envelope.header}.{envelope.payload}".encode("ascii")
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(key[2:])).verify(
            signature, signed_input
        )
    except (InvalidSignature, ValueError):
        raise JfsVerificationError("signature verification failed") from None

    return VerifiedJfs(fid=fid, key=key.lower(), payload=payload)


async def is_app_key_active_for_fid(fid: int, key: str) -> bool:
    """True when ``key`` is an active on-chain app key (keyType 1) of ``fid``.

    Upstream failures propagate as ``HypersnapError`` so callers can answer
    5xx (the client retries) instead of treating an outage as "not a key".
    """
    return await signer_registry.is_ed25519_signer_active(fid, key)
