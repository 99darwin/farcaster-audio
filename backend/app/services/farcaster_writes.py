"""Hypersnap write path shared by every Juke surface that casts or reacts.

Replaces the Neynar ``signer_uuid`` POSTs: Juke builds the protocol message
itself (``app.clients.farcaster_messages``), signs it with the user's
approved app signer (``user_signer_service.get_user_signer``) or the
@jukeaudio system signer, and submits it to ``/v1/submitMessage``.

Responsibilities kept here so each router stays a thin adapter:

* Local validation the node would otherwise enforce opaquely: at most two
  embeds (a quote counts), each an http(s) URL of at most 256 bytes; cast
  text at most 1024 UTF-8 bytes after mentions are stripped.
* ``@username`` → ``mentions`` / ``mentions_positions`` (byte offsets), with
  username lookups capped per request (security L6).
* ``channel_id`` → ``parent_url`` and cast hash → author FID via Hypersnap
  reads, cached in-process (both mappings are effectively immutable).
* Translating every failure into a sanitized ``HTTPException`` at the router
  boundary (:func:`write_errors_as_http`).

Message timestamps are always server-derived; client-supplied timestamps are
never accepted. The cast hash Juke records is the protocol message hash.
"""

from __future__ import annotations

import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import farcaster_messages as fm
from app.clients import hypersnap
from app.clients.proto import message_pb2
from app.config import settings
from app.services import user_signer_service
from app.services.signer_crypto import (
    SignerDecryptError,
    SignerKeyConfigError,
    SignerPurpose,
    decrypt_private_key,
)

logger = logging.getLogger(__name__)

MAX_CAST_EMBEDS = 2
MAX_EMBED_URL_BYTES = 256
MAX_PARENT_URL_BYTES = 256
ALLOWED_EMBED_SCHEMES = frozenset({"http", "https"})
# Distinct usernames resolved into protocol mentions per request (L6). The
# lookup cap additionally bounds upstream calls spent on unknown names.
MAX_RESOLVED_MENTIONS = fm.MAX_MENTIONS
MAX_MENTION_LOOKUPS = 2 * fm.MAX_MENTIONS
CHANNEL_CACHE_TTL_SECONDS = 3600.0
CHANNEL_CACHE_MAX_ENTRIES = 1024
CAST_AUTHOR_CACHE_MAX_ENTRIES = 4096
CAST_HASH_RE = re.compile(r"0x[0-9a-fA-F]{40}")
TRANSIENT_HTTP_STATUSES = frozenset({408, 425, 429})
HTTP_SERVER_ERROR_FLOOR = 500
DUPLICATE_ERR_CODE = "bad_request.duplicate"
VALIDATION_FAILURE_ERR_CODE = "bad_request.validation_failure"
# Node messages (under ``VALIDATION_FAILURE_ERR_CODE``) that mean the signing
# key is not an active signer for the FID. "invalid signer" is what the live
# node returns for an unregistered key; matching is anchored, never substring.
SIGNER_REJECTION_MESSAGES = ("invalid signer", "unknown signer")
SYSTEM_SIGNER_AAD_PREFIX = "system"

SIGNER_NOT_LINKED_DETAIL = "signer_not_linked"
SIGNER_UNAVAILABLE_DETAIL = "Signer temporarily unavailable"
UPSTREAM_ERROR_DETAIL = "Upstream service error"
NODE_REJECTED_DETAIL = "Farcaster node rejected the message"
CAST_NOT_FOUND_DETAIL = "Cast not found"
EMPTY_CAST_DETAIL = "Cast must have text, embeds, or a quote"

UsernameResolver = Callable[[str], Awaitable[int | None]]


class CastValidationError(ValueError):
    """Client input violates a local cast rule. The message is client-safe."""


class CastNotFoundError(LookupError):
    """A referenced cast (parent or reaction target) does not exist."""


class SystemSignerUnavailableError(Exception):
    """The @jukeaudio system signer is not configured (opaque 503)."""


@dataclass(frozen=True)
class Signer:
    """An FID plus its raw 32-byte Ed25519 key. The key is never repr'd."""

    fid: int
    private_key: bytes = field(repr=False)


