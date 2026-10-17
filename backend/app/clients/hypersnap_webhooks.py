"""Hypersnap webhook management (EIP-712 signed) and delivery verification.

Management calls (``/v2/farcaster/webhook*``) are authenticated per request:
the owning FID's custody key signs a ``HypersnapSignedOp`` typed-data struct
binding the operation name, FID, timestamp, a random nonce and
``keccak256(raw body)``. Hypersnap recovers the signer, checks it against
``custodyOf(fid)`` on-chain and cross-checks the op against the HTTP route.
See https://hypersnap-docs.qstorage.quilibrium.com/ ("Signed operations").

Deliveries carry ``X-Hypersnap-Signature: hex(hmac_sha512(secret, body))``;
:func:`verify_delivery_signature` checks it over the raw bytes, before any
JSON parsing, in constant time.

Usage::

    client = HypersnapWebhookClient(app_webhook_signer())
    webhook = await client.create(name=..., url=..., subscription=...)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_account.signers.local import LocalAccount
from eth_utils import keccak

from app.clients import hypersnap
from app.config import settings

WEBHOOK_PATH = hypersnap.V2_PREFIX + "/webhook"
WEBHOOK_LIST_PATH = WEBHOOK_PATH + "/list"
WEBHOOK_ROTATE_PATH = WEBHOOK_PATH + "/secret/rotate"

# Hypersnap operator default; creating webhook #26 returns 429.
MAX_WEBHOOKS_PER_FID = 25
# Every array in a subscription filter is capped at this many entries.
MAX_FILTER_ENTRIES = 1024

HEADER_FID = "X-Hypersnap-Fid"
HEADER_OP = "X-Hypersnap-Op"
HEADER_SIGNED_AT = "X-Hypersnap-Signed-At"
HEADER_NONCE = "X-Hypersnap-Nonce"
HEADER_SIGNATURE = "X-Hypersnap-Signature"
NONCE_BYTES = 32
HTTP_TOO_MANY_REQUESTS = 429

EIP712_DOMAIN = {"name": "Hypersnap", "version": "1", "chainId": 10}
EIP712_TYPES = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
    ],
    "HypersnapSignedOp": [
        {"name": "op", "type": "string"},
        {"name": "fid", "type": "uint64"},
        {"name": "signedAt", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "requestHash", "type": "bytes32"},
    ],
}
PRIMARY_TYPE = "HypersnapSignedOp"


class WebhookOp(StrEnum):
    """Signed operation names; each must match its HTTP method + path."""

    CREATE = "webhook.create"
    UPDATE = "webhook.update"
    DELETE = "webhook.delete"
    READ = "webhook.read"
    ROTATE_SECRET = "webhook.rotate_secret"


class HypersnapWebhookConfigError(hypersnap.HypersnapError):
    """The app FID or custody key is not configured (or is invalid)."""


class HypersnapWebhookLimitReached(hypersnap.HypersnapUpstreamError):
    """The owning FID already holds :data:`MAX_WEBHOOKS_PER_FID` webhooks."""


@dataclass(frozen=True)
class WebhookSigner:
    """An FID plus the custody account that signs its management requests."""

    fid: int
    account: LocalAccount

    def __repr__(self) -> str:  # never expose key material via repr
        return f"WebhookSigner(fid={self.fid}, address={self.account.address})"


def app_webhook_signer() -> WebhookSigner:
    """Signer for the Juke app FID, derived from ``FARCASTER_APP_MNEMONIC``.

    Raises :class:`HypersnapWebhookConfigError` when unset or invalid. The
    underlying error is never chained: eth_account echoes mnemonic words.
    """
    if settings.FARCASTER_APP_FID <= 0 or not settings.FARCASTER_APP_MNEMONIC:
        raise HypersnapWebhookConfigError(
            "FARCASTER_APP_FID / FARCASTER_APP_MNEMONIC are not configured",
            path=WEBHOOK_PATH,
        )
    try:
        Account.enable_unaudited_hdwallet_features()
        account = Account.from_mnemonic(settings.FARCASTER_APP_MNEMONIC)
    except Exception:
        raise HypersnapWebhookConfigError(
            "FARCASTER_APP_MNEMONIC is invalid", path=WEBHOOK_PATH
        ) from None
    return WebhookSigner(fid=settings.FARCASTER_APP_FID, account=account)


def is_app_signer_configured() -> bool:
    return settings.FARCASTER_APP_FID > 0 and bool(settings.FARCASTER_APP_MNEMONIC)


# ---------------------------------------------------------------------------
# EIP-712 signing
# ---------------------------------------------------------------------------


def build_signed_op_typed_data(
    *, op: str, fid: int, signed_at: int, nonce: bytes, request_hash: bytes
) -> dict[str, Any]:
    """Full EIP-712 typed data for one ``HypersnapSignedOp``."""
    if len(nonce) != NONCE_BYTES or len(request_hash) != NONCE_BYTES:
        raise ValueError("nonce and request_hash must be 32 bytes")
    return {
        "domain": dict(EIP712_DOMAIN),
        "primaryType": PRIMARY_TYPE,
        "types": EIP712_TYPES,
        "message": {
            "op": op,
            "fid": fid,
            "signedAt": signed_at,
            "nonce": nonce,
            "requestHash": request_hash,
        },
    }


def sign_request(
    signer: WebhookSigner,
    op: WebhookOp,
    body: bytes,
    *,
    signed_at: int | None = None,
    nonce: bytes | None = None,
) -> dict[str, str]:
    """Return the ``X-Hypersnap-*`` auth headers for ``body`` (raw bytes)."""
    signed_at = int(time.time()) if signed_at is None else signed_at
    nonce = secrets.token_bytes(NONCE_BYTES) if nonce is None else nonce
    typed_data = build_signed_op_typed_data(
        op=op.value,
        fid=signer.fid,
        signed_at=signed_at,
        nonce=nonce,
        request_hash=keccak(body),
    )
    signed = signer.account.sign_message(encode_typed_data(full_message=typed_data))
    return {
        HEADER_FID: str(signer.fid),
        HEADER_OP: op.value,
        HEADER_SIGNED_AT: str(signed_at),
        HEADER_NONCE: "0x" + nonce.hex(),
        HEADER_SIGNATURE: "0x" + bytes(signed.signature).hex(),
    }


def recover_request_signer(headers: Mapping[str, str], body: bytes) -> str:
    """Recover the address that signed ``headers`` over ``body`` (server view)."""
    typed_data = build_signed_op_typed_data(
        op=headers[HEADER_OP],
        fid=int(headers[HEADER_FID]),
        signed_at=int(headers[HEADER_SIGNED_AT]),
        nonce=bytes.fromhex(headers[HEADER_NONCE].removeprefix("0x")),
        request_hash=keccak(body),
    )
    return Account.recover_message(
        encode_typed_data(full_message=typed_data),
        signature=bytes.fromhex(headers[HEADER_SIGNATURE].removeprefix("0x")),
    )


# ---------------------------------------------------------------------------
# Delivery verification
# ---------------------------------------------------------------------------


def parse_secrets(raw: str) -> list[str]:
    """Split a comma-separated secret setting (rotation grace windows)."""
    return [part.strip() for part in raw.split(",") if part.strip()]


def verify_delivery_signature(
    body: bytes, signature: str, accepted_secrets: Iterable[str]
) -> bool:
    """True iff ``signature`` is ``hex(hmac_sha512(secret, body))`` for any
    accepted secret. Fails closed on an empty signature or empty secret set.

    Every secret is compared (no early exit) with ``hmac.compare_digest``.
    Non-ASCII input is rejected up front: ``compare_digest`` raises
    ``TypeError`` on non-ASCII ``str`` (headers decode as latin-1).
    """
    received = signature.strip().lower().removeprefix("0x")
    if not received or not received.isascii():
        return False
    matched = False
    for secret in accepted_secrets:
        if not secret:
            continue
        expected = hmac.new(secret.encode(), body, hashlib.sha512).hexdigest()
        matched |= hmac.compare_digest(expected, received)
    return matched


# ---------------------------------------------------------------------------
# Management client
# ---------------------------------------------------------------------------


def _encode_body(payload: Mapping[str, Any] | None) -> bytes:
    """Serialize once; the same bytes are hashed and sent."""
    if payload is None:
        return b""
    return json.dumps(payload, separators=(",", ":")).encode()


class HypersnapWebhookClient:
    """Signed CRUD over ``/v2/farcaster/webhook`` for one owning FID."""

    def __init__(
        self,
        signer: WebhookSigner,
        http: hypersnap.HypersnapClient | None = None,
    ) -> None:
        self._signer = signer
        self._http = http

    @property
    def owner_fid(self) -> int:
        return self._signer.fid

    async def create(
        self,
        *,
        name: str,
        url: str,
        subscription: Mapping[str, Any],
        description: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": name,
            "url": url,
            "subscription": subscription,
        }
        if description is not None:
            payload["description"] = description
        data = await self._send("POST", WEBHOOK_PATH, WebhookOp.CREATE, payload)
        return _webhook_of(data, WEBHOOK_PATH)

    async def update(
        self,
        webhook_id: str,
        *,
        subscription: Mapping[str, Any] | None = None,
        active: bool | None = None,
        name: str | None = None,
        url: str | None = None,
    ) -> dict[str, Any]:
        """Partial update; ``subscription`` replaces the whole filter."""
        payload: dict[str, Any] = {"webhook_id": webhook_id}
        optional = {"subscription": subscription, "active": active}
        optional |= {"name": name, "url": url}
        payload |= {key: value for key, value in optional.items() if value is not None}
        data = await self._send("PUT", WEBHOOK_PATH, WebhookOp.UPDATE, payload)
        return _webhook_of(data, WEBHOOK_PATH)

    async def delete(self, webhook_id: str) -> None:
        await self._send(
            "DELETE",
            WEBHOOK_PATH,
            WebhookOp.DELETE,
            params={"webhook_id": webhook_id},
        )

    async def lookup(self, webhook_id: str) -> dict[str, Any]:
        data = await self._send(
            "GET", WEBHOOK_PATH, WebhookOp.READ, params={"webhook_id": webhook_id}
        )
        return _webhook_of(data, WEBHOOK_PATH)

    async def list(self) -> list[dict[str, Any]]:
        data = await self._send("GET", WEBHOOK_LIST_PATH, WebhookOp.READ)
        webhooks = data.get("webhooks")
        if not isinstance(webhooks, list):
            raise hypersnap.HypersnapUpstreamError(
                "Hypersnap webhook list has no 'webhooks' array",
                path=WEBHOOK_LIST_PATH,
            )
        return [w for w in webhooks if isinstance(w, dict)]

    async def rotate_secret(self, webhook_id: str) -> dict[str, Any]:
        data = await self._send(
            "POST",
            WEBHOOK_ROTATE_PATH,
            WebhookOp.ROTATE_SECRET,
            params={"webhook_id": webhook_id},
        )
        return _webhook_of(data, WEBHOOK_ROTATE_PATH)

    async def _send(
        self,
        method: str,
        path: str,
        op: WebhookOp,
        payload: Mapping[str, Any] | None = None,
        *,
        params: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        body = _encode_body(payload)
        headers = sign_request(self._signer, op, body)
        if payload is not None:
            headers[hypersnap.HEADER_CONTENT_TYPE] = "application/json"
        http = self._http or hypersnap.get_client()
        resp = await http.request(
            method, path, content=body, headers=headers, params=params
        )
        return _json_or_raise(resp, path)


def _json_or_raise(resp: httpx.Response, path: str) -> dict[str, Any]:
    if resp.status_code == hypersnap.HTTP_NOT_FOUND:
        raise hypersnap.HypersnapNotFound.from_response(
            "Hypersnap webhook not found", resp, path
        )
    if resp.status_code == HTTP_TOO_MANY_REQUESTS:
        raise HypersnapWebhookLimitReached.from_response(
            f"Webhook cap ({MAX_WEBHOOKS_PER_FID} per FID) reached", resp, path
        )
    if resp.is_error:
        raise hypersnap.HypersnapUpstreamError.from_response(
            f"Hypersnap webhook API returned HTTP {resp.status_code}", resp, path
        )
    try:
        data = resp.json()
    except ValueError as exc:
        raise hypersnap.HypersnapUpstreamError.from_response(
            "Hypersnap webhook API returned a non-JSON body", resp, path
        ) from exc
    if not isinstance(data, dict):
        raise hypersnap.HypersnapUpstreamError.from_response(
            "Hypersnap webhook API returned a non-object body", resp, path
        )
    return data


def _webhook_of(data: Mapping[str, Any], path: str) -> dict[str, Any]:
    webhook = data.get("webhook")
    if not isinstance(webhook, dict) or not webhook.get("webhook_id"):
        raise hypersnap.HypersnapUpstreamError(
            "Hypersnap webhook response has no webhook object", path=path
        )
    return webhook


def active_secret(webhook: Mapping[str, Any], *, now: int | None = None) -> str | None:
    """The newest non-expired signing secret of a webhook record."""
    now = int(time.time()) if now is None else now
    candidates = [
        s
        for s in webhook.get("secrets") or []
        if isinstance(s, dict)
        and s.get("value")
        and (s.get("expires_at") is None or s["expires_at"] > now)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda s: s.get("created_at") or 0)["value"]
