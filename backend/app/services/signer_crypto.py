"""AES-256-GCM at-rest encryption and keygen for Ed25519 signer keys.

Shared by the managed bot signers (``bot_signer_service``) and the per-user
Hypersnap app signers. Every ciphertext binds an AAD (typically the owning
row id or FID) so a blob copied onto another row fails to decrypt.

Blob formats:

* ``v1:`` + ``base64url(nonce(12) || ciphertext || tag(16))`` — written by
  :func:`encrypt_private_key`. The GCM AAD is domain-separated by purpose,
  ``juke-signer:v1:<purpose>:<aad>``, so a user blob never decrypts as a
  bot blob (or vice versa) even under a shared key.
* ``v2:<kid>:`` + ``base64url(nonce || ciphertext || tag)`` — written for
  the user-key purposes when the ``SIGNER_ENCRYPTION_KEYS`` keyring is
  configured. ``kid`` names the keyring entry and is bound into the AAD,
  ``juke-signer:v2:<kid>:<purpose>:<aad>``, so a blob can't be re-labelled
  to another key id.
* Legacy (unversioned) ``base64url(nonce || ciphertext || tag)`` with the
  bare ``aad`` — bot blobs already stored in production. Still decrypted,
  for :data:`LEGACY_BLOB_PURPOSES` only; never written. ``:`` is outside the
  base64url alphabet, so the formats cannot be confused.

Key rotation (user-key purposes): ``SIGNER_ENCRYPTION_KEYS`` holds
``kid:key`` entries, first = active. ``v2`` blobs decrypt with the entry
their ``kid`` names; ``v1`` blobs (everything written before the keyring)
decrypt with ``SIGNER_ENCRYPTION_KEY``, falling back to each keyring key.
Bot blobs keep their dedicated explicit key and the ``v1`` format.

Security invariants:
* Plaintext private keys exist only in the caller's local scope and are
  never logged or included in exception messages.
* Key misconfiguration and decryption failures raise typed errors whose
  messages are generic; callers translate them to an opaque 503.
"""

from __future__ import annotations

import base64
import binascii
import re
import secrets
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from app.config import settings

AES_KEY_BYTES = 32
GCM_NONCE_BYTES = 12
ED25519_PRIVATE_KEY_BYTES = 32
BLOB_VERSION_V1_PREFIX = "v1:"
BLOB_VERSION_V2_PREFIX = "v2:"
V1_AAD_DOMAIN = "juke-signer:v1"
V2_AAD_DOMAIN = "juke-signer:v2"
KEYRING_ENTRY_SEPARATOR = ","
KEYRING_KID_SEPARATOR = ":"
# Key ids appear in every v2 blob and in the AAD; keep them short and inert.
KEY_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


class SignerPurpose(StrEnum):
    """Which population a signer key belongs to; bound into the v1 AAD."""

    USER = "user"
    BOT = "bot"
    # Upstream ``client.farcaster.xyz`` custody-minted bearer used for
    # Direct Casts (``farcaster_token_service``). Not a signer key, but the
    # same at-rest scheme, key and purpose-separated AAD.
    FARCASTER_TOKEN = "farcaster_token"
    # Per-subscription HMAC signing secret of an outbound developer webhook
    # (``dev_webhook_service``). AAD is the webhook row id.
    DEVELOPER_WEBHOOK_SECRET = "developer_webhook_secret"


# Only bot blobs predate the versioned format, so only they may be legacy.
LEGACY_BLOB_PURPOSES: frozenset[SignerPurpose] = frozenset({SignerPurpose.BOT})


class SignerKeyConfigError(Exception):
    """The AES key is missing or malformed. Caller → opaque 503.

    The message is intentionally generic and MUST NOT be surfaced to
    clients (it would confirm a server-side misconfiguration).
    """


class SignerDecryptError(Exception):
    """Decryption failed (tampered blob, wrong AAD, or wrong key).

    Caller → opaque 503. Never leak which of the three tripped.
    """


def decode_aes_key(raw: str) -> bytes:
    """Decode a configured AES-256 key.

    Accepts base64url, standard base64, or a raw 32-byte string. Any other
    length is rejected to keep a single AES-256 security tier. The raw value
    is never included in the error.
    """
    if not raw:
        raise SignerKeyConfigError("signer encryption key is not configured")
    padded = raw + "=" * (-len(raw) % 4)
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            decoded = decoder(padded)
        except (binascii.Error, ValueError):
            continue
        if len(decoded) == AES_KEY_BYTES:
            return decoded
    raw_bytes = raw.encode()
    if len(raw_bytes) == AES_KEY_BYTES:
        return raw_bytes
    raise SignerKeyConfigError(
        "signer encryption key must decode to exactly 32 bytes (AES-256)"
    )


