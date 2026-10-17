"""Build, sign and submit Farcaster protocol messages to Hypersnap.

Hypersnap's HTTP ``/v2`` write endpoints return 501, so Juke builds the
protobuf ``Message`` itself, signs it with the user's Ed25519 app signer and
POSTs the bytes to ``/v1/submitMessage``.

Envelope rules (mirrors QuilibriumNetwork/quorum-shared
``src/farcaster/messageBuilder.ts``):

* ``hash = blake3(data_bytes)[:20]`` with ``hash_scheme = BLAKE3``.
* ``signature = ed25519(hash)`` with ``signature_scheme = ED25519`` and
  ``signer`` = the 32-byte public key.
* BOTH ``data`` (field 1) and ``data_bytes`` (field 7) are populated with
  the same encoded ``MessageData``. The node validates the hash against
  ``data_bytes`` when present (so the hash never depends on the node's
  re-encoder), while merge paths read ``data`` directly.

The cast hash Juke records (cast ledger, optimistic UI) is ``message.hash``.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

import blake3
import httpx
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.clients import hypersnap
from app.clients.proto import message_pb2

logger = logging.getLogger(__name__)

FARCASTER_EPOCH = datetime(2021, 1, 1, tzinfo=UTC)
MESSAGE_HASH_BYTES = 20
ED25519_PRIVATE_KEY_BYTES = 32
MAX_STANDARD_CAST_BYTES = 320
MAX_LONG_CAST_BYTES = 1024
MAX_MENTIONS = 10
MAX_LINK_TYPE_CHARS = 8
LINK_TYPE_FOLLOW = "follow"
SUBMIT_MESSAGE_PATH = "/submitMessage"
OCTET_STREAM = "application/octet-stream"
LOGGED_BODY_CHARS = 500

Action = Literal["add", "remove"]
ReactionKind = Literal["like", "recast"]

_REACTION_TYPES: dict[str, int] = {
    "like": message_pb2.REACTION_TYPE_LIKE,
    "recast": message_pb2.REACTION_TYPE_RECAST,
}
_REACTION_MESSAGE_TYPES: dict[str, int] = {
    "add": message_pb2.MESSAGE_TYPE_REACTION_ADD,
    "remove": message_pb2.MESSAGE_TYPE_REACTION_REMOVE,
}
_LINK_MESSAGE_TYPES: dict[str, int] = {
    "add": message_pb2.MESSAGE_TYPE_LINK_ADD,
    "remove": message_pb2.MESSAGE_TYPE_LINK_REMOVE,
}

# Farcaster fnames are 1-16 chars of [a-z0-9-] not starting with a hyphen;
# ENS-backed usernames carry a ``.eth`` suffix. The lookbehind skips emails
# (``me@example.com``) and ``@@`` runs.
_MENTION_RE = re.compile(
    r"(?<![A-Za-z0-9_@.])@([A-Za-z0-9][A-Za-z0-9-]{0,15}(?:\.eth)?)(?![A-Za-z0-9-])"
)
# ``message: "bad_request.validation_failure/invalid signer"`` inside the
# node's stringified gRPC status.
_GRPC_STATUS_MESSAGE_RE = re.compile(
    r'message: "(?P<code>[a-z_]+(?:\.[a-z_]+)*)/(?P<message>[^"]*)"'
)


class MessageBuildError(ValueError):
    """Inputs violate a protocol rule the node would reject anyway."""


class SubmitMessageError(Exception):
    """The node rejected (or could not be reached for) ``submitMessage``.

    ``err_code`` / ``node_message`` carry the node's error envelope verbatim
    (e.g. ``bad_request.validation_failure``); ``status_code`` is ``None``
    for transport failures.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None,
        err_code: str | None = None,
        node_message: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.err_code = err_code
        self.node_message = node_message


