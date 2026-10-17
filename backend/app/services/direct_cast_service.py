"""Direct Casts (Farcaster DMs) behind a swappable service seam.

``DirectCastService`` is the implementation-agnostic interface the
``/v1/messages`` router depends on (docs/messaging-design.md, 4.3).
``FarcasterDirectCastService`` proxies the plaintext V3 Direct Cast API on
``client.farcaster.xyz``; a Juke-native implementation (section 8) can slot
in behind the same routes by implementing the protocol and teaching
:func:`build_direct_cast_service` about ``MESSAGING_BACKEND="native"``.

Credentials (section 3.2): ``client.farcaster.xyz`` only accepts the
custody-minted Direct Casts token (``PUT /v2/onboarding-state``); app-key
JFS bearers are rejected (B1). Every request loads the caller's stored token
via ``farcaster_token_service.get_direct_cast_bearer``; with none the caller
gets 403 ``messaging_token_missing`` / ``messaging_token_expired`` and runs
the "Enable messages" flow. Bearers are never cached, logged, echoed in
errors or attached to exceptions; upstream failures surface as
:class:`DirectCastUpstreamError` carrying only ``(status, path_tag)``.

Normalization (``normalize_*``) is pure: upstream camelCase in, the frozen
snake_case contract (``app.schemas.messages``) out. Records that cannot be
normalized (unknown message type, missing ids) are dropped rather than
failing the whole page, so a new upstream message type never blanks a
conversation.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any, Protocol, get_args, runtime_checkable
from urllib.parse import urlsplit

import httpx
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import hypersnap
from app.config import Settings
from app.schemas.messages import (
    Conversation,
    ConversationCategory,
    HighlightRange,
    InboxFilter,
    InboxResponse,
    Message,
    MessageMedia,
    MessageMetadata,
    MessageQuote,
    MessageReactionSummary,
    MessageSearchHit,
    MessagesPage,
    MessageType,
    MessageUrlEmbed,
    MessageUser,
    Page,
    ReactionRequest,
    ReactorEntry,
    SendMessageRequest,
)
from app.services import farcaster_token_service, signer_crypto

logger = logging.getLogger(__name__)

DIRECT_CAST_API_BASE_URL = "https://client.farcaster.xyz"
UPSTREAM_ORIGIN = "https://farcaster.xyz"
# Cloudflare serves its bot page to non-browser user agents on some paths.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT_SECONDS = 10.0
RETRY_ATTEMPTS = 2
RETRY_BASE_SECONDS = 0.25
READ_CACHE_TTL_SECONDS = 3
READ_CACHE_PREFIX = "messages:cache:"
# Per-fid read-cache generation, INCR'd on every write so a read after a
# write never serves a pre-write envelope. Outlives any cached entry by far;
# if it lapses it restarts at 0, by which time every old entry has expired.
READ_CACHE_VERSION_PREFIX = "messages:cache_ver:"
READ_CACHE_VERSION_TTL_SECONDS = 24 * 60 * 60
# In-thread search scans at most this many upstream search pages per call.
MAX_SEARCH_SCAN_PAGES = 3
# In-thread search resumes mid-page with its own cursor (docs 4.5):
# ``ts1.`` + base64url JSON ``{"c": upstream_cursor | null, "o": offset,
# "n": upstream_page_limit}``. Anything else is a raw upstream cursor.
SCOPED_SEARCH_CURSOR_PREFIX = "ts1."
MAX_SCOPED_SEARCH_OFFSET = 1000
MAX_SEARCH_PAGE_LIMIT = 100
# Upstream 400 detail surfaced to the client (sanitized, docs 4.2).
MAX_UPSTREAM_MESSAGE_CHARS = 200
# Only small JSON error bodies are inspected for a message.
MAX_UPSTREAM_ERROR_BODY_BYTES = 16 * 1024
REDACTED = "[redacted]"
# "Bearer xyz" and any long token-like run (JWTs, base64, hex keys).
SECRETISH_RE = re.compile(r"(?i)\bbearer\s+\S+|[A-Za-z0-9_\-+/=.]{32,}")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]+")
# Send echo quote when the quoted message is not in the recent-messages
# cache: only the id is known (docs 4.1, ``MessageQuote``).
UNKNOWN_QUOTE_SENDER_FID = 0
# Upstream answers 403 for a conversation that does not exist yet; the
# official client treats that as an empty new conversation.
UNKNOWN_CONVERSATION_STATUS = 403
UNAUTHORIZED_STATUS = 401
BAD_REQUEST_STATUS = 400

PATH_INBOX = "/v2/direct-cast-inbox"
PATH_CONVERSATION = "/v2/direct-cast-conversation"
PATH_MESSAGES = "/v2/direct-cast-conversation-messages"
PATH_RECENT_MESSAGES = "/v2/direct-cast-conversation-recent-messages"
PATH_SEND = "/v2/direct-cast-send"
PATH_METADATA = "/v2/direct-cast-message-metadata"
PATH_REACTION = "/v2/direct-cast-message-reaction"
PATH_MARK_READ = "/v2/direct-cast-mark-read"
PATH_MARK_UNREAD = "/v2/direct-cast-manually-mark-unread"
PATH_DELETE_MESSAGE = "/v2/delete-message"
PATH_MESSAGE_SEARCH = "/v2/direct-cast-message-search"
PATH_INBOX_SEARCH = "/v2/search-direct-cast-inbox"
PATH_RECIPIENTS = "/v2/direct-cast-users"
PATH_CATEGORIZATION = "/v2/direct-cast-conversation-categorization"

# Upstream ``ApiDirectCastConversationAlterCategory`` values used for message
# requests: accepting moves a request into the inbox, declining deletes it
# from the viewer's side only (the sender still sees it).
CATEGORY_ACCEPT = "default"
CATEGORY_DECLINE = "deleted"
# Upstream statuses that mean "no such conversation for this viewer".
CONVERSATION_MISSING_STATUSES = frozenset({UNKNOWN_CONVERSATION_STATUS, 404})

# Search snippets wrap matched terms in these tags (OpenSearch highlighter;
# ``fc_highlight`` upstream, ``em`` accepted for the default highlighter).
HIGHLIGHT_TAG_RE = re.compile(r"<(fc_highlight|em)>(.*?)</\1>", re.DOTALL)
# Upstream thread cursor (base64 JSON ``{page, limit, before?, after?,
# midpoint?}``); the official client splits it into one cursor per direction.
CURSOR_SHARED_KEYS = ("limit", "page")
CURSOR_OLDER_KEY = "before"
CURSOR_NEWER_KEY = "after"

MESSAGE_TYPES: frozenset[str] = frozenset(get_args(MessageType))
CONVERSATION_CATEGORIES: frozenset[str] = frozenset(get_args(ConversationCategory))
DEFAULT_CATEGORY: ConversationCategory = "default"


# ---------------------------------------------------------------------------
# Errors (router maps ``status_code`` + ``code`` onto an HTTPException)
# ---------------------------------------------------------------------------


class MessagingError(Exception):
    """A failure with a client-safe HTTP status and opaque detail tag.

    ``client_message`` is an optional, already-sanitized human-readable
    string the router adds to the body as ``message`` (only
    ``upstream_rejected`` sets it).
    """

    def __init__(
        self, status_code: int, code: str, *, client_message: str | None = None
    ) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.client_message = client_message


class MessagingAuthError(MessagingError):
    """The caller has no usable upstream credential for their fid."""


class MessagingBackendUnavailable(MessagingError):
    def __init__(self) -> None:
        super().__init__(503, "messaging_backend_unavailable")


# upstream status -> (client status, detail). Everything else is 502.
# Opaque 403/503 details for the stored DC token. Clients map the 403s to
# the "Enable messages" flow (sign a fresh ``generateToken`` with custody).
TOKEN_MISSING = "messaging_token_missing"
TOKEN_EXPIRED = "messaging_token_expired"
TOKEN_REJECTED = "messaging_token_rejected"
TOKEN_UNAVAILABLE = "messaging_token_unavailable"
UPSTREAM_REJECTED = "upstream_rejected"

_UPSTREAM_STATUS_MAP: dict[int, tuple[int, str]] = {
    # Upstream revoked or no longer honours the stored token.
    UNAUTHORIZED_STATUS: (403, TOKEN_REJECTED),
    # Upstream refused the request itself (bad content / state): the
    # client's input, not our outage, so not a 502.
    BAD_REQUEST_STATUS: (422, UPSTREAM_REJECTED),
    403: (403, "upstream_forbidden"),
    404: (404, "not_found"),
    429: (429, "upstream_rate_limited"),
}
UPSTREAM_ERROR = (502, "upstream_error")


class DirectCastUpstreamError(MessagingError):
    """Upstream non-2xx, transport failure or malformed envelope.

    Carries only the upstream status (``None`` for transport/shape
    failures), a ``"METHOD /path"`` tag and, for upstream 400s, a
    sanitized length-capped message (:func:`sanitize_upstream_message`) —
    never a raw body, header or bearer.
    """

    def __init__(
        self,
        upstream_status: int | None,
        path_tag: str,
        *,
        client_message: str | None = None,
    ) -> None:
        status_code, code = _UPSTREAM_STATUS_MAP.get(
            upstream_status or 0, UPSTREAM_ERROR
        )
        super().__init__(status_code, code, client_message=client_message)
        self.upstream_status = upstream_status
        self.path_tag = path_tag

    def __str__(self) -> str:
        return f"{self.code} ({self.upstream_status} {self.path_tag})"


# ---------------------------------------------------------------------------
# Viewer credential
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MessagingViewer:
    """The authenticated caller plus the credential the backend acts with.

    ``bearer`` is the custody-minted Direct Casts token for the Farcaster
    backend and ``None`` for a backend that needs none. Excluded from
    ``repr`` so it cannot reach a log line or traceback through string
    formatting.
    """

    fid: int
    bearer: str | None = field(default=None, repr=False)

    def require_bearer(self) -> str:
        if not self.bearer:
            raise MessagingAuthError(403, TOKEN_MISSING)
        return self.bearer


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------


@runtime_checkable
class DirectCastService(Protocol):
    """Everything the messaging routes need; implementations are swappable.

    Every method acts strictly as ``viewer.fid`` — callers never pass an
    acting fid separately, so no route can act on another user's behalf.
    """

    async def authorize(self, db: AsyncSession, *, fid: int) -> MessagingViewer: ...

    async def inbox(
        self,
        viewer: MessagingViewer,
        *,
        category: ConversationCategory,
        filter_: InboxFilter | None,
        cursor: str | None,
        limit: int,
    ) -> InboxResponse: ...

    async def conversation(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> Conversation: ...

    async def conversation_with(
        self, viewer: MessagingViewer, peer_fid: int
    ) -> Conversation: ...

    async def messages(
        self,
        viewer: MessagingViewer,
        conversation_id: str,
        *,
        cursor: str | None,
        anchor_message_id: str | None,
        limit: int,
    ) -> MessagesPage: ...

    async def recent_messages(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> Page[Message]: ...

    async def send(
        self, viewer: MessagingViewer, body: SendMessageRequest, *, sender: MessageUser
    ) -> Message: ...

    async def react(
        self, viewer: MessagingViewer, body: ReactionRequest, *, remove: bool
    ) -> None: ...

    async def reactors(
        self,
        viewer: MessagingViewer,
        conversation_id: str,
        message_id: str,
        *,
        cursor: str | None,
        limit: int,
    ) -> Page[ReactorEntry]: ...

    async def mark_read(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> None: ...

    async def mark_unread(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> None: ...

    async def accept_request(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> None: ...

    async def decline_request(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> None: ...

    async def delete_message(
        self, viewer: MessagingViewer, conversation_id: str, message_id: str
    ) -> None: ...

    async def search_messages(
        self,
        viewer: MessagingViewer,
        q: str,
        *,
        conversation_id: str | None,
        cursor: str | None,
        limit: int,
    ) -> Page[MessageSearchHit]: ...

    async def search_conversations(
        self,
        viewer: MessagingViewer,
        q: str,
        *,
        category: ConversationCategory,
        cursor: str | None,
        limit: int,
    ) -> Page[Conversation]: ...

    async def search_recipients(
        self, viewer: MessagingViewer, q: str, *, cursor: str | None, limit: int
    ) -> Page[MessageUser]: ...

    async def preview_metadata(
        self, viewer: MessagingViewer, text: str
    ) -> MessageMetadata: ...

    async def aclose(self) -> None: ...


def build_direct_cast_service(settings: Settings, redis: Any) -> DirectCastService:
    """Instantiate the implementation selected by ``MESSAGING_BACKEND``."""
    if settings.MESSAGING_BACKEND == "farcaster":
        return FarcasterDirectCastService(
            redis=redis, on_token_rejected=revoke_rejected_token_in_new_session
        )
    # "native" (docs/messaging-design.md section 8) is not built yet.
    raise MessagingBackendUnavailable()


# ---------------------------------------------------------------------------
# Pure helpers: ids + normalization
# ---------------------------------------------------------------------------


def derive_one_to_one_conversation_id(fid: int, peer_fid: int) -> str:
    """``"<lowerFid>-<higherFid>"`` [inferred format, docs section 1.4]."""
    if peer_fid == fid:
        raise MessagingError(400, "invalid_recipient")
    low, high = sorted((fid, peer_fid))
    return f"{low}-{high}"


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


# Upstream metadata is relayed to clients that render images and open
# links; anything but these schemes (javascript:, data:, file:, intent:,
# plain-http images…) is dropped rather than passed through.
IMAGE_URL_SCHEMES = frozenset({"https"})
LINK_URL_SCHEMES = frozenset({"http", "https"})


def _url_or_none(value: Any, schemes: frozenset[str]) -> str | None:
    """``value`` if it's an absolute URL with a host and an allowed scheme."""
    url = _str_or_none(value)
    if url is None:
        return None
    url = url.strip()
    # urlsplit silently drops tabs/newlines, which would let a scheme like
    # "java\tscript:" be judged differently from how a client parses it.
    if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in url):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme.lower() not in schemes or not parts.hostname:
        return None
    return url