@dataclass(frozen=True)
class PreparedCast:
    """Validated cast content, ready to be signed once its parent is known."""

    text: str
    mentions: tuple[int, ...] = ()
    mentions_positions: tuple[int, ...] = ()
    embeds: tuple[fm.Embed, ...] = ()
    parent_url: str | None = None


# ---------------------------------------------------------------------------
# Signers
# ---------------------------------------------------------------------------


async def load_user_signer(db: AsyncSession, fid: int) -> Signer:
    """Return ``fid``'s approved app signer.

    Raises ``SignerNotApprovedError`` (→ 403 ``signer_not_linked``).
    """
    private_key = await user_signer_service.get_user_signer(db, fid)
    raw = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return Signer(fid=fid, private_key=raw)


def system_signer_aad(fid: int) -> str:
    """AAD binding the encrypted system key to the brand FID."""
    return f"{SYSTEM_SIGNER_AAD_PREFIX}:{fid}"


def is_system_signer_configured() -> bool:
    return bool(settings.BRAND_FID and settings.JUKEAUDIO_SIGNER_PRIVATE_KEY_ENCRYPTED)


def load_system_signer() -> Signer:
    """Decrypt the @jukeaudio signer (``JUKEAUDIO_SIGNER_PRIVATE_KEY_ENCRYPTED``).

    The blob is a ``signer_crypto`` USER-purpose ciphertext bound to
    :func:`system_signer_aad` of ``BRAND_FID``. Raises
    :class:`SystemSignerUnavailableError` when unconfigured, and
    ``SignerKeyConfigError`` / ``SignerDecryptError`` on key problems.
    """
    fid = settings.BRAND_FID
    blob = settings.JUKEAUDIO_SIGNER_PRIVATE_KEY_ENCRYPTED
    if not fid or not blob:
        raise SystemSignerUnavailableError("system signer is not configured")
    raw = decrypt_private_key(
        blob, aad=system_signer_aad(fid), purpose=SignerPurpose.USER
    )
    return Signer(fid=fid, private_key=raw)


# ---------------------------------------------------------------------------
# Local validation
# ---------------------------------------------------------------------------


def is_valid_embed_url(url: str) -> bool:
    """http(s) URL with a host, at most 256 UTF-8 bytes (security L5)."""
    if not url or len(url.encode("utf-8")) > MAX_EMBED_URL_BYTES:
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme.lower() in ALLOWED_EMBED_SCHEMES and bool(parts.netloc)


def validate_embed_urls(urls: Sequence[str], *, has_quote: bool = False) -> list[str]:
    """Enforce the protocol embed rules: max 2 (a quote counts), http(s) only."""
    if len(urls) + int(has_quote) > MAX_CAST_EMBEDS:
        raise CastValidationError(
            "A cast can include at most 2 embeds including a quote"
        )
    for url in urls:
        if not is_valid_embed_url(url):
            raise CastValidationError(
                "Embeds must be http(s) URLs of at most 256 bytes"
            )
    return list(urls)


def parse_cast_hash(cast_hash: str) -> bytes:
    """``0x`` + 40 hex → 20 raw bytes; anything else is a client error."""
    if not CAST_HASH_RE.fullmatch(cast_hash or ""):
        raise CastValidationError("Cast hash must be 0x followed by 40 hex characters")
    return bytes.fromhex(cast_hash[2:])


def cast_ref(fid: int, cast_hash: str) -> fm.CastRef:
    if fid <= 0:
        raise CastValidationError("Cast fid must be positive")
    return fm.CastRef(fid=fid, hash=parse_cast_hash(cast_hash))


# ---------------------------------------------------------------------------
# Cached Hypersnap lookups
# ---------------------------------------------------------------------------


class _BoundedCache:
    """Small LRU with an optional TTL. Process-local; values are immutable."""

    def __init__(self, max_entries: int, ttl_seconds: float | None = None) -> None:
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._entries: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def get(self, key: str) -> Any | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        if self._ttl_seconds is not None and (
            time.monotonic() - stored_at > self._ttl_seconds
        ):
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        return value

    def put(self, key: str, value: Any) -> None:
        self._entries[key] = (time.monotonic(), value)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    def clear(self) -> None:
        self._entries.clear()


