"""JSON Farcaster Signature (JFS) bearer minting + decoding.

A JFS bearer authorizes a request against ``client.farcaster.xyz``
(audio-rooms, channel writes, etc.). Wire format:

    ``<headerB64>.<payloadB64>.<sigB64>``

where each part is base64url-encoded (no padding). Header carries
``{"fid": <int>, "type": "app_key", "key": "0x<pubkey>"}``; payload
carries ``{"audience": "https://client.farcaster.xyz",
"timestamp": <epoch_seconds>, "exp": <epoch_seconds>}``. The signature
is Ed25519 over the ASCII bytes of ``"<headerB64>.<payloadB64>"``.

``decode_jfs_bearer`` validates the structural + claim shape of a
*user-supplied* bearer (signature verification is delegated upstream).
``mint_jfs_bearer`` produces a fresh bearer from a Juke-held managed
Ed25519 key — the byte-for-byte inverse of the mobile signer at
``farcaster-audio/services/snapSigner.ts:293`` (``signFarcasterClientBearer``).
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ed25519

JFS_EXPECTED_AUDIENCE = "https://client.farcaster.xyz"
JFS_MAX_CLOCK_SKEW_SECONDS = 300
# Default JFS bearer lifetime. Matches the mobile signer's 5-minute
# window and the upstream's clock-skew tolerance on the ``timestamp``
# claim. Bearers are minted per request — never cached.
JFS_DEFAULT_TTL_SECONDS = 300


def _b64url_nopad(raw: bytes) -> str:
    """base64url-encode WITHOUT padding (matches the mobile signer)."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode_jfs_bearer(bearer: str) -> int:
    """Decode + validate a user-supplied JFS Bearer, returning the ``fid``.

    JFS format: ``<headerB64>.<payloadB64>.<sigB64>`` where each part is
    base64url-encoded JSON. Header carries
    ``{"fid": <int>, "type": "app_key", "key": "0x<pubkey>"}``; payload
    carries ``{"audience": "https://client.farcaster.xyz",
    "timestamp": <epoch_seconds>}``.

    Signature verification is delegated to ``client.farcaster.xyz``
    upstream — Juke doesn't carry an Ed25519 verifier and the upstream
    is the source of truth for "is this key registered for this FID".
    We DO validate the structural + claim shape locally so a malformed
    or stale bearer doesn't waste an upstream round-trip and so we
    can't be tricked into forwarding a bearer minted for a different
    audience (the ``audience`` claim binds the signature scope —
    without enforcing it here we'd be a willing relay for cross-origin
    JFS).

    Raises ``ValueError`` on any shape / claim violation.
    """
    parts = bearer.split(".")
    if len(parts) != 3:
        raise ValueError("bearer must be header.payload.signature")

    def _decode_segment(seg: str, label: str) -> dict[str, Any]:
        # base64url decode with padding tolerance.
        padded = seg + "=" * (-len(seg) % 4)
        try:
            raw = base64.urlsafe_b64decode(padded)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{label} is not base64url") from exc
        try:
            obj = json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{label} is not JSON") from exc
        if not isinstance(obj, dict):
            raise ValueError(f"{label} is not a JSON object")
        return obj

    header = _decode_segment(parts[0], "header")
    payload = _decode_segment(parts[1], "payload")

    fid = header.get("fid")
    if not isinstance(fid, int) or fid <= 0:
        raise ValueError("header.fid missing or non-positive")

    audience = payload.get("audience")
    if audience != JFS_EXPECTED_AUDIENCE:
        raise ValueError("payload.audience does not match")

    timestamp = payload.get("timestamp")
    if not isinstance(timestamp, int):
        raise ValueError("payload.timestamp missing or non-integer")
    now = int(datetime.now(tz=timezone.utc).timestamp())
    # Forward-skew only — a bearer minted "in the future" is a clock-skew
    # tolerance; a bearer with a past ``timestamp`` should rely on ``exp``
    # to bound its lifetime so we don't widen the replay window.
    if timestamp - now > JFS_MAX_CLOCK_SKEW_SECONDS:
        raise ValueError("payload.timestamp too far in the future")

    # ``exp`` is required by client.farcaster.xyz — must be a future
    # epoch-seconds integer. Local check avoids a guaranteed-401
    # round-trip when the client clock is way off or omits the claim.
    exp = payload.get("exp")
    if not isinstance(exp, int):
        raise ValueError("payload.exp missing or non-integer")
    if exp <= now:
        raise ValueError("payload.exp is in the past")

    return fid


def mint_jfs_bearer(
    *,
    fid: int,
    private_key: ed25519.Ed25519PrivateKey,
    public_key_hex: str,
    ttl_seconds: int = JFS_DEFAULT_TTL_SECONDS,
) -> str:
    """Mint a fresh JFS bearer signed with a Juke-held Ed25519 app key.

    Byte-for-byte inverse of the mobile ``signFarcasterClientBearer``:
    JSON is emitted with compact separators, base64url-encoded WITHOUT
    padding, and the signature is Ed25519 over the ASCII bytes of
    ``"<headerB64>.<payloadB64>"``. The result MUST pass
    ``decode_jfs_bearer``.

    ``public_key_hex`` is the 0x-prefixed hex of the signing key's public
    half — it goes into ``header.key`` verbatim, matching what was
    registered with Neynar so the upstream can resolve the verifier.

    Bearers are single-use in spirit (they carry a timestamp); callers
    mint a fresh one per request and never cache them.
    """
    if fid <= 0:
        raise ValueError("fid must be positive")
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")

    now = int(datetime.now(tz=timezone.utc).timestamp())
    # Field order mirrors the mobile signer exactly. decode_jfs_bearer
    # doesn't depend on key order, but matching it keeps the two
    # implementations diff-able and avoids surprising byte differences.
    header = {"fid": fid, "type": "app_key", "key": public_key_hex}
    payload = {
        "audience": JFS_EXPECTED_AUDIENCE,
        "timestamp": now,
        "exp": now + ttl_seconds,
    }

    header_b64 = _b64url_nopad(
        json.dumps(header, separators=(",", ":")).encode("utf-8")
    )
    payload_b64 = _b64url_nopad(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    )
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = private_key.sign(signing_input)
    signature_b64 = _b64url_nopad(signature)

    return f"{header_b64}.{payload_b64}.{signature_b64}"