def _image_url_or_none(value: Any) -> str | None:
    return _url_or_none(value, IMAGE_URL_SCHEMES)


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _int_or(value: Any, default: int) -> int:
    number = _int_or_none(value)
    return default if number is None else number


def _positive_fid(value: Any) -> int | None:
    """``value`` if it is a real ``int`` fid (not ``bool``/``float``) > 0."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _dicts(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, Mapping)]


def _fallback_display_name(fid: int) -> str:
    return f"!{fid}"


def normalize_user(raw: Any) -> MessageUser | None:
    """``ApiUser`` / ``senderContext`` / Hypersnap user -> ``MessageUser``."""
    if not isinstance(raw, Mapping):
        return None
    fid = _positive_fid(raw.get("fid"))
    if fid is None:
        return None
    username = _str_or_none(raw.get("username"))
    pfp = raw.get("pfp")
    pfp_url = _image_url_or_none(pfp.get("url")) if isinstance(pfp, Mapping) else None
    pfp_url = pfp_url or _image_url_or_none(raw.get("pfp_url"))
    display_name = (
        _str_or_none(raw.get("displayName"))
        or _str_or_none(raw.get("display_name"))
        or username
        or _fallback_display_name(fid)
    )
    return MessageUser(
        fid=fid, username=username, display_name=display_name, pfp_url=pfp_url
    )


def _normalize_users(raw: Any) -> list[MessageUser]:
    return [user for item in _dicts(raw) if (user := normalize_user(item))]


def _normalize_media(raw: Mapping[str, Any]) -> MessageMedia | None:
    url = _image_url_or_none(raw.get("staticRaster")) or _image_url_or_none(
        raw.get("url")
    )
    if url is None:
        return None
    return MessageMedia(
        url=url,
        width=_int_or(raw.get("width"), 0),
        height=_int_or(raw.get("height"), 0),
        mime_type=_str_or_none(raw.get("mimeType")),
    )


def _normalize_url_embed(raw: Mapping[str, Any]) -> MessageUrlEmbed | None:
    og = _mapping(raw.get("openGraph"))
    url = (
        _url_or_none(og.get("url"), LINK_URL_SCHEMES)
        or _url_or_none(og.get("sourceUrl"), LINK_URL_SCHEMES)
        or _url_or_none(raw.get("url"), LINK_URL_SCHEMES)
    )
    if url is None:
        return None
    image = og.get("image")
    image_url = (
        _image_url_or_none(image.get("url")) if isinstance(image, Mapping) else None
    )
    domain = _str_or_none(og.get("domain")) or (urlsplit(url).hostname or None)
    return MessageUrlEmbed(
        url=url,
        title=_str_or_none(og.get("title")),
        description=_str_or_none(og.get("description")),
        image_url=image_url or _image_url_or_none(image),
        domain=domain,
    )


def normalize_metadata(raw: Any) -> MessageMetadata | None:
    if not isinstance(raw, Mapping):
        return None
    medias = [m for item in _dicts(raw.get("medias")) if (m := _normalize_media(item))]
    urls = [u for item in _dicts(raw.get("urls")) if (u := _normalize_url_embed(item))]
    cast_hashes = [
        h for item in _dicts(raw.get("casts")) if (h := _str_or_none(item.get("hash")))
    ]
    return MessageMetadata(
        medias=medias,
        urls=urls,
        mentions=_normalize_users(raw.get("mentions")),
        cast_hashes=cast_hashes,
    )


def _sender_of(raw: Mapping[str, Any]) -> MessageUser | None:
    sender = normalize_user(raw.get("senderContext"))
    if sender is not None:
        return sender
    fid = _positive_fid(raw.get("senderFid"))
    if fid is None:
        return None
    return MessageUser(fid=fid, display_name=_fallback_display_name(fid))


def _normalize_quote(raw: Any) -> MessageQuote | None:
    if not isinstance(raw, Mapping):
        return None
    message_id = _str_or_none(raw.get("messageId"))
    sender = _sender_of(raw)
    if message_id is None or sender is None:
        return None
    return MessageQuote(
        message_id=message_id,
        sender=sender,
        text=raw.get("message") if isinstance(raw.get("message"), str) else "",
        is_deleted=bool(raw.get("isDeleted", False)),
    )


def normalize_message(raw: Any) -> Message | None:
    """``ApiDirectCastMessageV3`` -> ``Message``; ``None`` if unrenderable."""
    if not isinstance(raw, Mapping):
        return None
    message_id = _str_or_none(raw.get("messageId"))
    conversation_id = _str_or_none(raw.get("conversationId"))
    message_type = raw.get("type")
    sender = _sender_of(raw)
    if message_id is None or conversation_id is None or sender is None:
        return None
    if message_type not in MESSAGE_TYPES:
        logger.debug("[direct-cast] dropping unknown message type")
        return None
    viewer_context = _mapping(raw.get("viewerContext"))
    viewer_reactions = viewer_context.get("reactions")
    viewer_reacted = (
        set(viewer_reactions) if isinstance(viewer_reactions, list) else set()
    )
    reactions = [
        MessageReactionSummary(
            reaction=item["reaction"],
            count=_int_or(item.get("count"), 0),
            viewer_reacted=item["reaction"] in viewer_reacted,
        )
        for item in _dicts(raw.get("reactions"))
        if _str_or_none(item.get("reaction"))
    ]
    text = raw.get("message")
    return Message(
        message_id=message_id,
        conversation_id=conversation_id,
        sender=sender,
        type=message_type,
        text=text if isinstance(text, str) else "",
        sent_at=_int_or(raw.get("serverTimestamp"), 0),
        reactions=reactions,
        in_reply_to=_normalize_quote(raw.get("inReplyTo")),
        metadata=normalize_metadata(raw.get("metadata")),
        is_deleted=bool(raw.get("isDeleted", False)),
        is_pinned=bool(raw.get("isPinned", False)),
        is_last_read=bool(viewer_context.get("isLastReadMessage", False)),
    )


def _normalize_messages(raw: Any) -> list[Message]:
    return [m for item in _dicts(raw) if (m := normalize_message(item))]


def normalize_conversation(raw: Any) -> Conversation | None:
    """``ApiDirectCast(Inbox)ConversationInfoV3`` -> ``Conversation``."""
    if not isinstance(raw, Mapping):
        return None
    conversation_id = _str_or_none(raw.get("conversationId"))
    if conversation_id is None:
        return None
    viewer_context = _mapping(raw.get("viewerContext"))
    is_group = bool(raw.get("isGroup", False))
    category = viewer_context.get("category")
    access = viewer_context.get("access")
    return Conversation(
        conversation_id=conversation_id,
        is_group=is_group,
        name=_str_or_none(raw.get("name")),
        photo_url=_image_url_or_none(raw.get("photoUrl")),
        participants=_normalize_users(raw.get("participants")),
        counterparty=(
            None if is_group else normalize_user(viewer_context.get("counterParty"))
        ),
        last_message=normalize_message(raw.get("lastMessage")),
        unread_count=_int_or(
            viewer_context.get("unreadCount"), _int_or(raw.get("unreadCount"), 0)
        ),
        unread_mentions_count=_int_or(viewer_context.get("unreadMentionsCount"), 0),
        muted=bool(viewer_context.get("muted", raw.get("muted", False))),
        pinned=bool(viewer_context.get("pinned", False)),
        archived=bool(viewer_context.get("archived", False)),
        category=category if category in CONVERSATION_CATEGORIES else DEFAULT_CATEGORY,
        access=access if access in ("read", "read-write") else "read-write",
        last_read_at=_int_or(
            viewer_context.get("lastReadAt"), _int_or(raw.get("selfLastReadTime"), 0)
        ),
        manually_marked_unread=bool(viewer_context.get("manuallyMarkedUnread", False)),
        created_at=_int_or(raw.get("createdAt"), 0),
        peer_last_read_at=None if is_group else _int_or_none(raw.get("lastReadTime")),
    )


def _normalize_conversations(raw: Any) -> list[Conversation]:
    return [c for item in _dicts(raw) if (c := normalize_conversation(item))]


def normalize_search_hit(raw: Any) -> MessageSearchHit | None:
    if not isinstance(raw, Mapping):
        return None
    message = normalize_message(raw.get("result"))
    conversation = normalize_conversation(raw.get("conversation"))
    if message is None or conversation is None:
        return None
    raw_highlights = raw.get("highlights")
    highlights = (
        [h for h in raw_highlights if isinstance(h, str)]
        if isinstance(raw_highlights, list)
        else []
    )
    ranges, terms = highlight_ranges(message.text, highlights)
    thread_cursor, thread_newer_cursor = split_thread_cursor(
        _str_or_none(raw.get("surroundingMessagesCursor"))
    )
    return MessageSearchHit(
        message=message,
        conversation=conversation,
        highlights=highlights,
        before=_newest_first(_normalize_messages(raw.get("messagesBefore"))),
        after=_newest_first(_normalize_messages(raw.get("messagesAfter"))),
        highlight_ranges=ranges,
        matched_terms=terms,
        thread_cursor=thread_cursor,
        thread_newer_cursor=thread_newer_cursor,
    )


def _newest_first(messages: list[Message]) -> list[Message]:
    """Stable sort by ``sent_at`` descending (the documented page order)."""
    return sorted(messages, key=lambda message: message.sent_at, reverse=True)


# -- search highlights -------------------------------------------------------


def _parse_snippet(snippet: str) -> tuple[str, list[tuple[int, int]], list[str]]:
    """Strip highlight tags: ``(plain, [(start, end)], [term])`` (code points)."""
    plain: list[str] = []
    spans: list[tuple[int, int]] = []
    terms: list[str] = []
    length = 0
    position = 0
    for match in HIGHLIGHT_TAG_RE.finditer(snippet):
        before = snippet[position : match.start()]
        plain.append(before)
        length += len(before)
        term = match.group(2)
        if term:
            spans.append((length, length + len(term)))
            terms.append(term)
        plain.append(term)
        length += len(term)
        position = match.end()
    plain.append(snippet[position:])
    return "".join(plain), spans, terms


def _utf16_offset(text: str, index: int) -> int:
    return len(text[:index].encode("utf-16-le")) // 2


def _merge_spans(spans: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def highlight_ranges(
    text: str, snippets: Sequence[str]
) -> tuple[list[HighlightRange], list[str]]:
    """Map tagged snippets onto ``text``: UTF-16 ranges + distinct terms.

    A snippet whose plain text occurs verbatim in ``text`` contributes its
    exact tag positions. Otherwise (snippet truncated or re-flowed by the
    highlighter) every case-insensitive occurrence of its terms counts.
    """
    spans: list[tuple[int, int]] = []
    terms: list[str] = []
    for snippet in snippets:
        plain, snippet_spans, snippet_terms = _parse_snippet(snippet)
        for term in snippet_terms:
            if term not in terms:
                terms.append(term)
        offset = text.find(plain) if plain else -1
        if offset >= 0:
            spans.extend((offset + start, offset + end) for start, end in snippet_spans)
            continue
        for term in snippet_terms:
            spans.extend(
                match.span()
                for match in re.finditer(re.escape(term), text, re.IGNORECASE)
            )
    ranges = [
        HighlightRange(start=_utf16_offset(text, start), end=_utf16_offset(text, end))
        for start, end in _merge_spans(spans)
        if end > start
    ]
    return ranges, terms


# -- thread cursors ----------------------------------------------------------


def _decode_cursor(cursor: str) -> dict[str, Any] | None:
    padded = cursor + "=" * (-len(cursor) % 4)
    for decode in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            value = json.loads(decode(padded.encode("ascii")))
        except (binascii.Error, UnicodeError, ValueError):
            continue
        return value if isinstance(value, dict) else None
    return None


def _encode_cursor(value: Mapping[str, Any]) -> str:
    raw = json.dumps(dict(value), separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii").rstrip("=")


def split_thread_cursor(cursor: str | None) -> tuple[str | None, str | None]:
    """Upstream thread cursor -> ``(older_cursor, newer_cursor)``.

    Mirrors the official client: the older cursor keeps ``before``, the
    newer one keeps ``after`` (``midpoint`` is dropped). A cursor that does
    not decode is passed through unchanged as the older cursor, which is
    what upstream ``next.cursor`` has always meant.
    """
    if cursor is None:
        return None, None
    decoded = _decode_cursor(cursor)
    if decoded is None:
        return cursor, None
    shared = {key: decoded[key] for key in CURSOR_SHARED_KEYS if key in decoded}

    def one_way(key: str) -> str | None:
        if decoded.get(key) is None:
            return None
        return _encode_cursor({**shared, key: decoded[key]})

    return one_way(CURSOR_OLDER_KEY), one_way(CURSOR_NEWER_KEY)


def _result(envelope: Mapping[str, Any], path_tag: str) -> Mapping[str, Any]:
    result = envelope.get("result")
    if not isinstance(result, Mapping):
        raise DirectCastUpstreamError(None, path_tag)
    return result


def _next_cursor(envelope: Mapping[str, Any]) -> str | None:
    nxt = envelope.get("next")
    return _str_or_none(nxt.get("cursor")) if isinstance(nxt, Mapping) else None


def _expect_success(envelope: Mapping[str, Any], path_tag: str) -> None:
    if _result(envelope, path_tag).get("success") is not True:
        raise DirectCastUpstreamError(None, path_tag)


def _now_ms() -> int:
    return int(time.time() * 1000)


def sanitize_upstream_message(raw: Any, *, secrets: Iterable[str] = ()) -> str | None:
    """Client-safe version of an upstream error string, or ``None``.

    Drops control characters, redacts the caller's bearer (and anything
    shaped like a bearer/JWT/key) and caps at
    :data:`MAX_UPSTREAM_MESSAGE_CHARS`. Never pass headers in.
    """
    if not isinstance(raw, str):
        return None
    text = raw
    for secret in secrets:
        if secret:
            text = text.replace(secret, REDACTED)
    text = SECRETISH_RE.sub(REDACTED, text)
    text = CONTROL_CHARS_RE.sub(" ", text).strip()
    if not text:
        return None
    if len(text) > MAX_UPSTREAM_MESSAGE_CHARS:
        text = text[: MAX_UPSTREAM_MESSAGE_CHARS - 1].rstrip() + "\u2026"
    return text


def _upstream_error_message(response: httpx.Response) -> Any:
    """The ``errors[0].message`` / ``message`` of a small JSON error body."""
    if len(response.content) > MAX_UPSTREAM_ERROR_BODY_BYTES:
        return None
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, Mapping):
        return None
    errors = body.get("errors")
    if isinstance(errors, list) and errors and isinstance(errors[0], Mapping):
        return errors[0].get("message")
    return body.get("message")


# Scoped (in-thread) search cursor, docs 4.5.
@dataclass(frozen=True)
class _ScopedSearchCursor:
    upstream_cursor: str | None
    offset: int
    page_limit: int


def _encode_scoped_search_cursor(cursor: _ScopedSearchCursor) -> str:
    return SCOPED_SEARCH_CURSOR_PREFIX + base64.urlsafe_b64encode(
        json.dumps(
            {"c": cursor.upstream_cursor, "o": cursor.offset, "n": cursor.page_limit},
            separators=(",", ":"),
        ).encode("utf-8")
    ).decode("ascii").rstrip("=")


def _decode_scoped_search_cursor(cursor: str | None, limit: int) -> _ScopedSearchCursor:
    """Our ``ts1.`` cursor, or a raw upstream cursor resuming at offset 0."""
    if cursor is None or not cursor.startswith(SCOPED_SEARCH_CURSOR_PREFIX):
        return _ScopedSearchCursor(cursor, 0, limit)
    encoded = cursor.removeprefix(SCOPED_SEARCH_CURSOR_PREFIX)
    try:
        value = json.loads(
            base64.urlsafe_b64decode((encoded + "=" * (-len(encoded) % 4)).encode())
        )
    except (binascii.Error, UnicodeError, ValueError):
        raise MessagingError(400, "invalid_cursor") from None
    if not isinstance(value, dict):
        raise MessagingError(400, "invalid_cursor")
    upstream, offset, page_limit = value.get("c"), value.get("o"), value.get("n")
    if (
        not (upstream is None or isinstance(upstream, str))
        or not isinstance(offset, int)
        or isinstance(offset, bool)
        or not 0 < offset <= MAX_SCOPED_SEARCH_OFFSET
        or not isinstance(page_limit, int)
        or isinstance(page_limit, bool)
        or not 0 < page_limit <= MAX_SEARCH_PAGE_LIMIT
    ):
        raise MessagingError(400, "invalid_cursor")
    return _ScopedSearchCursor(upstream, offset, page_limit)


# ---------------------------------------------------------------------------
# Profile lookup for bare fids (who-reacted)
# ---------------------------------------------------------------------------

UserLookup = Callable[[Sequence[int]], Awaitable[dict[int, MessageUser]]]


async def lookup_users_via_hypersnap(fids: Sequence[int]) -> dict[int, MessageUser]:
    """Best-effort ``/user/bulk`` hydration (same source as ``users.py``)."""
    wanted = sorted({fid for fid in fids if fid > 0})
    if not wanted:
        return {}
    try:
        data = await hypersnap.get("/user/bulk", {"fids": ",".join(map(str, wanted))})
    except hypersnap.HypersnapError as exc:
        logger.warning("[direct-cast] reactor profile lookup failed: %s", exc)
        return {}
    users = _normalize_users(data.get("users"))
    return {user.fid: user for user in users}


# ---------------------------------------------------------------------------
# Upstream-rejected token (docs section 3.2)
# ---------------------------------------------------------------------------

# ``(fid, rejected_bearer)``; must never raise.
TokenRejectedHook = Callable[[int, str], Awaitable[None]]
SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


async def revoke_rejected_token(
    session_factory: SessionFactory, fid: int, bearer: str
) -> None:
    """Best-effort compare-and-delete of a token upstream answered 401 to."""
    try:
        async with session_factory() as db:
            revoked = await farcaster_token_service.revoke_rejected_token(
                db, fid, bearer=bearer
            )
    except (
        SQLAlchemyError,
        OSError,
        signer_crypto.SignerKeyConfigError,
        signer_crypto.SignerDecryptError,
    ) as exc:
        logger.warning(
            "[direct-cast] could not revoke rejected token fid=%d (%s)",
            fid,
            type(exc).__name__,
        )
        return
    if revoked:
        logger.info("[direct-cast] revoked upstream-rejected token fid=%d", fid)


async def revoke_rejected_token_in_new_session(fid: int, bearer: str) -> None:
    from app.database import async_session

    await revoke_rejected_token(async_session, fid, bearer)


# ---------------------------------------------------------------------------
# Farcaster upstream implementation
# ---------------------------------------------------------------------------


class FarcasterDirectCastService:
    """``DirectCastService`` backed by ``client.farcaster.xyz``.

    One shared ``httpx.AsyncClient`` (lazily built, no redirects). GET
    envelopes are cached in Redis for :data:`READ_CACHE_TTL_SECONDS` per
    ``(fid, version, path, params)`` so several tabs/devices polling the same
    view do not multiply upstream calls; every write bumps the fid's
    ``version`` so the next read misses. Writes are never cached and never
    retried unless idempotent upstream (send carries an ``idempotency-key``).
    """

    def __init__(
        self,
        *,
        redis: Any,
        http: httpx.AsyncClient | None = None,
        base_url: str = DIRECT_CAST_API_BASE_URL,
        retry_base_seconds: float = RETRY_BASE_SECONDS,
        cache_ttl_seconds: int = READ_CACHE_TTL_SECONDS,
        user_lookup: UserLookup = lookup_users_via_hypersnap,
        on_token_rejected: TokenRejectedHook | None = None,
    ) -> None:
        self._redis = redis
        self._on_token_rejected = on_token_rejected
        self._http = http
        self._base_url = base_url.rstrip("/")
        self._retry_base_seconds = retry_base_seconds
        self._cache_ttl_seconds = cache_ttl_seconds
        self._user_lookup = user_lookup

    # -- lifecycle ---------------------------------------------------------

    def _get_http_client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # -- credentials (docs section 3.2) -------------------------------------

    async def authorize(self, db: AsyncSession, *, fid: int) -> MessagingViewer:
        try:
            bearer = await farcaster_token_service.get_direct_cast_bearer(db, fid)
        except (
            signer_crypto.SignerKeyConfigError,
            signer_crypto.SignerDecryptError,
        ) as exc:
            logger.error(
                "[direct-cast] stored token unusable fid=%d (%s)",
                fid,
                type(exc).__name__,
            )
            raise MessagingAuthError(503, TOKEN_UNAVAILABLE) from None
        if bearer is not None:
            return MessagingViewer(fid=fid, bearer=bearer)
        token = await farcaster_token_service.get_token_status(db, fid)
        code = (
            TOKEN_EXPIRED
            if token.token_status == farcaster_token_service.TOKEN_STATUS_EXPIRED
            else TOKEN_MISSING
        )
        raise MessagingAuthError(403, code)

    # -- transport -----------------------------------------------------------

    def _headers(self, bearer: str, idempotency_key: str | None) -> dict[str, str]:
        headers = {
            "authorization": f"Bearer {bearer}",
            "accept": "application/json",
            "content-type": "application/json",
            "origin": UPSTREAM_ORIGIN,
            "referer": f"{UPSTREAM_ORIGIN}/",
            "user-agent": BROWSER_USER_AGENT,
        }
        if idempotency_key is not None:
            headers["idempotency-key"] = idempotency_key
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        viewer: MessagingViewer,
        params: Mapping[str, Any] | None = None,
        json_body: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        retry: bool = True,
    ) -> dict[str, Any]:
        """The single place that talks to upstream. Returns the envelope."""
        path_tag = f"{method} {path}"
        bearer = viewer.require_bearer()
        headers = self._headers(bearer, idempotency_key)
        attempts = RETRY_ATTEMPTS if retry else 1
        client = self._get_http_client()
        response: httpx.Response | None = None
        for attempt in range(attempts):
            try:
                response = await client.request(
                    method,
                    f"{self._base_url}{path}",
                    params=_clean_params(params),
                    json=dict(json_body) if json_body is not None else None,
                    headers=headers,
                )
            except httpx.TransportError as exc:
                logger.warning(
                    "[direct-cast] %s transport error (%s) attempt=%d",
                    path_tag,
                    type(exc).__name__,
                    attempt + 1,
                )
                response = None
            else:
                if response.status_code < 500:
                    break
                logger.warning(
                    "[direct-cast] %s status=%d attempt=%d",
                    path_tag,
                    response.status_code,
                    attempt + 1,
                )
            if attempt + 1 < attempts:
                await asyncio.sleep(self._retry_base_seconds * (2**attempt))

        if response is None:
            raise DirectCastUpstreamError(None, path_tag)
        if response.status_code >= 400:
            logger.warning("[direct-cast] %s status=%d", path_tag, response.status_code)
            if response.status_code == UNAUTHORIZED_STATUS and self._on_token_rejected:
                await self._on_token_rejected(viewer.fid, bearer)
            client_message = (
                sanitize_upstream_message(
                    _upstream_error_message(response), secrets=(bearer,)
                )
                if response.status_code == BAD_REQUEST_STATUS
                else None
            )
            raise DirectCastUpstreamError(
                response.status_code, path_tag, client_message=client_message
            )
        try:
            envelope = response.json()
        except ValueError:
            logger.warning("[direct-cast] %s non-JSON body", path_tag)
            raise DirectCastUpstreamError(None, path_tag) from None
        if not isinstance(envelope, dict):
            raise DirectCastUpstreamError(None, path_tag)
        return envelope

    async def _cache_key(
        self, fid: int, path: str, params: Mapping[str, Any] | None
    ) -> str | None:
        """Versioned key, or ``None`` (bypass the cache) when caching is off
        or the version can't be read -- never risk a stale pre-write hit."""
        if self._cache_ttl_seconds <= 0:
            return None
        try:
            raw_version = await self._redis.get(f"{READ_CACHE_VERSION_PREFIX}{fid}")
        except (RedisError, OSError) as exc:
            logger.warning(
                "[direct-cast] cache version read failed (%s)", type(exc).__name__
            )
            return None
        try:
            version = int(raw_version) if raw_version is not None else 0
        except (TypeError, ValueError):
            return None
        canonical = json.dumps(
            [path, sorted(_clean_params(params).items())], separators=(",", ":")
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]
        return f"{READ_CACHE_PREFIX}{fid}:v{version}:{digest}"

    async def _invalidate_reads(self, fid: int) -> None:
        """Bump ``fid``'s cache version (after every write attempt)."""
        key = f"{READ_CACHE_VERSION_PREFIX}{fid}"
        try:
            await self._redis.incr(key)
            await self._redis.expire(key, READ_CACHE_VERSION_TTL_SECONDS)
        except (RedisError, OSError) as exc:
            # Worst case a read serves the pre-write view for one TTL.
            logger.warning(
                "[direct-cast] cache invalidation failed (%s)", type(exc).__name__
            )

    async def _get(
        self,
        path: str,
        *,
        viewer: MessagingViewer,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Cached GET. Cache failures degrade to a direct upstream call."""
        key = await self._cache_key(viewer.fid, path, params)
        cached = await self._cache_get(key)
        if cached is not None:
            return cached
        envelope = await self._request("GET", path, viewer=viewer, params=params)
        await self._cache_set(key, envelope)
        return envelope

    async def _cache_get(self, key: str | None) -> dict[str, Any] | None:
        if key is None:
            return None
        try:
            raw = await self._redis.get(key)
        except (RedisError, OSError) as exc:
            logger.warning("[direct-cast] cache read failed (%s)", type(exc).__name__)
            return None
        if not isinstance(raw, (str, bytes)):
            return None
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    async def _cache_set(self, key: str | None, envelope: dict[str, Any]) -> None:
        if key is None:
            return
        try:
            await self._redis.set(key, json.dumps(envelope), ex=self._cache_ttl_seconds)
        except (RedisError, OSError) as exc:
            logger.warning("[direct-cast] cache write failed (%s)", type(exc).__name__)

    # -- reads ----------------------------------------------------------------

    async def inbox(
        self,
        viewer: MessagingViewer,
        *,
        category: ConversationCategory,
        filter_: InboxFilter | None,
        cursor: str | None,
        limit: int,
    ) -> InboxResponse:
        envelope = await self._get(
            PATH_INBOX,
            viewer=viewer,
            params={
                "category": category,
                "filter": filter_,
                "cursor": cursor,
                "limit": limit,
            },
        )
        result = _result(envelope, f"GET {PATH_INBOX}")
        return InboxResponse(
            items=_normalize_conversations(result.get("conversations")),
            next_cursor=_next_cursor(envelope),
            requests_count=_int_or(result.get("requestsCount"), 0),
            has_unread_requests=bool(result.get("hasUnreadRequests", False)),
            has_archived=bool(result.get("hasArchived", False)),
        )

    async def conversation(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> Conversation:
        path_tag = f"GET {PATH_CONVERSATION}"
        envelope = await self._get(
            PATH_CONVERSATION,
            viewer=viewer,
            params={"conversationId": conversation_id},
        )
        conversation = normalize_conversation(
            _result(envelope, path_tag).get("conversation")
        )
        if conversation is None:
            raise DirectCastUpstreamError(None, path_tag)
        return conversation

    async def conversation_with(
        self, viewer: MessagingViewer, peer_fid: int
    ) -> Conversation:
        """The viewer's existing 1:1 with ``peer_fid`` or 404.

        Upstream has no lookup-by-recipient [verified]; the official client
        derives the 1:1 id from the sorted fid pair, so we do the same and
        prove it with a conversation fetch (403/404 = it does not exist).
        """
        conversation_id = derive_one_to_one_conversation_id(viewer.fid, peer_fid)
        try:
            conversation = await self.conversation(viewer, conversation_id)
        except DirectCastUpstreamError as exc:
            if exc.upstream_status in CONVERSATION_MISSING_STATUSES:
                raise MessagingError(404, "conversation_not_found") from None
            raise
        if conversation.is_group or not _includes_peer(conversation, peer_fid):
            raise MessagingError(404, "conversation_not_found")
        return conversation

    async def messages(
        self,
        viewer: MessagingViewer,
        conversation_id: str,
        *,
        cursor: str | None,
        anchor_message_id: str | None,
        limit: int,
    ) -> MessagesPage:
        try:
            envelope = await self._get(
                PATH_MESSAGES,
                viewer=viewer,
                params={
                    "conversationId": conversation_id,
                    "messageId": anchor_message_id,
                    "cursor": cursor,
                    "limit": limit,
                },
            )
        except DirectCastUpstreamError as exc:
            if exc.upstream_status == UNKNOWN_CONVERSATION_STATUS:
                return MessagesPage(items=[])
            raise
        result = _result(envelope, f"GET {PATH_MESSAGES}")
        older, newer = split_thread_cursor(_next_cursor(envelope))
        return MessagesPage(
            items=_newest_first(_normalize_messages(result.get("messages"))),
            next_cursor=older,
            next_newer_cursor=newer,
        )

    async def recent_messages(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> Page[Message]:
        try:
            envelope = await self._get(
                PATH_RECENT_MESSAGES,
                viewer=viewer,
                params={"conversationId": conversation_id},
            )
        except DirectCastUpstreamError as exc:
            if exc.upstream_status == UNKNOWN_CONVERSATION_STATUS:
                return Page[Message](items=[])
            raise
        result = _result(envelope, f"GET {PATH_RECENT_MESSAGES}")
        return Page[Message](
            items=_newest_first(_normalize_messages(result.get("messages")))
        )

    async def reactors(
        self,
        viewer: MessagingViewer,
        conversation_id: str,
        message_id: str,
        *,
        cursor: str | None,
        limit: int,
    ) -> Page[ReactorEntry]:
        envelope = await self._get(
            PATH_REACTION,
            viewer=viewer,
            params={
                "conversationId": conversation_id,
                "messageId": message_id,
                "cursor": cursor,
                "limit": limit,
            },
        )
        result = _result(envelope, f"GET {PATH_REACTION}")
        rows = [
            (fid, reaction)
            for item in _dicts(result.get("reactions"))
            if (fid := _positive_fid(item.get("fid")))
            and (reaction := _str_or_none(item.get("reaction")))
        ]
        profiles = await self._user_lookup([fid for fid, _ in rows])
        return Page[ReactorEntry](
            items=[
                ReactorEntry(
                    user=profiles.get(fid)
                    or MessageUser(fid=fid, display_name=_fallback_display_name(fid)),
                    reaction=reaction,
                )
                for fid, reaction in rows
            ],
            next_cursor=_next_cursor(envelope),
        )

    async def search_messages(
        self,
        viewer: MessagingViewer,
        q: str,
        *,
        conversation_id: str | None,
        cursor: str | None,
        limit: int,
    ) -> Page[MessageSearchHit]:
        """Global search; with ``conversation_id``, in-thread search."""
        if conversation_id is None:
            hits, next_cursor = await self._search_page(viewer, q, cursor, limit)
            return Page[MessageSearchHit](items=hits, next_cursor=next_cursor)
        return await self._search_in_conversation(
            viewer, q, conversation_id=conversation_id, cursor=cursor, limit=limit
        )

    async def _search_page(
        self, viewer: MessagingViewer, q: str, cursor: str | None, limit: int
    ) -> tuple[list[MessageSearchHit], str | None]:
        envelope = await self._get(
            PATH_MESSAGE_SEARCH,
            viewer=viewer,
            params={"query": q, "cursor": cursor, "limit": limit},
        )
        result = _result(envelope, f"GET {PATH_MESSAGE_SEARCH}")
        hits = [
            hit
            for item in _dicts(result.get("searchResults"))
            if (hit := normalize_search_hit(item))
        ]
        return hits, _next_cursor(envelope)

    async def _search_in_conversation(
        self,
        viewer: MessagingViewer,
        q: str,
        *,
        conversation_id: str,
        cursor: str | None,
        limit: int,
    ) -> Page[MessageSearchHit]:
        """Upstream has no per-conversation search parameter [verified, docs
        4.2], so this filters global hits, scanning up to
        :data:`MAX_SEARCH_SCAN_PAGES` upstream pages. Returns at most
        ``limit`` hits; when a page has more matches than fit, the
        ``ts1.`` cursor resumes at the first unreturned one (re-fetching
        that upstream page with the same page size). A short or empty page
        with a ``next_cursor`` happens only when the scan budget ran out.
        """
        position = _decode_scoped_search_cursor(cursor, limit)
        upstream_cursor, skip = position.upstream_cursor, position.offset
        hits: list[MessageSearchHit] = []
        for _ in range(MAX_SEARCH_SCAN_PAGES):
            page_hits, next_upstream = await self._search_page(
                viewer, q, upstream_cursor, position.page_limit
            )
            matches = [
                hit
                for hit in page_hits
                if hit.message.conversation_id == conversation_id
            ][skip:]
            room = limit - len(hits)
            if len(matches) > room:
                hits.extend(matches[:room])
                resume = _ScopedSearchCursor(
                    upstream_cursor, skip + room, position.page_limit
                )
                return Page[MessageSearchHit](
                    items=hits, next_cursor=_encode_scoped_search_cursor(resume)
                )
            hits.extend(matches)
            upstream_cursor, skip = next_upstream, 0
            if upstream_cursor is None or len(hits) >= limit:
                break
        return Page[MessageSearchHit](items=hits, next_cursor=upstream_cursor)

    async def search_conversations(
        self,
        viewer: MessagingViewer,
        q: str,
        *,
        category: ConversationCategory,
        cursor: str | None,
        limit: int,
    ) -> Page[Conversation]:
        envelope = await self._get(
            PATH_INBOX_SEARCH,
            viewer=viewer,
            params={"q": q, "category": category, "cursor": cursor, "limit": limit},
        )
        result = _result(envelope, f"GET {PATH_INBOX_SEARCH}")
        return Page[Conversation](
            items=_normalize_conversations(result.get("conversations")),
            next_cursor=_next_cursor(envelope),
        )

    async def search_recipients(
        self, viewer: MessagingViewer, q: str, *, cursor: str | None, limit: int
    ) -> Page[MessageUser]:
        envelope = await self._get(
            PATH_RECIPIENTS,
            viewer=viewer,
            params={
                "q": q,
                "excludeFids": viewer.fid,
                "cursor": cursor,
                "limit": limit,
            },
        )
        result = _result(envelope, f"GET {PATH_RECIPIENTS}")
        users = [
            u for u in _normalize_users(result.get("users")) if u.fid != viewer.fid
        ]
        return Page[MessageUser](items=users, next_cursor=_next_cursor(envelope))

    # -- writes ---------------------------------------------------------------

    async def _raw_metadata(
        self, viewer: MessagingViewer, text: str
    ) -> Mapping[str, Any] | None:
        envelope = await self._request(
            "PUT", PATH_METADATA, viewer=viewer, json_body={"message": text}
        )
        metadata = _result(envelope, f"PUT {PATH_METADATA}").get("metadata")
        return metadata if isinstance(metadata, Mapping) else None

    async def preview_metadata(
        self, viewer: MessagingViewer, text: str
    ) -> MessageMetadata:
        raw = await self._raw_metadata(viewer, text)
        return normalize_metadata(raw) or MessageMetadata()

    async def send(
        self, viewer: MessagingViewer, body: SendMessageRequest, *, sender: MessageUser
    ) -> Message:
        if sender.fid != viewer.fid:
            raise MessagingError(403, "sender_mismatch")
        if any(fid == viewer.fid for fid in body.recipient_fids):
            raise MessagingError(400, "invalid_recipient")
        conversation_id = body.conversation_id or derive_one_to_one_conversation_id(
            viewer.fid, body.recipient_fids[0]
        )
        raw_metadata = (
            await self._metadata_for_send(viewer, body.text)
            if body.process_metadata
            else None
        )
        message_id = str(body.message_id)
        payload: dict[str, Any] = {
            "type": "text",
            "conversationId": conversation_id,
            "recipientFids": list(body.recipient_fids),
            "messageId": message_id,
            "message": body.text,
        }
        if body.in_reply_to_id is not None:
            payload["inReplyToId"] = body.in_reply_to_id
        if raw_metadata is not None:
            payload["clientProcessedMetadata"] = dict(raw_metadata)
        try:
            envelope = await self._request(
                "PUT",
                PATH_SEND,
                viewer=viewer,
                json_body=payload,
                idempotency_key=message_id,
            )
            _expect_success(envelope, f"PUT {PATH_SEND}")
            # Before the version bump: the quote reads the pre-send cache.
            in_reply_to = (
                await self._quote_for_send(viewer, conversation_id, body.in_reply_to_id)
                if body.in_reply_to_id is not None
                else None
            )
        finally:
            # Even on failure: a timed-out/5xx write may still have landed.
            await self._invalidate_reads(viewer.fid)
        return Message(
            message_id=message_id,
            conversation_id=conversation_id,
            sender=sender,
            type="text",
            text=body.text,
            sent_at=_upstream_sent_at(envelope) or _now_ms(),
            in_reply_to=in_reply_to,
            metadata=normalize_metadata(raw_metadata),
        )

    async def _quote_for_send(
        self, viewer: MessagingViewer, conversation_id: str, in_reply_to_id: str
    ) -> MessageQuote:
        """The echo's quote: from the cached recent-messages page if the
        parent is there, else a minimal id-only quote (``sender.fid == 0``,
        empty text) the client should replace with its local copy. Never
        an extra upstream call on the send path."""
        cached = await self._cache_get(
            await self._cache_key(
                viewer.fid,
                PATH_RECENT_MESSAGES,
                {"conversationId": conversation_id},
            )
        )
        result = cached.get("result") if cached is not None else None
        if isinstance(result, Mapping):
            for message in _normalize_messages(result.get("messages")):
                if message.message_id == in_reply_to_id:
                    return MessageQuote(
                        message_id=message.message_id,
                        sender=message.sender,
                        text=message.text,
                        is_deleted=message.is_deleted,
                    )
        return MessageQuote(
            message_id=in_reply_to_id,
            sender=MessageUser(fid=UNKNOWN_QUOTE_SENDER_FID, display_name=""),
            text="",
        )

    async def _metadata_for_send(
        self, viewer: MessagingViewer, text: str
    ) -> Mapping[str, Any] | None:
        """Metadata preprocess is best-effort: a failed preview must not
        block the send, except when the bearer itself was rejected."""
        try:
            return await self._raw_metadata(viewer, text)
        except DirectCastUpstreamError as exc:
            if exc.upstream_status == UNAUTHORIZED_STATUS:
                raise
            logger.info("[direct-cast] metadata preprocess skipped: %s", exc.code)
            return None

    async def react(
        self, viewer: MessagingViewer, body: ReactionRequest, *, remove: bool
    ) -> None:
        method = "DELETE" if remove else "PUT"
        await self._write(
            method,
            PATH_REACTION,
            viewer,
            {
                "conversationId": body.conversation_id,
                "messageId": body.message_id,
                "reaction": body.reaction,
            },
        )

    async def _write(
        self,
        method: str,
        path: str,
        viewer: MessagingViewer,
        json_body: Mapping[str, Any],
    ) -> None:
        """A ``{success}`` write; always bumps the fid's read-cache version."""
        try:
            envelope = await self._request(
                method, path, viewer=viewer, json_body=json_body
            )
            _expect_success(envelope, f"{method} {path}")
        finally:
            await self._invalidate_reads(viewer.fid)

    async def mark_read(self, viewer: MessagingViewer, conversation_id: str) -> None:
        await self._write(
            "POST", PATH_MARK_READ, viewer, {"conversationId": conversation_id}
        )

    async def mark_unread(self, viewer: MessagingViewer, conversation_id: str) -> None:
        await self._write(
            "POST", PATH_MARK_UNREAD, viewer, {"conversationId": conversation_id}
        )

    async def _categorize(
        self, viewer: MessagingViewer, conversation_id: str, category: str
    ) -> None:
        await self._write(
            "POST",
            PATH_CATEGORIZATION,
            viewer,
            {"conversationId": conversation_id, "category": category},
        )

    async def accept_request(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> None:
        await self._categorize(viewer, conversation_id, CATEGORY_ACCEPT)

    async def decline_request(
        self, viewer: MessagingViewer, conversation_id: str
    ) -> None:
        await self._categorize(viewer, conversation_id, CATEGORY_DECLINE)

    async def delete_message(
        self, viewer: MessagingViewer, conversation_id: str, message_id: str
    ) -> None:
        await self._write(
            "DELETE",
            PATH_DELETE_MESSAGE,
            viewer,
            {"conversationId": conversation_id, "messageId": message_id},
        )


def _upstream_sent_at(envelope: Mapping[str, Any]) -> int | None:
    """``serverTimestamp`` if a send envelope ever carries one (today it is
    ``{success}`` only, docs 1.3)."""
    result = envelope.get("result")
    if not isinstance(result, Mapping):
        return None
    for source in (result, _mapping(result.get("message"))):
        timestamp = _int_or_none(source.get("serverTimestamp"))
        if timestamp is not None and timestamp > 0:
            return timestamp
    return None


def _includes_peer(conversation: Conversation, peer_fid: int) -> bool:
    if conversation.counterparty is not None:
        return conversation.counterparty.fid == peer_fid
    return any(user.fid == peer_fid for user in conversation.participants)


def _clean_params(params: Mapping[str, Any] | None) -> dict[str, str]:
    """Drop ``None`` values and stringify the rest (stable cache keys)."""
    if not params:
        return {}
    return {key: str(value) for key, value in params.items() if value is not None}