_channel_parent_urls = _BoundedCache(
    CHANNEL_CACHE_MAX_ENTRIES, ttl_seconds=CHANNEL_CACHE_TTL_SECONDS
)
_cast_authors = _BoundedCache(CAST_AUTHOR_CACHE_MAX_ENTRIES)


def clear_lookup_caches() -> None:
    """Drop cached channel and cast-author lookups (tests)."""
    _channel_parent_urls.clear()
    _cast_authors.clear()


async def resolve_channel_parent_url(channel_id: str) -> str:
    """Map a channel id to the ``parent_url`` its casts carry."""
    cached = _channel_parent_urls.get(channel_id)
    if cached is not None:
        return cached
    try:
        data = await hypersnap.get("/channel", {"id": channel_id})
    except hypersnap.HypersnapNotFound:
        raise CastValidationError("Unknown channel") from None
    channel = data.get("channel")
    parent_url = None
    if isinstance(channel, dict):
        parent_url = channel.get("parent_url") or channel.get("url")
    if (
        not isinstance(parent_url, str)
        or not parent_url
        or len(parent_url.encode("utf-8")) > MAX_PARENT_URL_BYTES
    ):
        raise hypersnap.HypersnapUpstreamError(
            "Hypersnap channel has no usable parent_url", path="/channel"
        )
    _channel_parent_urls.put(channel_id, parent_url)
    return parent_url


async def resolve_cast_author(cast_hash: str) -> int:
    """Return the author FID of ``cast_hash`` (needed for every ``CastId``)."""
    parse_cast_hash(cast_hash)
    key = cast_hash.lower()
    cached = _cast_authors.get(key)
    if cached is not None:
        return cached
    try:
        data = await hypersnap.get("/cast", {"identifier": key, "type": "hash"})
    except hypersnap.HypersnapNotFound:
        raise CastNotFoundError(CAST_NOT_FOUND_DETAIL) from None
    cast = data.get("cast")
    author = cast.get("author") if isinstance(cast, dict) else None
    fid = author.get("fid") if isinstance(author, dict) else None
    if not isinstance(fid, int) or isinstance(fid, bool) or fid <= 0:
        raise hypersnap.HypersnapUpstreamError(
            "Hypersnap cast has no author fid", path="/cast"
        )
    _cast_authors.put(key, fid)
    return fid


async def resolve_parent(parent_hash: str | None) -> fm.CastRef | None:
    if not parent_hash:
        return None
    hash_bytes = parse_cast_hash(parent_hash)
    return fm.CastRef(fid=await resolve_cast_author(parent_hash), hash=hash_bytes)


async def fetch_username_fid(username: str) -> int | None:
    """Resolve one username via Hypersnap; an unknown name → ``None``.

    Upstream failures propagate as ``HypersnapError``. Callers that must
    build byte-identical messages across retries (the scheduled publisher)
    use this directly so a flaky lookup fails the attempt instead of silently
    changing the message.
    """
    try:
        data = await hypersnap.get("/user/by-username", {"username": username})
    except hypersnap.HypersnapNotFound:
        return None
    user = data.get("user")
    fid = user.get("fid") if isinstance(user, dict) else None
    if isinstance(fid, int) and not isinstance(fid, bool) and fid > 0:
        return fid
    return None


async def lookup_username_fid(username: str) -> int | None:
    """Like :func:`fetch_username_fid`, but unreachable → ``None``.

    A failed lookup only leaves the ``@name`` as literal text, so upstream
    errors degrade gracefully instead of failing an interactive cast.
    """
    try:
        return await fetch_username_fid(username)
    except hypersnap.HypersnapError as exc:
        logger.warning(
            "[farcaster-writes] username lookup failed: %s", type(exc).__name__
        )
        return None