@dataclass(frozen=True)
class UserKeyring:
    """Keys for the user-key purposes, parsed from settings.

    ``active_kid`` is the keyring entry new blobs are written with (``None``
    when no keyring is configured, so new blobs stay ``v1`` under
    ``legacy_key``). ``legacy_key`` is ``SIGNER_ENCRYPTION_KEY``.
    """

    active_kid: str | None
    keys: dict[str, bytes]
    legacy_key: bytes | None

    def v1_candidates(self) -> list[bytes]:
        """Keys that may have written a ``v1`` blob, legacy key first."""
        candidates = [self.legacy_key] if self.legacy_key is not None else []
        candidates.extend(k for k in self.keys.values() if k not in candidates)
        return candidates


def parse_keyring(raw: str) -> tuple[str | None, dict[str, bytes]]:
    """Parse ``"kid:key,kid:key"`` into ``(active_kid, {kid: key})``.

    The first entry is active. Raises :class:`SignerKeyConfigError` on a
    malformed entry, invalid or duplicate kid, or bad key — never echoing
    key material.
    """
    keys: dict[str, bytes] = {}
    active_kid: str | None = None
    for entry in raw.split(KEYRING_ENTRY_SEPARATOR):
        entry = entry.strip()
        if not entry:
            continue
        kid, separator, encoded = entry.partition(KEYRING_KID_SEPARATOR)
        kid = kid.strip()
        if not separator or not KEY_ID_PATTERN.match(kid):
            raise SignerKeyConfigError(
                "SIGNER_ENCRYPTION_KEYS entries must be '<kid>:<key>'"
            )
        if kid in keys:
            raise SignerKeyConfigError("SIGNER_ENCRYPTION_KEYS has a duplicate kid")
        keys[kid] = decode_aes_key(encoded.strip())
        active_kid = active_kid or kid
    return active_kid, keys


@lru_cache(maxsize=8)
def _build_user_keyring(keys_raw: str, legacy_raw: str) -> UserKeyring:
    active_kid, keys = parse_keyring(keys_raw) if keys_raw else (None, {})
    legacy_key = decode_aes_key(legacy_raw) if legacy_raw else None
    if active_kid is None and legacy_key is None:
        raise SignerKeyConfigError("SIGNER_ENCRYPTION_KEY is not configured")
    return UserKeyring(active_kid=active_kid, keys=keys, legacy_key=legacy_key)


def load_user_keyring() -> UserKeyring:
    """The configured user keyring. Raises :class:`SignerKeyConfigError`."""
    return _build_user_keyring(
        settings.SIGNER_ENCRYPTION_KEYS, settings.SIGNER_ENCRYPTION_KEY
    )


def load_signer_encryption_key() -> bytes:
    """Return the AES key new user-purpose blobs are encrypted with.

    The active ``SIGNER_ENCRYPTION_KEYS`` entry when a keyring is set, else
    ``SIGNER_ENCRYPTION_KEY``. There is deliberately no fallback to
    ``JUKE_BOT_SIGNER_ENCRYPTION_KEY``: user and bot keys stay separate
    secrets. Raises :class:`SignerKeyConfigError` when unset or malformed.
    """
    keyring = load_user_keyring()
    if keyring.active_kid is not None:
        return keyring.keys[keyring.active_kid]
    assert keyring.legacy_key is not None  # guaranteed by _build_user_keyring
    return keyring.legacy_key


def _v1_aad(purpose: SignerPurpose, aad: str) -> bytes:
    return f"{V1_AAD_DOMAIN}:{purpose.value}:{aad}".encode()


def _v2_aad(kid: str, purpose: SignerPurpose, aad: str) -> bytes:
    return f"{V2_AAD_DOMAIN}:{kid}:{purpose.value}:{aad}".encode()


_USER_KEY_PURPOSES: frozenset[SignerPurpose] = frozenset(
    {
        SignerPurpose.USER,
        SignerPurpose.FARCASTER_TOKEN,
        SignerPurpose.DEVELOPER_WEBHOOK_SECRET,
    }
)


def _require_user_purpose(purpose: SignerPurpose) -> None:
    if purpose not in _USER_KEY_PURPOSES:
        raise SignerKeyConfigError("bot signer blobs require an explicit key")


def _seal(key: bytes, plaintext: bytes, aad: bytes) -> str:
    nonce = secrets.token_bytes(GCM_NONCE_BYTES)
    return base64.urlsafe_b64encode(
        nonce + AESGCM(key).encrypt(nonce, plaintext, aad)
    ).decode()


def _open(key: bytes, encoded: str, aad: bytes) -> bytes:
    """Raises ``ValueError``/``InvalidTag``; callers collapse them."""
    payload = base64.urlsafe_b64decode(encoded.encode())
    nonce, ciphertext = payload[:GCM_NONCE_BYTES], payload[GCM_NONCE_BYTES:]
    return AESGCM(key).decrypt(nonce, ciphertext, aad)


def _decrypt_error() -> SignerDecryptError:
    return SignerDecryptError("signer private key cannot be decrypted")


