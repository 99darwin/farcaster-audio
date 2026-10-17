"""Test doubles for the Hypersnap write path.

``FakeNode`` stands in for ``farcaster_messages.submit_message`` (it records
every signed message and can be scripted to fail), ``FakeReads`` stands in
for ``hypersnap.get`` (channel / cast / username lookups), and
``install_write_fakes`` wires both plus a deterministic per-FID signer into
the modules the write path calls through.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.clients import farcaster_messages as fm
from app.clients import hypersnap
from app.clients.proto import message_pb2
from app.services import farcaster_writes
from app.services.user_signer_service import SignerNotApprovedError

CHANNEL_PARENT_URLS = {
    "neynar": "https://warpcast.com/~/channel/neynar",
    "music": "chain://eip155:1/erc721:0x1234567890abcdef1234567890abcdef12345678",
}


def signer_key_for(fid: int) -> Ed25519PrivateKey:
    """Deterministic test key per FID (never a real signer)."""
    return Ed25519PrivateKey.from_private_bytes(fid.to_bytes(32, "big"))


def submit_error(
    status_code: int | None,
    *,
    err_code: str | None = None,
    node_message: str | None = None,
) -> fm.SubmitMessageError:
    return fm.SubmitMessageError(
        "submit failed",
        status_code=status_code,
        err_code=err_code,
        node_message=node_message,
    )


@dataclass
class FakeNode:
    """Records submitted messages; pops scripted errors one per call."""

    errors: list[Exception | None] = field(default_factory=list)
    submitted: list[message_pb2.Message] = field(default_factory=list)
    attempted_bytes: list[bytes] = field(default_factory=list)

    @property
    def attempts(self) -> int:
        return len(self.attempted_bytes)

    async def __call__(self, message: message_pb2.Message, **_: Any):
        self.attempted_bytes.append(message.SerializeToString())
        if self.errors:
            error = self.errors.pop(0)
            if error is not None:
                raise error
        self.submitted.append(message)
        return message

    @property
    def bodies(self) -> list[message_pb2.MessageData]:
        return [message.data for message in self.submitted]

    @property
    def hashes(self) -> list[str]:
        return [fm.message_hash_hex(message) for message in self.submitted]


@dataclass
class FakeReads:
    """Scriptable ``hypersnap.get`` for the lookups the write path makes."""

    cast_authors: dict[str, int] = field(default_factory=dict)
    usernames: dict[str, int] = field(default_factory=dict)
    channels: dict[str, str] = field(default_factory=lambda: dict(CHANNEL_PARENT_URLS))
    calls: list[tuple[str, dict]] = field(default_factory=list)

    async def __call__(self, path: str, params: dict | None = None, **_: Any):
        params = params or {}
        self.calls.append((path, params))
        if path == "/channel":
            parent_url = self.channels.get(params["id"])
            if parent_url is None:
                raise hypersnap.HypersnapNotFound("missing", path=path)
            return {"channel": {"id": params["id"], "parent_url": parent_url}}
        if path == "/cast":
            fid = self.cast_authors.get(params["identifier"].lower())
            if fid is None:
                raise hypersnap.HypersnapNotFound("missing", path=path)
            return {"cast": {"hash": params["identifier"][2:], "author": {"fid": fid}}}
        if path == "/user/by-username":
            fid = self.usernames.get(params["username"].lower())
            if fid is None:
                raise hypersnap.HypersnapNotFound("missing", path=path)
            return {"user": {"fid": fid, "username": params["username"]}}
        raise AssertionError(f"unexpected hypersnap read {path}")


@dataclass
class WriteFakes:
    node: FakeNode
    reads: FakeReads
    linked_fids: set[int] | None


def install_write_fakes(
    monkeypatch,
    *,
    linked_fids: Iterable[int] | None = None,
    node: FakeNode | None = None,
    reads: FakeReads | None = None,
) -> WriteFakes:
    """Patch signer loading, node submission and Hypersnap reads.

    ``linked_fids=None`` treats every FID as having an approved signer;
    otherwise any FID outside the set raises ``SignerNotApprovedError``.
    """
    linked = set(linked_fids) if linked_fids is not None else None
    fakes = WriteFakes(
        node=node or FakeNode(), reads=reads or FakeReads(), linked_fids=linked
    )

    async def fake_get_user_signer(_db, fid: int) -> Ed25519PrivateKey:
        if linked is not None and fid not in linked:
            raise SignerNotApprovedError(f"no approved signer for fid {fid}")
        return signer_key_for(fid)

    monkeypatch.setattr(
        "app.services.user_signer_service.get_user_signer", fake_get_user_signer
    )
    monkeypatch.setattr("app.clients.farcaster_messages.submit_message", fakes.node)
    monkeypatch.setattr("app.clients.hypersnap.get", fakes.reads)
    farcaster_writes.clear_lookup_caches()
    return fakes


def install_system_signer(monkeypatch, *, brand_fid: int = 999) -> None:
    """Configure a fake @jukeaudio signer without touching real key material."""
    monkeypatch.setattr("app.config.settings.BRAND_FID", brand_fid)
    monkeypatch.setattr(
        "app.config.settings.JUKEAUDIO_SIGNER_PRIVATE_KEY_ENCRYPTED", "test-blob"
    )
    raw = farcaster_writes.Signer(fid=brand_fid, private_key=b"\x07" * 32)
    monkeypatch.setattr("app.services.farcaster_writes.load_system_signer", lambda: raw)
