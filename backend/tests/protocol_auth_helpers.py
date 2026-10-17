"""Test helpers: build ``hqa1.`` Protocol Auth tokens and a dict-backed Redis.

Every account here is generated per test (``Account.create()``); no real
keys or secrets are involved.
"""

from __future__ import annotations

import base64
import secrets
from datetime import datetime, timedelta, timezone

from eth_account import Account
from eth_account.messages import encode_defunct

DOMAIN = "juke.audio"


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def siwe_message(
    *,
    address: str,
    fid: int,
    nonce: str = "abcdef12345678",
    domain: str = DOMAIN,
    uri: str | None = None,
    statement: str | None = None,
    chain_id: int = 10,
    issued_at: datetime | None = None,
    lifetime: timedelta | None = timedelta(minutes=10),
    resources: list[str] | None = None,
) -> str:
    issued = issued_at or datetime.now(timezone.utc)
    lines = [
        f"{domain} wants you to sign in with your Ethereum account:",
        address,
        "",
        statement if statement is not None else f"Authenticate as Farcaster FID {fid}.",
        "",
        f"URI: {uri or f'https://{domain}'}",
        "Version: 1",
        f"Chain ID: {chain_id}",
        f"Nonce: {nonce}",
        f"Issued At: {iso(issued)}",
    ]
    if lifetime is not None:
        lines.append(f"Expiration Time: {iso(issued + lifetime)}")
    lines.append("Resources:")
    for resource in resources or [f"farcaster://fid/{fid}"]:
        lines.append(f"- {resource}")
    return "\n".join(lines)


def sign_message(account, message: str) -> bytes:
    return bytes(account.sign_message(encode_defunct(text=message)).signature)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def encode_token(message: str, signature: bytes) -> str:
    return f"hqa1.{_b64url(message.encode())}.{_b64url(signature)}"


def make_token(account=None, *, fid: int, **message_kwargs) -> tuple[str, object]:
    """Return ``(token, account)`` for a freshly signed Protocol Auth token."""
    account = account or Account.create()
    message_kwargs.setdefault("nonce", secrets.token_hex(8))
    message = siwe_message(address=account.address, fid=fid, **message_kwargs)
    return encode_token(message, sign_message(account, message)), account


class FakeRedis:
    """Just enough async Redis for SET NX locks, counters and Lua release."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.counters: dict[str, int] = {}
        self.expiries: dict[str, int] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, *, nx=False, ex=None, px=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        if ex is not None:
            self.expiries[key] = int(ex)
        return True

    async def delete(self, *keys):
        return sum(self.store.pop(key, None) is not None for key in keys)

    async def incr(self, key):
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    async def expire(self, key, seconds):
        self.expiries[key] = int(seconds)
        return True

    async def ttl(self, key):
        return 42

    async def eval(self, _script, _numkeys, key, token):
        # Mirrors RELEASE_LOCK_SCRIPT: compare-and-delete.
        if self.store.get(key) == token:
            del self.store[key]
            return 1
        return 0