class MentionResolver:
    """Per-request memoized username resolver with hard lookup caps (L6).

    At most :data:`MAX_RESOLVED_MENTIONS` distinct usernames resolve and at
    most :data:`MAX_MENTION_LOOKUPS` upstream lookups run, however many
    ``@names`` the text holds. ``known`` short-circuits names the caller
    already has (e.g. award winners), costing no lookup.
    """

    def __init__(
        self,
        lookup: UsernameResolver = lookup_username_fid,
        *,
        known: Mapping[str, int] | None = None,
        max_resolved: int = MAX_RESOLVED_MENTIONS,
        max_lookups: int = MAX_MENTION_LOOKUPS,
    ) -> None:
        self._lookup = lookup
        self._known = {name.lower(): fid for name, fid in (known or {}).items()}
        self._max_resolved = max_resolved
        self._max_lookups = max_lookups
        self._memo: dict[str, int | None] = {}
        self._resolved = 0
        self._lookups = 0

    async def __call__(self, username: str) -> int | None:
        name = username.lower()
        if name in self._memo:
            return self._memo[name]
        if self._resolved >= self._max_resolved:
            return None
        fid = self._known.get(name)
        if fid is None:
            if self._lookups >= self._max_lookups:
                return None
            self._lookups += 1
            fid = await self._lookup(name)
        if fid is not None:
            self._resolved += 1
        self._memo[name] = fid
        return fid


async def _no_lookup(_username: str) -> None:
    return None


def known_mentions_resolver(known: Mapping[str, int]) -> MentionResolver:
    """Resolver over a fixed username → FID map; never calls upstream."""
    return MentionResolver(_no_lookup, known=known)


# ---------------------------------------------------------------------------
# Building and submitting
# ---------------------------------------------------------------------------


async def prepare_cast(
    *,
    text: str,
    embed_urls: Sequence[str] = (),
    quote: fm.CastRef | None = None,
    channel_id: str | None = None,
    resolve_username: UsernameResolver | None = None,
) -> PreparedCast:
    """Validate content, resolve mentions and channel; no signing yet."""
    urls = validate_embed_urls(embed_urls, has_quote=quote is not None)
    parsed = await fm.parse_mentions(text, resolve_username or MentionResolver())
    if len(parsed.text.encode("utf-8")) > fm.MAX_LONG_CAST_BYTES:
        raise CastValidationError("Cast text exceeds 1024 bytes")
    embeds: list[fm.Embed] = list(urls)
    if quote is not None:
        embeds.append(quote)
    if not parsed.text.strip() and not embeds and not parsed.mentions:
        raise CastValidationError(EMPTY_CAST_DETAIL)
    parent_url = await resolve_channel_parent_url(channel_id) if channel_id else None
    return PreparedCast(
        text=parsed.text,
        mentions=tuple(parsed.mentions),
        mentions_positions=tuple(parsed.mentions_positions),
        embeds=tuple(embeds),
        parent_url=parent_url,
    )


def build_cast(
    signer: Signer,
    prepared: PreparedCast,
    *,
    parent: fm.CastRef | None = None,
    timestamp: int | None = None,
) -> message_pb2.Message:
    """Sign ``prepared`` as a ``CastAdd`` (a reply when ``parent`` is set)."""
    return fm.build_cast_add(
        signer.fid,
        prepared.text,
        signer_private_key=signer.private_key,
        embeds=prepared.embeds,
        mentions=prepared.mentions,
        mentions_positions=prepared.mentions_positions,
        parent_cast_id=parent,
        parent_url=None if parent is not None else prepared.parent_url,
        timestamp=timestamp,
    )


def is_duplicate_submit(exc: fm.SubmitMessageError) -> bool:
    """The node already holds this exact message (a retried submit).

    Matches the structured error code only: treating a free-text "duplicate"
    as success would report (and ledger) a cast the node never stored.
    """
    return exc.err_code == DUPLICATE_ERR_CODE


def is_transient_submit_error(exc: fm.SubmitMessageError) -> bool:
    status = exc.status_code
    return (
        status is None
        or status >= HTTP_SERVER_ERROR_FLOOR
        or status in TRANSIENT_HTTP_STATUSES
    )


def is_signer_rejection(exc: fm.SubmitMessageError) -> bool:
    """The node does not recognise the signing key for this FID."""
    if is_transient_submit_error(exc) or exc.err_code != VALIDATION_FAILURE_ERR_CODE:
        return False
    node_message = (exc.node_message or "").strip().lower()
    return any(
        node_message == phrase or node_message.startswith(f"{phrase}:")
        for phrase in SIGNER_REJECTION_MESSAGES
    )


async def submit(message: message_pb2.Message) -> str:
    """Submit ``message``; return its ``0x`` hash.

    Re-submitting a message the node already holds counts as success, which
    makes retries of the *same signed bytes* idempotent.
    """
    try:
        await fm.submit_message(message)
    except fm.SubmitMessageError as exc:
        if not is_duplicate_submit(exc):
            raise
        logger.info(
            "[farcaster-writes] %s already on node; treating as published",
            fm.message_hash_hex(message),
        )
    return fm.message_hash_hex(message)