def encrypt_private_key(
    raw32: bytes,
    *,
    aad: str,
    purpose: SignerPurpose,
    key: bytes | None = None,
) -> str:
    """AES-256-GCM-encrypt a 32-byte Ed25519 private key bound to ``aad``.

    Writes ``v2:<kid>:`` under the active keyring entry when one is
    configured, else ``v1:`` (always with a purpose-separated AAD). Bot
    callers pass their dedicated ``key`` explicitly and always get ``v1:``.
    """
    if len(raw32) != ED25519_PRIVATE_KEY_BYTES:
        raise ValueError("Ed25519 private key must be exactly 32 bytes")
    return encrypt_secret(raw32, aad=aad, purpose=purpose, key=key)


def encrypt_secret(
    plaintext: bytes,
    *,
    aad: str,
    purpose: SignerPurpose,
    key: bytes | None = None,
) -> str:
    """AES-256-GCM-encrypt arbitrary secret bytes as a versioned blob.

    Same format and AAD domain as :func:`encrypt_private_key`, without the
    32-byte length check. Pair with :func:`decrypt_private_key`, which
    returns the plaintext bytes unchanged.
    """
    if not plaintext:
        raise ValueError("secret must be non-empty")
    if key is not None:
        return BLOB_VERSION_V1_PREFIX + _seal(key, plaintext, _v1_aad(purpose, aad))
    _require_user_purpose(purpose)
    keyring = load_user_keyring()
    if keyring.active_kid is None:
        assert keyring.legacy_key is not None  # guaranteed by _build_user_keyring
        return BLOB_VERSION_V1_PREFIX + _seal(
            keyring.legacy_key, plaintext, _v1_aad(purpose, aad)
        )
    kid = keyring.active_kid
    sealed = _seal(keyring.keys[kid], plaintext, _v2_aad(kid, purpose, aad))
    return f"{BLOB_VERSION_V2_PREFIX}{kid}{KEYRING_KID_SEPARATOR}{sealed}"


def decrypt_private_key(
    blob: str,
    *,
    aad: str,
    purpose: SignerPurpose,
    key: bytes | None = None,
) -> bytes:
    """Inverse of :func:`encrypt_private_key`; reads every blob ever written.

    ``v2`` blobs use the keyring entry their kid names; ``v1`` blobs use the
    explicit ``key``, or for user purposes ``SIGNER_ENCRYPTION_KEY`` then
    each keyring key; unversioned blobs only for
    :data:`LEGACY_BLOB_PURPOSES` with an explicit key.

    Raises :class:`SignerDecryptError` on any failure (tamper, wrong AAD,
    wrong purpose, wrong key, unknown kid, malformed blob, or a legacy blob
    for a purpose that never had one).
    """
    if blob.startswith(BLOB_VERSION_V2_PREFIX):
        candidates, encoded, bound_aad = _v2_decrypt_inputs(blob, purpose, aad, key)
    elif blob.startswith(BLOB_VERSION_V1_PREFIX):
        encoded = blob.removeprefix(BLOB_VERSION_V1_PREFIX)
        bound_aad = _v1_aad(purpose, aad)
        candidates = [key] if key is not None else _user_v1_candidates(purpose)
    elif purpose in LEGACY_BLOB_PURPOSES and key is not None:
        encoded = blob
        bound_aad = aad.encode()
        candidates = [key]
    else:
        raise _decrypt_error()
    for candidate in candidates:
        try:
            return _open(candidate, encoded, bound_aad)
        except (ValueError, InvalidTag):
            # Never chain: do not reveal which check failed.
            continue
    raise _decrypt_error()


def _user_v1_candidates(purpose: SignerPurpose) -> list[bytes]:
    _require_user_purpose(purpose)
    return load_user_keyring().v1_candidates()


def _v2_decrypt_inputs(
    blob: str, purpose: SignerPurpose, aad: str, key: bytes | None
) -> tuple[list[bytes], str, bytes]:
    """``(candidate_keys, encoded_payload, aad)`` for a ``v2:<kid>:`` blob."""
    if key is not None:
        # v2 is only ever written from the keyring; an explicit key (bots)
        # never produced one.
        raise _decrypt_error()
    _require_user_purpose(purpose)
    kid, separator, encoded = blob.removeprefix(BLOB_VERSION_V2_PREFIX).partition(
        KEYRING_KID_SEPARATOR
    )
    keyring = load_user_keyring()
    if not separator or kid not in keyring.keys:
        raise _decrypt_error()
    return [keyring.keys[kid]], encoded, _v2_aad(kid, purpose, aad)


def generate_ed25519_keypair() -> tuple[bytes, str]:
    """Return ``(raw_private_32, public_key_hex)`` for a fresh Ed25519 key.

    ``public_key_hex`` is ``0x``-prefixed. The raw private bytes stay in the
    caller's local scope; they are never returned to a client or logged.
    """
    private_key = ed25519.Ed25519PrivateKey.generate()
    raw_private = private_key.private_bytes(
        Encoding.Raw, PrivateFormat.Raw, NoEncryption()
    )
    raw_public = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return raw_private, "0x" + raw_public.hex()
