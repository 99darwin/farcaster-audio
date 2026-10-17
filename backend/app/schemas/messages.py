"""Client contract for ``/v1/messages/*`` (docs/messaging-design.md, 4.1).

Frozen and mirrored byte-for-byte by ``farcaster-audio/types/messages.ts``
and ``landing/lib/api/messages.types.ts``. Fields are snake_case; nullable
fields serialize as ``null`` (never omitted) so the TS ``T | null`` types
hold. Implementation-agnostic: the Farcaster proxy and the Juke-native
fallback both produce exactly these shapes.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.farcaster_token import TokenStatus

T = TypeVar("T")

MAX_MESSAGE_CHARS = 2000
MAX_REACTION_CHARS = 16
MAX_ID_CHARS = 128
# Opaque upstream ids: 1:1 is "<lowerFid>-<higherFid>", groups are hex/uuid.
# Constrained so ids can never smuggle query syntax or path segments.
ID_PATTERN = r"^[A-Za-z0-9_\-]+$"
UpstreamId = Annotated[
    str, Field(min_length=1, max_length=MAX_ID_CHARS, pattern=ID_PATTERN)
]


class MessageUser(BaseModel):
    fid: int
    username: str | None = None
    display_name: str
    pfp_url: str | None = None


class MessageMedia(BaseModel):
    url: str
    width: int
    height: int
    mime_type: str | None = None


class MessageUrlEmbed(BaseModel):
    url: str
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    domain: str | None = None


class MessageMetadata(BaseModel):
    medias: list[MessageMedia] = Field(default_factory=list)
    urls: list[MessageUrlEmbed] = Field(default_factory=list)
    mentions: list[MessageUser] = Field(default_factory=list)
    cast_hashes: list[str] = Field(default_factory=list)


class MessageReactionSummary(BaseModel):
    reaction: str
    count: int
    viewer_reacted: bool


MessageType = Literal[
    "text",
    "group_name_change",
    "group_membership_addition",
    "group_membership_removal",
    "pin_message",
    "message_ttl_change",
    "rich_announcement",
]


class MessageQuote(BaseModel):
    """One-level quoted parent of a reply."""

    message_id: str
    sender: MessageUser
    text: str
    is_deleted: bool = False


class Message(BaseModel):
    message_id: str
    conversation_id: str
    sender: MessageUser
    type: MessageType
    text: str
    sent_at: int  # ms epoch (upstream serverTimestamp)
    reactions: list[MessageReactionSummary] = Field(default_factory=list)
    in_reply_to: MessageQuote | None = None
    metadata: MessageMetadata | None = None
    is_deleted: bool = False
    is_pinned: bool = False
    is_last_read: bool = False  # viewerContext.isLastReadMessage


ConversationCategory = Literal["default", "archived", "request", "void"]
ConversationAccess = Literal["read", "read-write"]
InboxFilter = Literal["unread", "group", "1-1"]
# "ready": a usable upstream credential exists (not yet proven upstream).
SignerStatus = Literal["ready", "not_linked", "invalid_bearer", "unavailable"]


class Conversation(BaseModel):
    conversation_id: str
    is_group: bool
    name: str | None = None
    photo_url: str | None = None
    participants: list[MessageUser]
    counterparty: MessageUser | None = None  # 1:1 only
    last_message: Message | None = None
    unread_count: int
    unread_mentions_count: int
    muted: bool
    pinned: bool
    archived: bool
    category: ConversationCategory
    access: ConversationAccess
    last_read_at: int  # ms epoch, viewer
    manually_marked_unread: bool
    created_at: int
    # ms epoch the other party last read up to (upstream ``lastReadTime``).
    # A viewer-sent message is read by the peer iff
    # ``peer_last_read_at >= message.sent_at``. ``0`` = never read; ``None``
    # for groups (no per-member read state upstream) or when upstream omits it.
    peer_last_read_at: int | None = None


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


class MessagesPage(Page[Message]):
    """A thread page. ``items`` are newest-first (descending ``sent_at``).

    ``next_cursor`` continues toward OLDER messages, ``next_newer_cursor``
    toward NEWER ones (only meaningful after an anchored/jumped fetch); both
    are passed back as ``?cursor=``. ``None`` means nothing further that way.
    """

    next_newer_cursor: str | None = None


class InboxResponse(Page[Conversation]):
    requests_count: int
    has_unread_requests: bool
    has_archived: bool


class SendMessageRequest(BaseModel):
    # None => new 1:1; recipient_fids must then hold exactly the peer.
    conversation_id: UpstreamId | None = None
    recipient_fids: list[int] = Field(default_factory=list, max_length=1)
    message_id: UUID  # client-generated; doubles as the idempotency key
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    in_reply_to_id: UpstreamId | None = None
    process_metadata: bool = True  # run metadata preprocess before send

    @field_validator("recipient_fids")
    @classmethod
    def _positive_fids(cls, fids: list[int]) -> list[int]:
        if any(fid <= 0 for fid in fids):
            raise ValueError("recipient fids must be positive")
        return fids

    @field_validator("text")
    @classmethod
    def _not_blank(cls, text: str) -> str:
        if not text.strip():
            raise ValueError("text must not be blank")
        return text

    @model_validator(mode="after")
    def _new_conversation_needs_recipient(self) -> SendMessageRequest:
        if self.conversation_id is None and len(self.recipient_fids) != 1:
            raise ValueError("a new conversation needs exactly one recipient fid")
        return self


class SendMessageResponse(BaseModel):
    message: Message  # echo of what was sent (normalized)


class ReactionRequest(BaseModel):
    conversation_id: UpstreamId
    message_id: UpstreamId
    reaction: str = Field(min_length=1, max_length=MAX_REACTION_CHARS)

    @field_validator("reaction")
    @classmethod
    def _no_whitespace(cls, reaction: str) -> str:
        if not reaction.strip() or reaction != reaction.strip():
            raise ValueError("reaction must be a single emoji")
        return reaction


class ReactorEntry(BaseModel):
    user: MessageUser
    reaction: str


class HighlightRange(BaseModel):
    """Half-open ``[start, end)`` range in UTF-16 code units of ``text``."""

    start: int = Field(ge=0)
    end: int = Field(ge=0)


class MessageSearchHit(BaseModel):
    message: Message
    conversation: Conversation
    # Raw upstream snippets: plain text with matched terms wrapped in
    # ``<fc_highlight>…</fc_highlight>``. Prefer ``highlight_ranges``.
    highlights: list[str]
    before: list[Message]  # older context, newest-first
    after: list[Message]  # newer context, newest-first
    # Sorted, non-overlapping ranges into ``message.text`` (UTF-16 units).
    highlight_ranges: list[HighlightRange] = Field(default_factory=list)
    # Distinct matched terms as they appear in the snippets, first-seen order.
    matched_terms: list[str] = Field(default_factory=list)
    # Seed a jumped-to thread with [...after, message, ...before], then page
    # with these as ``?cursor=`` on GET /conversations/{id}/messages.
    thread_cursor: str | None = None  # older than ``before``
    thread_newer_cursor: str | None = None  # newer than ``after``


class MetadataPreviewRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)


class MessagingStatus(BaseModel):
    """``GET /v1/messages/status`` — capability probe, never 404s."""

    enabled: bool
    # ``None`` when ``enabled`` is false (nothing is checked).
    signer_status: SignerStatus | None = None
    # Custody-minted upstream DC token (``farcaster_token_service``);
    # ``None`` when ``enabled`` is false. Not ``active`` -> "Enable messages".
    token_status: TokenStatus | None = None
    expires_at: datetime | None = None


MessagesEventType = Literal["message", "read", "inbox", "ping"]
ReadBy = Literal["viewer", "peer"]


class MessagesEvent(BaseModel):
    """Websocket frame, server -> client. Serialized with ``exclude_none``."""

    type: MessagesEventType
    conversation_id: str | None = None
    message: Message | None = None
    read_by: ReadBy | None = None  # "read" frames only


class MessagesEventsTicket(BaseModel):
    """``POST /v1/messages/events/ticket`` — single-use WS credential.

    Pass as ``/v1/messages/events?ticket=<ticket>`` within ``expires_in``
    seconds; it is consumed on first use and bound to the JWT's fid.
    """

    ticket: str
    expires_in: int