async def publish_cast(
    signer: Signer,
    *,
    text: str,
    embed_urls: Sequence[str] = (),
    quote: fm.CastRef | None = None,
    parent_hash: str | None = None,
    channel_id: str | None = None,
    resolve_username: UsernameResolver | None = None,
    timestamp: int | None = None,
) -> str:
    """Validate, sign and submit one cast; return its hash."""
    if parent_hash and channel_id:
        raise CastValidationError("Replies cannot target a channel")
    prepared = await prepare_cast(
        text=text,
        embed_urls=embed_urls,
        quote=quote,
        channel_id=channel_id,
        resolve_username=resolve_username,
    )
    parent = await resolve_parent(parent_hash)
    return await submit(
        build_cast(signer, prepared, parent=parent, timestamp=timestamp)
    )


async def publish_cast_removal(signer: Signer, cast_hash: str) -> str:
    message = fm.build_cast_remove(
        signer.fid, parse_cast_hash(cast_hash), signer_private_key=signer.private_key
    )
    return await submit(message)


async def publish_reaction(
    signer: Signer,
    *,
    action: fm.Action,
    reaction_type: fm.ReactionKind,
    target_hash: str,
    target_fid: int | None = None,
) -> str:
    """Like/recast (or undo) a cast. ``target_fid`` skips the author lookup."""
    author_fid = target_fid or await resolve_cast_author(target_hash)
    message = fm.build_reaction(
        signer.fid,
        action,
        reaction_type,
        cast_ref(author_fid, target_hash),
        signer_private_key=signer.private_key,
    )
    return await submit(message)


async def publish_follow(signer: Signer, *, action: fm.Action, target_fid: int) -> str:
    message = fm.build_link(
        signer.fid,
        action,
        fm.LINK_TYPE_FOLLOW,
        target_fid,
        signer_private_key=signer.private_key,
    )
    return await submit(message)


def cast_response(cast_hash: str, *, fid: int, text: str) -> dict[str, Any]:
    """Neynar-compatible ``POST /cast`` body (clients read ``cast.hash``)."""
    return {
        "success": True,
        "cast": {"hash": cast_hash, "author": {"fid": fid}, "text": text},
    }


# ---------------------------------------------------------------------------
# Router boundary
# ---------------------------------------------------------------------------


def submit_error_as_http(exc: fm.SubmitMessageError) -> HTTPException:
    if is_signer_rejection(exc):
        return HTTPException(status_code=403, detail=SIGNER_NOT_LINKED_DETAIL)
    if is_transient_submit_error(exc):
        return HTTPException(status_code=502, detail=UPSTREAM_ERROR_DETAIL)
    return HTTPException(status_code=400, detail=NODE_REJECTED_DETAIL)


@contextmanager
def write_errors_as_http(context: str) -> Iterator[None]:
    """Translate write-path failures into sanitized ``HTTPException`` s.

    ``SignerNotApprovedError`` → 403 ``signer_not_linked``; key/config
    problems → opaque 503; local validation → 400; unknown parent/target →
    404; node rejections → 400/403/502; read-lookup failures → the shared
    Hypersnap upstream mapping.
    """
    try:
        yield
    except user_signer_service.SignerNotApprovedError:
        raise HTTPException(status_code=403, detail=SIGNER_NOT_LINKED_DETAIL) from None
    except (
        SignerKeyConfigError,
        SignerDecryptError,
        SystemSignerUnavailableError,
    ) as exc:
        logger.error("[%s] signer unavailable: %s", context, type(exc).__name__)
        raise HTTPException(status_code=503, detail=SIGNER_UNAVAILABLE_DETAIL) from None
    except (CastValidationError, fm.MessageBuildError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except CastNotFoundError:
        raise HTTPException(status_code=404, detail=CAST_NOT_FOUND_DETAIL) from None
    except fm.SubmitMessageError as exc:
        raise submit_error_as_http(exc) from None
    except hypersnap.HypersnapError as exc:
        hypersnap.raise_for_upstream(exc, context=context)