@dataclass(frozen=True)
class CastRef:
    """A ``CastId``: author FID + 20-byte message hash."""

    fid: int
    hash: bytes

    @classmethod
    def from_hex(cls, fid: int, hash_hex: str) -> CastRef:
        return cls(fid=fid, hash=bytes.fromhex(hash_hex.removeprefix("0x")))

    def to_proto(self) -> message_pb2.CastId:
        if len(self.hash) != MESSAGE_HASH_BYTES:
            raise MessageBuildError("cast hash must be 20 bytes")
        if self.fid <= 0:
            raise MessageBuildError("cast fid must be positive")
        return message_pb2.CastId(fid=self.fid, hash=self.hash)


Embed = str | CastRef


@dataclass(frozen=True)
class ParsedMentions:
    """Cast text with ``@username`` tokens removed, plus protocol mentions."""

    text: str
    mentions: list[int]
    mentions_positions: list[int]


def farcaster_timestamp(now: datetime | None = None) -> int:
    """Seconds since the Farcaster epoch (2021-01-01T00:00:00Z)."""
    moment = now or datetime.now(UTC)
    return int((moment - FARCASTER_EPOCH).total_seconds())


def message_hash_hex(message: message_pb2.Message) -> str:
    return "0x" + message.hash.hex()


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def build_cast_add(
    fid: int,
    text: str,
    *,
    signer_private_key: bytes,
    embeds: Sequence[Embed] = (),
    mentions: Sequence[int] = (),
    mentions_positions: Sequence[int] = (),
    parent_cast_id: CastRef | None = None,
    parent_url: str | None = None,
    timestamp: int | None = None,
) -> message_pb2.Message:
    """Build a signed ``CastAdd``.

    ``text`` must already have mentions stripped (see :func:`parse_mentions`).
    Casts over 320 UTF-8 bytes are sent as ``LONG_CAST`` (max 1024).
    """
    if parent_cast_id is not None and parent_url is not None:
        raise MessageBuildError("a cast has either a parent cast or a parent url")
    cast_type = _cast_type_for(text)
    _validate_mentions(text, mentions, mentions_positions)
    if not text and not embeds and not mentions:
        raise MessageBuildError("cast is empty")

    body = message_pb2.CastAddBody(
        text=text,
        mentions=list(mentions),
        mentions_positions=list(mentions_positions),
        embeds=[_embed_to_proto(embed) for embed in embeds],
        type=cast_type,
    )
    if parent_cast_id is not None:
        body.parent_cast_id.CopyFrom(parent_cast_id.to_proto())
    elif parent_url is not None:
        body.parent_url = parent_url

    data = _message_data(message_pb2.MESSAGE_TYPE_CAST_ADD, fid, timestamp)
    data.cast_add_body.CopyFrom(body)
    return sign_message_data(data, signer_private_key)


def build_cast_remove(
    fid: int,
    target_hash: bytes,
    *,
    signer_private_key: bytes,
    timestamp: int | None = None,
) -> message_pb2.Message:
    """Build a signed ``CastRemove`` for one of ``fid``'s own casts."""
    if len(target_hash) != MESSAGE_HASH_BYTES:
        raise MessageBuildError("target hash must be 20 bytes")
    data = _message_data(message_pb2.MESSAGE_TYPE_CAST_REMOVE, fid, timestamp)
    data.cast_remove_body.target_hash = target_hash
    return sign_message_data(data, signer_private_key)


def build_reaction(
    fid: int,
    action: Action,
    reaction_type: ReactionKind,
    target_cast_id: CastRef,
    *,
    signer_private_key: bytes,
    timestamp: int | None = None,
) -> message_pb2.Message:
    """Build a signed ``ReactionAdd`` / ``ReactionRemove`` (like or recast)."""
    message_type = _lookup(_REACTION_MESSAGE_TYPES, action, "reaction action")
    proto_reaction = _lookup(_REACTION_TYPES, reaction_type, "reaction type")
    data = _message_data(message_type, fid, timestamp)
    data.reaction_body.type = proto_reaction
    data.reaction_body.target_cast_id.CopyFrom(target_cast_id.to_proto())
    return sign_message_data(data, signer_private_key)


