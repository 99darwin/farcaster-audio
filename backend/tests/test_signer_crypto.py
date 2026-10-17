"""Tests for app.services.signer_crypto (versioned AES-GCM blobs, keygen)."""

from __future__ import annotations

import base64
import os

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.services import signer_crypto


def _b64_key() -> tuple[bytes, str]:
    raw = os.urandom(32)
    return raw, base64.urlsafe_b64encode(raw).decode()


USER = signer_crypto.SignerPurpose.USER
BOT = signer_crypto.SignerPurpose.BOT


def _legacy_blob(secret: bytes, *, aad: str, key: bytes) -> str:
    """Unversioned blob exactly as bot_signer_service wrote it before v1."""
    nonce = os.urandom(signer_crypto.GCM_NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(nonce, secret, aad.encode())
    return base64.urlsafe_b64encode(nonce + ciphertext).decode()


@pytest.mark.parametrize("purpose", [USER, BOT])
def test_roundtrip_with_explicit_key(purpose):
    key, _ = _b64_key()
    secret = os.urandom(32)
    blob = signer_crypto.encrypt_private_key(
        secret, aad="user:7", purpose=purpose, key=key
    )
    assert blob.startswith(signer_crypto.BLOB_VERSION_V1_PREFIX)
    assert secret.hex() not in blob
    assert (
        signer_crypto.decrypt_private_key(blob, aad="user:7", purpose=purpose, key=key)
        == secret
    )


def test_v1_aad_is_domain_separated():
    key, _ = _b64_key()
    secret = os.urandom(32)
    blob = signer_crypto.encrypt_private_key(secret, aad="7", purpose=USER, key=key)
    payload = base64.urlsafe_b64decode(blob.removeprefix("v1:"))
    nonce, ciphertext = payload[:12], payload[12:]
    # The raw AAD alone (legacy binding) must not open a v1 blob.
    with pytest.raises(InvalidTag):
        AESGCM(key).decrypt(nonce, ciphertext, b"7")
    assert AESGCM(key).decrypt(nonce, ciphertext, b"juke-signer:v1:user:7") == secret


def test_cross_purpose_rejected():
    key, _ = _b64_key()
    user_blob = signer_crypto.encrypt_private_key(
        os.urandom(32), aad="42", purpose=USER, key=key
    )
    bot_blob = signer_crypto.encrypt_private_key(
        os.urandom(32), aad="42", purpose=BOT, key=key
    )
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(user_blob, aad="42", purpose=BOT, key=key)
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(bot_blob, aad="42", purpose=USER, key=key)


def test_legacy_bot_blob_still_decrypts():
    key, _ = _b64_key()
    secret = os.urandom(32)
    legacy = _legacy_blob(secret, aad="bot-uuid", key=key)
    assert not legacy.startswith(signer_crypto.BLOB_VERSION_V1_PREFIX)
    assert (
        signer_crypto.decrypt_private_key(legacy, aad="bot-uuid", purpose=BOT, key=key)
        == secret
    )
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(
            legacy, aad="other-uuid", purpose=BOT, key=key
        )


def test_legacy_blob_rejected_for_user_purpose():
    key, _ = _b64_key()
    legacy = _legacy_blob(os.urandom(32), aad="7", key=key)
    with pytest.raises(signer_crypto.SignerDecryptError) as info:
        signer_crypto.decrypt_private_key(legacy, aad="7", purpose=USER, key=key)
    assert info.value.__cause__ is None


def test_nonce_is_random():
    key, _ = _b64_key()
    secret = os.urandom(32)
    first = signer_crypto.encrypt_private_key(secret, aad="a", purpose=USER, key=key)
    second = signer_crypto.encrypt_private_key(secret, aad="a", purpose=USER, key=key)
    assert first != second


def test_wrong_aad_rejected():
    key, _ = _b64_key()
    blob = signer_crypto.encrypt_private_key(
        os.urandom(32), aad="user:7", purpose=USER, key=key
    )
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(blob, aad="user:8", purpose=USER, key=key)


def test_wrong_key_and_garbage_rejected():
    key, _ = _b64_key()
    other, _ = _b64_key()
    blob = signer_crypto.encrypt_private_key(
        os.urandom(32), aad="x", purpose=USER, key=key
    )
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(blob, aad="x", purpose=USER, key=other)
    for garbage in ("not-base64!!", "v1:not-base64!!"):
        with pytest.raises(signer_crypto.SignerDecryptError):
            signer_crypto.decrypt_private_key(garbage, aad="x", purpose=BOT, key=key)


def test_rejects_wrong_length_plaintext():
    key, _ = _b64_key()
    with pytest.raises(ValueError):
        signer_crypto.encrypt_private_key(b"short", aad="x", purpose=USER, key=key)


def test_user_purpose_defaults_to_signer_key(monkeypatch):
    raw, encoded = _b64_key()
    _, bot_key = _b64_key()
    monkeypatch.setattr(signer_crypto.settings, "SIGNER_ENCRYPTION_KEY", encoded)
    monkeypatch.setattr(
        signer_crypto.settings, "JUKE_BOT_SIGNER_ENCRYPTION_KEY", bot_key
    )
    assert signer_crypto.load_signer_encryption_key() == raw
    secret = os.urandom(32)
    blob = signer_crypto.encrypt_private_key(secret, aad="u", purpose=USER)
    assert (
        signer_crypto.decrypt_private_key(blob, aad="u", purpose=USER, key=raw)
        == secret
    )


def test_user_key_does_not_fall_back_to_bot_key(monkeypatch):
    _, bot_key = _b64_key()
    monkeypatch.setattr(signer_crypto.settings, "SIGNER_ENCRYPTION_KEY", "")
    monkeypatch.setattr(
        signer_crypto.settings, "JUKE_BOT_SIGNER_ENCRYPTION_KEY", bot_key
    )
    with pytest.raises(signer_crypto.SignerKeyConfigError):
        signer_crypto.load_signer_encryption_key()
    with pytest.raises(signer_crypto.SignerKeyConfigError):
        signer_crypto.encrypt_private_key(os.urandom(32), aad="u", purpose=USER)


def test_bot_purpose_requires_explicit_key():
    with pytest.raises(signer_crypto.SignerKeyConfigError):
        signer_crypto.encrypt_private_key(os.urandom(32), aad="b", purpose=BOT)


def test_generate_keypair():
    private, public_hex = signer_crypto.generate_ed25519_keypair()
    assert len(private) == 32
    derived = ed25519.Ed25519PrivateKey.from_private_bytes(private).public_key()
    assert public_hex == "0x" + derived.public_bytes_raw().hex()


# ---------------------------------------------------------------------------
# Keyring (SIGNER_ENCRYPTION_KEYS) — rotation without breaking stored blobs
# ---------------------------------------------------------------------------

FARCASTER_TOKEN = signer_crypto.SignerPurpose.FARCASTER_TOKEN
WEBHOOK_SECRET = signer_crypto.SignerPurpose.DEVELOPER_WEBHOOK_SECRET

# Golden vectors produced by the pre-keyring implementation (origin/main
# cde17b1f) with key bytes(range(32)) — i.e. byte-for-byte what production
# stores today. They must keep decrypting forever.
GOLDEN_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
GOLDEN_PLAINTEXT = bytes(range(100, 132))
GOLDEN_USER_V1 = (
    "v1:dfAu7N5kbV_CqQ6uexUMF7uON5hPEnl7OjmDsRT_b4A1dTNMgYHhny3G_imH4ICbZ1fw34oQ"
    "P9gGOPl2"
)
GOLDEN_TOKEN_V1 = "v1:egwJSTgzk1lTU_2LZdK7Ipjy-ua6KDyp83DRYaUXGNf-F2lmYz7JQtB8zQ=="
GOLDEN_BOT_V1 = (
    "v1:v_n_yOZhlooSa_O3j5oWu1Qkyaa0w7_WK1bhAKTeF131RMKJVdprHfCEUFxIwmIh7lvsvTTD"
    "NLD_CMfZ"
)
GOLDEN_BOT_LEGACY = (
    "AAAAAAAAAAAAAAAAatnTud1F6dZkxcdaaF3j6qY2ICRQ-BpU_OPN_EV-39VF8kIbuZvM3GNW_o7j"
    "hcYA"
)


def _set_keys(monkeypatch, *, legacy: str = "", keyring: str = "") -> None:
    monkeypatch.setattr(signer_crypto.settings, "SIGNER_ENCRYPTION_KEY", legacy)
    monkeypatch.setattr(signer_crypto.settings, "SIGNER_ENCRYPTION_KEYS", keyring)


def test_golden_v1_user_and_token_blobs_decrypt_without_keyring(monkeypatch):
    _set_keys(monkeypatch, legacy=GOLDEN_KEY_B64)
    assert (
        signer_crypto.decrypt_private_key(GOLDEN_USER_V1, aad="prep-123", purpose=USER)
        == GOLDEN_PLAINTEXT
    )
    assert (
        signer_crypto.decrypt_private_key(
            GOLDEN_TOKEN_V1, aad="fid:42", purpose=FARCASTER_TOKEN
        )
        == b'{"token":"abc"}'
    )


def test_golden_v1_blobs_decrypt_with_keyring_active(monkeypatch):
    """Turning on a keyring with a NEW key must not orphan any v1 blob."""
    _, new_key = _b64_key()
    _set_keys(monkeypatch, legacy=GOLDEN_KEY_B64, keyring=f"k2:{new_key}")
    assert (
        signer_crypto.decrypt_private_key(GOLDEN_USER_V1, aad="prep-123", purpose=USER)
        == GOLDEN_PLAINTEXT
    )
    assert (
        signer_crypto.decrypt_private_key(
            GOLDEN_TOKEN_V1, aad="fid:42", purpose=FARCASTER_TOKEN
        )
        == b'{"token":"abc"}'
    )


def test_golden_v1_blobs_decrypt_when_old_key_moved_into_keyring(monkeypatch):
    """Ops may retire SIGNER_ENCRYPTION_KEY by listing it in the keyring."""
    _, new_key = _b64_key()
    _set_keys(monkeypatch, keyring=f"k2:{new_key},k1:{GOLDEN_KEY_B64}")
    assert (
        signer_crypto.decrypt_private_key(GOLDEN_USER_V1, aad="prep-123", purpose=USER)
        == GOLDEN_PLAINTEXT
    )


def test_golden_bot_blobs_unaffected_by_keyring(monkeypatch):
    _, new_key = _b64_key()
    _set_keys(monkeypatch, legacy=GOLDEN_KEY_B64, keyring=f"k2:{new_key}")
    golden_key = base64.urlsafe_b64decode(GOLDEN_KEY_B64)
    for blob in (GOLDEN_BOT_V1, GOLDEN_BOT_LEGACY):
        assert (
            signer_crypto.decrypt_private_key(
                blob, aad="bot-1", purpose=BOT, key=golden_key
            )
            == GOLDEN_PLAINTEXT
        )
    # Bots still write v1 with their explicit key.
    blob = signer_crypto.encrypt_private_key(
        GOLDEN_PLAINTEXT, aad="bot-1", purpose=BOT, key=golden_key
    )
    assert blob.startswith(signer_crypto.BLOB_VERSION_V1_PREFIX)


def test_no_keyring_still_writes_v1(monkeypatch):
    raw, encoded = _b64_key()
    _set_keys(monkeypatch, legacy=encoded)
    blob = signer_crypto.encrypt_secret(b"tok", aad="fid:1", purpose=FARCASTER_TOKEN)
    assert blob.startswith(signer_crypto.BLOB_VERSION_V1_PREFIX)
    # Readable by the pre-keyring algorithm (explicit key, v1 AAD).
    assert (
        signer_crypto.decrypt_private_key(
            blob, aad="fid:1", purpose=FARCASTER_TOKEN, key=raw
        )
        == b"tok"
    )


@pytest.mark.parametrize("purpose", [USER, FARCASTER_TOKEN, WEBHOOK_SECRET])
def test_keyring_writes_v2_with_active_kid_and_round_trips(monkeypatch, purpose):
    _, legacy = _b64_key()
    _, active = _b64_key()
    _, older = _b64_key()
    _set_keys(monkeypatch, legacy=legacy, keyring=f"k3:{active},k2:{older}")
    blob = signer_crypto.encrypt_secret(b"secret", aad="row-1", purpose=purpose)
    assert blob.startswith("v2:k3:")
    assert (
        signer_crypto.decrypt_private_key(blob, aad="row-1", purpose=purpose)
        == b"secret"
    )
    assert signer_crypto.load_signer_encryption_key() == base64.urlsafe_b64decode(
        active
    )


def test_v2_blob_from_retired_active_key_still_decrypts(monkeypatch):
    _, k1 = _b64_key()
    _, k2 = _b64_key()
    _set_keys(monkeypatch, keyring=f"k1:{k1}")
    blob = signer_crypto.encrypt_secret(b"s", aad="a", purpose=USER)
    _set_keys(monkeypatch, keyring=f"k2:{k2},k1:{k1}")
    assert signer_crypto.decrypt_private_key(blob, aad="a", purpose=USER) == b"s"
    new_blob = signer_crypto.encrypt_secret(b"s", aad="a", purpose=USER)
    assert new_blob.startswith("v2:k2:")


def test_v2_unknown_kid_and_relabel_rejected(monkeypatch):
    _, k1 = _b64_key()
    _, k2 = _b64_key()
    _set_keys(monkeypatch, keyring=f"k1:{k1},k2:{k2}")
    blob = signer_crypto.encrypt_secret(b"s", aad="a", purpose=USER)
    # The kid is bound into the AAD: relabelling to another entry fails.
    relabelled = blob.replace("v2:k1:", "v2:k2:", 1)
    for bad in (relabelled, blob.replace("v2:k1:", "v2:k9:", 1), "v2:k1", "v2:"):
        with pytest.raises(signer_crypto.SignerDecryptError):
            signer_crypto.decrypt_private_key(bad, aad="a", purpose=USER)
    # Wrong AAD and wrong purpose are still rejected.
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(blob, aad="b", purpose=USER)
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(blob, aad="a", purpose=FARCASTER_TOKEN)


def test_v2_blob_rejected_with_explicit_key(monkeypatch):
    raw, k1 = _b64_key()
    _set_keys(monkeypatch, keyring=f"k1:{k1}")
    blob = signer_crypto.encrypt_secret(b"s", aad="a", purpose=USER)
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(blob, aad="a", purpose=USER, key=raw)


@pytest.mark.parametrize(
    "raw",
    [
        "nokid",
        ":AAAA",
        "bad kid:" + GOLDEN_KEY_B64,
        "k1:short",
        f"k1:{GOLDEN_KEY_B64},k1:{GOLDEN_KEY_B64}",
    ],
)
def test_malformed_keyring_is_config_error(monkeypatch, raw):
    _set_keys(monkeypatch, legacy=GOLDEN_KEY_B64, keyring=raw)
    with pytest.raises(signer_crypto.SignerKeyConfigError) as info:
        signer_crypto.encrypt_secret(b"s", aad="a", purpose=USER)
    assert GOLDEN_KEY_B64 not in str(info.value)


def test_keyring_only_without_legacy_key_cannot_open_unknown_v1(monkeypatch):
    _, k1 = _b64_key()
    _set_keys(monkeypatch, keyring=f"k1:{k1}")
    with pytest.raises(signer_crypto.SignerDecryptError):
        signer_crypto.decrypt_private_key(GOLDEN_USER_V1, aad="prep-123", purpose=USER)
