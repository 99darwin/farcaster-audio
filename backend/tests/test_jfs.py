"""Tests for JFS bearer minting + decoding (``app.services.jfs``).

Pins the contract that a minted bearer:
* round-trips through ``decode_jfs_bearer`` (structural + claim shape),
* carries an Ed25519 signature that verifies over ``"<h>.<p>"``,
* emits the documented audience/timestamp/exp claims,
* uses base64url WITHOUT padding (byte-parity with the mobile signer),
and that ``decode_jfs_bearer`` rejects malformed / stale / wrong-audience
bearers.
"""

import base64
import json
from datetime import datetime, timezone

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.services.jfs import (
    JFS_EXPECTED_AUDIENCE,
    decode_jfs_bearer,
    mint_jfs_bearer,
)

FID = 12345


def _keypair() -> tuple[ed25519.Ed25519PrivateKey, str]:
    priv = ed25519.Ed25519PrivateKey.generate()
    raw_pub = priv.public_key().public_bytes(
        encoding=Encoding.Raw, format=PublicFormat.Raw
    )
    return priv, "0x" + raw_pub.hex()


def _b64url_decode(seg: str) -> bytes:
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def test_mint_decode_roundtrip():
    priv, pub_hex = _keypair()
    bearer = mint_jfs_bearer(fid=FID, private_key=priv, public_key_hex=pub_hex)
    assert decode_jfs_bearer(bearer) == FID


def test_signature_verifies_over_header_dot_payload():
    priv, pub_hex = _keypair()
    bearer = mint_jfs_bearer(fid=FID, private_key=priv, public_key_hex=pub_hex)
    header_b64, payload_b64, sig_b64 = bearer.split(".")

    raw_pub = bytes.fromhex(pub_hex[2:])
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(raw_pub)
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    # Raises InvalidSignature if it doesn't verify — no assert needed.
    public_key.verify(_b64url_decode(sig_b64), signing_input)


def test_signature_rejects_tampered_payload():
    priv, pub_hex = _keypair()
    bearer = mint_jfs_bearer(fid=FID, private_key=priv, public_key_hex=pub_hex)
    header_b64, payload_b64, sig_b64 = bearer.split(".")
    raw_pub = bytes.fromhex(pub_hex[2:])
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(raw_pub)
    # Flip the signing input; the signature must no longer verify.
    tampered = f"{header_b64}.{payload_b64}x".encode("ascii")
    from cryptography.exceptions import InvalidSignature

    with pytest.raises(InvalidSignature):
        public_key.verify(_b64url_decode(sig_b64), tampered)


def test_header_and_payload_claims():
    priv, pub_hex = _keypair()
    before = int(datetime.now(tz=timezone.utc).timestamp())
    bearer = mint_jfs_bearer(fid=FID, private_key=priv, public_key_hex=pub_hex)
    after = int(datetime.now(tz=timezone.utc).timestamp())
    header_b64, payload_b64, _ = bearer.split(".")

    header = json.loads(_b64url_decode(header_b64))
    payload = json.loads(_b64url_decode(payload_b64))

    assert header == {"fid": FID, "type": "app_key", "key": pub_hex}
    assert payload["audience"] == JFS_EXPECTED_AUDIENCE
    assert before <= payload["timestamp"] <= after
    assert payload["exp"] == payload["timestamp"] + 300


def test_header_field_order_matches_mobile():
    """Field order must mirror the mobile signer: fid, type, key."""
    priv, pub_hex = _keypair()
    bearer = mint_jfs_bearer(fid=FID, private_key=priv, public_key_hex=pub_hex)
    header_b64, payload_b64, _ = bearer.split(".")
    header_raw = _b64url_decode(header_b64).decode()
    payload_raw = _b64url_decode(payload_b64).decode()
    assert header_raw == f'{{"fid":{FID},"type":"app_key","key":"{pub_hex}"}}'
    # Payload order: audience, timestamp, exp — and compact (no spaces).
    assert payload_raw.startswith('{"audience":"')
    assert '", ' not in payload_raw  # compact separators, no spaces


def test_no_base64_padding():
    priv, pub_hex = _keypair()
    bearer = mint_jfs_bearer(fid=FID, private_key=priv, public_key_hex=pub_hex)
    assert "=" not in bearer
    for seg in bearer.split("."):
        assert not seg.endswith("=")


def test_custom_ttl_reflected_in_exp():
    priv, pub_hex = _keypair()
    bearer = mint_jfs_bearer(
        fid=FID, private_key=priv, public_key_hex=pub_hex, ttl_seconds=60
    )
    _, payload_b64, _ = bearer.split(".")
    payload = json.loads(_b64url_decode(payload_b64))
    assert payload["exp"] == payload["timestamp"] + 60


def test_mint_rejects_bad_inputs():
    priv, pub_hex = _keypair()
    with pytest.raises(ValueError):
        mint_jfs_bearer(fid=0, private_key=priv, public_key_hex=pub_hex)
    with pytest.raises(ValueError):
        mint_jfs_bearer(
            fid=FID, private_key=priv, public_key_hex=pub_hex, ttl_seconds=0
        )


# ---------------------------------------------------------------------------
# decode_jfs_bearer rejection cases
# ---------------------------------------------------------------------------


def _make_bearer(header: dict, payload: dict) -> str:
    def enc(obj: dict) -> str:
        raw = json.dumps(obj, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    # Signature is irrelevant to decode (verification is upstream).
    return f"{enc(header)}.{enc(payload)}.{base64.urlsafe_b64encode(b'sig').rstrip(b'=').decode()}"


def _valid_pair(now: int) -> tuple[dict, dict]:
    header = {"fid": FID, "type": "app_key", "key": "0x" + "ab" * 32}
    payload = {
        "audience": JFS_EXPECTED_AUDIENCE,
        "timestamp": now,
        "exp": now + 300,
    }
    return header, payload


def test_decode_rejects_wrong_segment_count():
    with pytest.raises(ValueError):
        decode_jfs_bearer("only.two")


def test_decode_rejects_bad_audience():
    now = int(datetime.now(tz=timezone.utc).timestamp())
    header, payload = _valid_pair(now)
    payload["audience"] = "https://evil.example"
    with pytest.raises(ValueError):
        decode_jfs_bearer(_make_bearer(header, payload))


def test_decode_rejects_expired():
    now = int(datetime.now(tz=timezone.utc).timestamp())
    header, payload = _valid_pair(now)
    payload["exp"] = now - 1
    with pytest.raises(ValueError):
        decode_jfs_bearer(_make_bearer(header, payload))


def test_decode_rejects_missing_exp():
    now = int(datetime.now(tz=timezone.utc).timestamp())
    header, payload = _valid_pair(now)
    del payload["exp"]
    with pytest.raises(ValueError):
        decode_jfs_bearer(_make_bearer(header, payload))


def test_decode_rejects_future_timestamp_beyond_skew():
    now = int(datetime.now(tz=timezone.utc).timestamp())
    header, payload = _valid_pair(now)
    payload["timestamp"] = now + 10_000
    payload["exp"] = now + 10_300
    with pytest.raises(ValueError):
        decode_jfs_bearer(_make_bearer(header, payload))


def test_decode_rejects_nonpositive_fid():
    now = int(datetime.now(tz=timezone.utc).timestamp())
    header, payload = _valid_pair(now)
    header["fid"] = 0
    with pytest.raises(ValueError):
        decode_jfs_bearer(_make_bearer(header, payload))


def test_decode_rejects_malformed_base64():
    with pytest.raises(ValueError):
        decode_jfs_bearer("!!!.@@@.###")