def build_link(
    fid: int,
    action: Action,
    link_type: str,
    target_fid: int,
    *,
    signer_private_key: bytes,
    timestamp: int | None = None,
) -> message_pb2.Message:
    """Build a signed ``LinkAdd`` / ``LinkRemove`` (e.g. ``"follow"``)."""
    message_type = _lookup(_LINK_MESSAGE_TYPES, action, "link action")
    if not link_type or len(link_type) > MAX_LINK_TYPE_CHARS:
        raise MessageBuildError("link type must be 1-8 characters")
    if target_fid <= 0:
        raise MessageBuildError("target fid must be positive")
    if target_fid == fid:
        raise MessageBuildError("cannot link to self")
    data = _message_data(message_type, fid, timestamp)
    data.link_body.type = link_type
    data.link_body.target_fid = target_fid
    return sign_message_data(data, signer_private_key)


def sign_message_data(
    data: message_pb2.MessageData, signer_private_key: bytes
) -> message_pb2.Message:
    """Hash (BLAKE3-160) and Ed25519-sign ``data`` into a ``Message``."""
    if len(signer_private_key) != ED25519_PRIVATE_KEY_BYTES:
        raise MessageBuildError("Ed25519 private key must be 32 bytes")
    private_key = ed25519.Ed25519PrivateKey.from_private_bytes(signer_private_key)
    public_key = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

    data_bytes = data.SerializeToString(deterministic=True)
    message_hash = blake3.blake3(data_bytes).digest()[:MESSAGE_HASH_BYTES]
    return message_pb2.Message(
        data=data,
        hash=message_hash,
        hash_scheme=message_pb2.HASH_SCHEME_BLAKE3,
        signature=private_key.sign(message_hash),
        signature_scheme=message_pb2.SIGNATURE_SCHEME_ED25519,
        signer=public_key,
        data_bytes=data_bytes,
    )


def _message_data(
    message_type: int, fid: int, timestamp: int | None
) -> message_pb2.MessageData:
    if fid <= 0:
        raise MessageBuildError("fid must be positive")
    return message_pb2.MessageData(
        type=message_type,
        fid=fid,
        timestamp=timestamp if timestamp is not None else farcaster_timestamp(),
        network=message_pb2.FARCASTER_NETWORK_MAINNET,
    )


def _cast_type_for(text: str) -> int:
    text_bytes = len(text.encode("utf-8"))
    if text_bytes > MAX_LONG_CAST_BYTES:
        raise MessageBuildError("cast text exceeds 1024 bytes")
    if text_bytes > MAX_STANDARD_CAST_BYTES:
        return message_pb2.LONG_CAST
    return message_pb2.CAST


def _validate_mentions(
    text: str, mentions: Sequence[int], positions: Sequence[int]
) -> None:
    if len(mentions) != len(positions):
        raise MessageBuildError("mentions and mentions_positions differ in length")
    if len(mentions) > MAX_MENTIONS:
        raise MessageBuildError("a cast may mention at most 10 users")
    text_bytes = len(text.encode("utf-8"))
    previous = 0
    for fid, position in zip(mentions, positions, strict=True):
        if fid <= 0:
            raise MessageBuildError("mentioned fid must be positive")
        if position < previous or position > text_bytes:
            raise MessageBuildError("mention positions must be sorted byte offsets")
        previous = position


def _embed_to_proto(embed: Embed) -> message_pb2.Embed:
    if isinstance(embed, CastRef):
        return message_pb2.Embed(cast_id=embed.to_proto())
    if not embed:
        raise MessageBuildError("embed url is empty")
    return message_pb2.Embed(url=embed)


def _lookup(table: dict[str, int], key: str, label: str) -> int:
    try:
        return table[key]
    except KeyError:
        raise MessageBuildError(f"unknown {label}: {key!r}") from None


# ---------------------------------------------------------------------------
# Mentions
# ---------------------------------------------------------------------------


async def parse_mentions(
    text: str, resolve_username: Callable[[str], Awaitable[int | None]]
) -> ParsedMentions:
    """Convert ``@username`` tokens into protocol mentions.

    Each resolvable mention is removed from the text and recorded as
    ``(fid, utf8_byte_offset)`` where the offset is the position in the
    *stripped* text, as the protocol requires. Unresolvable usernames, and
    any beyond the 10-mention protocol cap, are left as literal text.
    ``resolve_username`` is awaited once per distinct (lowercased) name.
    """
    matches = list(_MENTION_RE.finditer(text))
    resolved: dict[str, int | None] = {}
    for match in matches:
        username = match.group(1).lower()
        if username not in resolved:
            resolved[username] = await resolve_username(username)

    parts: list[str] = []
    mentions: list[int] = []
    positions: list[int] = []
    byte_offset = 0
    cursor = 0
    for match in matches:
        fid = resolved[match.group(1).lower()]
        if fid is None or len(mentions) >= MAX_MENTIONS:
            continue
        preceding = text[cursor : match.start()]
        parts.append(preceding)
        byte_offset += len(preceding.encode("utf-8"))
        mentions.append(fid)
        positions.append(byte_offset)
        cursor = match.end()
    parts.append(text[cursor:])
    return ParsedMentions(
        text="".join(parts), mentions=mentions, mentions_positions=positions
    )


# ---------------------------------------------------------------------------
# Submission
# ---------------------------------------------------------------------------


async def submit_message(
    message: message_pb2.Message,
    *,
    client: hypersnap.HypersnapClient | None = None,
) -> message_pb2.Message:
    """POST ``message`` to ``/v1/submitMessage``; return it once accepted.

    Raises :class:`SubmitMessageError` carrying the node's ``errCode`` and
    message on rejection, or on transport failure.
    """
    http = client or hypersnap.get_client()
    try:
        resp = await http.post_v1_bytes(
            SUBMIT_MESSAGE_PATH,
            message.SerializeToString(),
            content_type=OCTET_STREAM,
        )
    except hypersnap.HypersnapError as exc:
        raise SubmitMessageError(
            "submitMessage transport failure", status_code=None
        ) from exc

    if resp.is_error:
        err_code, node_message = _parse_node_error(resp)
        logger.warning(
            "[hypersnap] submitMessage %s rejected: HTTP %s %s %s",
            message_hash_hex(message),
            resp.status_code,
            err_code,
            node_message,
        )
        raise SubmitMessageError(
            f"submitMessage rejected: {err_code or resp.status_code}",
            status_code=resp.status_code,
            err_code=err_code,
            node_message=node_message,
        )

    _check_echoed_hash(resp, message)
    return message


def _parse_node_error(resp: httpx.Response) -> tuple[str | None, str]:
    """Extract ``(errCode, message)`` from the node's error envelope.

    Hypersnap wraps the gRPC status in ``error_detail``, e.g.
    ``status: InvalidArgument, message: "bad_request.validation_failure/
    invalid signer", ...`` → ``("bad_request.validation_failure",
    "invalid signer")``. Hubble-style ``{errCode, message}`` bodies are
    accepted too.
    """
    try:
        payload = resp.json()
    except ValueError:
        return None, resp.text[:LOGGED_BODY_CHARS]
    if not isinstance(payload, dict):
        return None, resp.text[:LOGGED_BODY_CHARS]

    detail = payload.get("error_detail")
    if isinstance(detail, str):
        match = _GRPC_STATUS_MESSAGE_RE.search(detail)
        if match:
            return match.group("code"), match.group("message")[:LOGGED_BODY_CHARS]
        return None, detail[:LOGGED_BODY_CHARS]

    err_code = payload.get("errCode")
    node_message = payload.get("message") or payload.get("error") or ""
    return (
        str(err_code) if err_code else None,
        str(node_message)[:LOGGED_BODY_CHARS],
    )


def _check_echoed_hash(resp: httpx.Response, message: message_pb2.Message) -> None:
    """Fail loudly if the node acknowledged a different message hash."""
    try:
        payload = resp.json()
    except ValueError:
        return
    echoed = payload.get("hash") if isinstance(payload, dict) else None
    if isinstance(echoed, str) and echoed.lower() != message_hash_hex(message):
        raise SubmitMessageError(
            "submitMessage acknowledged a different hash",
            status_code=resp.status_code,
            node_message=f"expected {message_hash_hex(message)}, got {echoed}",
        )
