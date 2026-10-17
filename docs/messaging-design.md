# Juke Messaging: Farcaster Direct Casts

Status: design, pre-implementation. Date: 2026-10-16.

Scope: a first-class Direct Casts (DC) inbox in the mobile app (`farcaster-audio/`)
and the web client (`landing/`), served through the FastAPI backend (`backend/`).

Every statement below is tagged **[verified]** (read from a primary source, URL
given) or **[inferred]** (deduced; must be confirmed before shipping code that
depends on it). The one blocker that gates the whole feature is called out in
section 2 and must be resolved first.

---

## 0. Decision in one paragraph

Build a **backend proxy** (`/v1/messages/*` plus `WS /v1/messages/events`) in
front of the plaintext V3 Direct Cast API on `https://client.farcaster.xyz`.
Mobile and web both talk only to Juke. B1 showed the DC endpoints reject
`app_key` JFS, so the upstream bearer is the custody-minted 90-day token from
`PUT /v2/onboarding-state`: the client signs one EIP-191 `generateToken`
request with the custody key derived from the recovery phrase (at link time,
or later via "Enable messages"), and the backend stores only the resulting
token, encrypted (section 2). No custody key or phrase is ever held for users;
the phrase hygiene contract in `farcaster-audio/services/signerLink.ts` is not
weakened (one extra signature, phrase still discarded).

---

## 1. Upstream API facts

### 1.1 Sources

| Tag | Source |
|-----|--------|
| S1 | https://github.com/farcasterxyz/client (MIT), `packages/farcaster-client-data/src/client/FarcasterApiClient.ts` |
| S2 | same repo, `packages/farcaster-client-data/src/types/api.ts` |
| S3 | same repo, `packages/farcaster-client-data/src/utils/AuthUtils.ts` |
| S4 | same repo, `packages/farcaster-client-hooks/src/providers/WebSocketsProvider.tsx` and `hooks/data/mutations/useSendDirectCast.ts` |
| S5 | https://github.com/QuilibriumNetwork/quorum-mobile `services/farcasterClient.ts` (independent third-party client) |
| S6 | https://docs.neynar.com/docs/neynar-webhooks-warpcast-dcs (developer DC API) |
| J1 | this repo, `backend/app/routers/rooms.py` (`native_join_room`) and `backend/app/services/farcaster_spaces_service.py` |
| J2 | this repo, `backend/app/services/jfs.py`, `farcaster-audio/services/snapSigner.ts` |

### 1.2 Transport conventions [verified: S1, J1]

* Base URL `https://client.farcaster.xyz`. All responses are enveloped as
  `{ result: ... , next?: { cursor: string } }`; errors as `{ errors: [{ message }] }`.
* Headers the official client sends: `authorization: Bearer <token>`,
  `content-type: application/json`, `accept: application/json`. Juke's
  existing proxy additionally sends `origin: https://farcaster.xyz` and
  `referer: https://farcaster.xyz/` (J1, L318) and that works in prod for
  audio rooms. Cloudflare blocks non-browser user agents on at least some
  paths (observed: python-urllib got a 403 HTML page), so the proxy must send a
  browser-like `user-agent`.
* Write calls that must be idempotent carry an `idempotency-key` header (S1,
  `putDirectCastV3`).
* GET params are query-string; PUT/POST/DELETE bodies are JSON (DELETE with a
  JSON body, S1 `deleteDirectCastMessage`, `deleteDirectCastMessageReaction`).

### 1.3 Endpoint catalogue [verified: S1, S2 unless noted]

| Purpose | Method + path | Request | Response `result` |
|---|---|---|---|
| Inbox list | `GET /v2/direct-cast-inbox` | `category?: 'default'\|'archived'\|'request'\|'void'`, `filter?: 'unread'\|'group'\|'1-1'`, `cursor?`, `limit` | `{ hasArchived, hasUnreadRequests, requestsCount, voidCount, conversations: ApiDirectCastInboxConversationInfoV3[] }` + `next.cursor` |
| Conversation list (older) | `GET /v2/direct-cast-conversation-list` | same | `{ hasArchived, requestsCount, voidCount, conversations: ApiDirectCastConversationInfoV3[] }` |
| One conversation | `GET /v2/direct-cast-conversation` | `conversationId` | `{ conversation }` |
| Messages page | `GET /v2/direct-cast-conversation-messages` | `conversationId`, `messageId?` (anchor for jump-to), `cursor?`, `limit` (official default 15) | `{ messages: ApiDirectCastMessageV3[] }` + `next.cursor`. Returns 403 when the conversation does not exist yet (official client treats this as "empty new conversation") |
| Recent messages | `GET /v2/direct-cast-conversation-recent-messages` | `conversationId` | `{ messages }` |
| Send | `PUT /v2/direct-cast-send` (+ `idempotency-key` header) | `{ type: 'text', conversationId, recipientFids: number[], messageId: uuid, message, inReplyToId?, clientProcessedMetadata? }` | `{ success: boolean }` |
| Link/embed metadata | `PUT /v2/direct-cast-message-metadata` | `{ message }` | `{ metadata?: ApiDirectCastMessageMetadata }` (official client calls this before send and passes the result as `clientProcessedMetadata`) |
| React / unreact | `PUT` / `DELETE /v2/direct-cast-message-reaction` | `{ conversationId, messageId, reaction }` | `{ success }` |
| Who reacted | `GET /v2/direct-cast-message-reaction` | `conversationId`, `messageId`, `cursor?`, `limit` | `{ conversationId, messageId, reactions: [{ fid, reaction }] }` + `next.cursor` |
| Mark read | `POST /v2/direct-cast-mark-read` | `{ conversationId }` | `{ success }` |
| Mark unread | `POST /v2/direct-cast-manually-mark-unread` | `{ conversationId }` | `{ success }` |
| Delete message | `DELETE /v2/delete-message` | `{ conversationId, messageId }` | `{ success }` |
| Global message search | `GET /v2/direct-cast-message-search` | `query`, `cursor?`, `limit` | `{ searchResults: [{ result: ApiDirectCastMessageV3, conversation, highlights: string[], messagesBefore[], messagesAfter[], surroundingMessagesCursor }] }` + `next.cursor` |
| Conversation search | `GET /v2/search-direct-cast-inbox` | `q`, `category`, `cursor?`, `limit` | `{ conversations }` |
| Recipient search | `GET /v2/direct-cast-users` | `q`, `excludeFids?`, `cursor?`, `limit` | `{ users: ApiUser[] }` |
| Create group | `PUT /v2/direct-cast-group` | `{ participantFids, name, description? }` | `{ conversationId }` |
| Group admin | `/v2/direct-cast-group-invite(s)`, `-accept-group-invite`, `-decline-group-invite`, `-group-membership`, `-group-photo`, `-group-preferences` | see S1 | out of scope for v1 |
| Pin / categorize / mute | `/v2/direct-cast-pin-message`, `-pin-conversation`, `-conversation-categorization`, `-conversation-notifications`, `-conversation-message-ttl` | see S1 | v2 |
| Image upload | `POST /v1/generate-image-upload-url` | `{}` | `{ url, id }` [verified: S5 only] |
| Developer send-only | `PUT /v2/ext-send-direct-cast` on `api.warpcast.com` | `{ recipientFid\|groupId, message, idempotencyKey }` with a user-provisioned API key | send-only, no inbox [verified: S6]. Not usable for a client. |

Upstream rate limits: **not documented anywhere I could find [inferred: unknown]**.
Design assumes they exist and keeps the proxy's own limits conservative.

### 1.4 Types [verified: S2, lines ~3025-3320 and ~10012-10720]

```ts
type ApiDirectCastMessageV3 = {
  conversationId: string;
  senderFid: number;
  messageId: string;                     // client-generated uuid on send
  serverTimestamp: number;               // ms epoch
  type: 'text' | 'group_name_change' | 'group_membership_addition'
      | 'group_membership_removal' | 'pin_message' | 'message_ttl_change'
      | 'rich_announcement';
  message: string;
  hasMention: boolean;
  reactions: { reaction: string; count: number }[];
  inReplyTo?: ApiDirectCastMessageV3;    // quoted parent, one level
  metadata?: { medias?: ApiMediaV2[]; mentions?: ApiUser[]; channelMentions?;
               casts?; urls?: ApiCastUrlEmbed[]; groupInvites?; videos?;
               urlEmbedDisplayMode? };
  viewerContext?: { isLastReadMessage: boolean; focused: boolean;
                    reactions: string[]; isOptimistic?: boolean };
  isPinned: boolean;
  isDeleted: boolean;
  senderContext: { fid: number; username?: string; displayName: string; pfp?: { url } };
  actionTargetUserContext?: ...;  payload?: ...;  isProgrammatic?: boolean;
};

type ApiDirectCastConversationInfoV3 = {
  conversationId: string; name?: string; photoUrl?: string;
  adminFids: number[]; removedFids: number[]; participants: ApiUser[];
  lastReadTime: number; selfLastReadTime: number;
  lastMessage?: ApiDirectCastMessageV3; pinnedMessages: ApiDirectCastMessageV3[];
  isGroup: boolean; groupPreferences?; messageTTLDays: number; createdAt: number;
  unreadCount: number; muted: boolean; hasMention: boolean;
  viewerContext: { access: 'read'|'read-write'; category: 'default'|'archived'|'request'|'void';
                   archived: boolean; lastReadAt: number; muted: boolean;
                   manuallyMarkedUnread: boolean; pinned: boolean; unreadCount: number;
                   unreadMentionsCount: number; unreadReactionMessage?; counterParty?: ApiUser;
                   tag?; inviter? };
};
```

`ApiMediaV2 = { version: '2'; width; height; staticRaster: string; mimeType? }`,
`ApiCastUrlEmbed = { type: 'url'; openGraph: ApiOpenGraphMetadata; ... }`.

1:1 `conversationId` is `"<lowerFid>-<higherFid>"` **[inferred]** from the
official client's optimistic-conversation code; the proxy must treat it as
opaque anyway. For a brand-new 1:1 the official client sends with
`conversationId` computed client-side plus `recipientFids: [peerFid]`; the
server creates the conversation.

### 1.5 Real-time [verified: S2 L7550-7600, S4]

* `wss://ws.farcaster.xyz/stream`. After open the client sends
  `{ messageType: 'authenticate', data: 'Bearer <token>' }`; a second channel
  type `dc_authenticate` exists for the DC-specific socket.
* Server messages relevant to DCs:
  * `refresh-direct-cast-conversation` `{ payload: { conversationId, message: ApiDirectCastMessageV3 } }`
  * `direct-cast-read` `{ payload: { conversationId } }`
  * `refresh-self-direct-casts-inbox` `{ payload: { conversationId } }`
  * `unseen` `{ payload: { unseenCount ... } }`
* **There is no typing-indicator message type.** Typing state cannot be
  implemented against upstream; see section 6.
* Whether the socket accepts an `app_key` JFS bearer is **[inferred: unknown]**,
  same blocker as section 2.

### 1.6 Encryption

Production DCs are **plaintext server-side** [verified: S1/S2 naming
`PlaintextDirectCasts*`, `putDirectCastV3` with `message: string`]. A
separate E2EE inbox (`direct-cast-keys`, `direct-cast-device-keys`,
`ApiInboxDirectCast` ciphertext, double-ratchet in `farcaster-cryptography`)
exists in the codebase but is not the product send path. v1 ignores it.

---

## 2. Auth: what we hold vs. what upstream accepts

| Credential | Who holds it | Accepted by DC endpoints? |
|---|---|---|
| Custody EIP-191 `generateToken` token (`PUT /v2/onboarding-state`, 90-day) | **Backend, per user** (`user_farcaster_tokens`, AES-GCM at rest, migration 035). Minted from one custody signature the client makes at phrase entry; the phrase is never retained or sent. | **Yes** [verified: S3 and B1] |
| On-device Ed25519 app key (Neynar-registered), `app_key` JFS | Mobile only, SecureStore `snap_signer_key_<fid>` (`snapSigner.ts`) | **No** [verified: B1, upstream 401]. Still used for audio rooms. |
| Juke-managed Ed25519 app signer (KeyGateway `addFor`), `user_signers` row | Backend (`user_signer_service.py`) | **No** [verified: B1, same JFS mechanism]. Still used for casts/reactions. |
| Browser secp256k1 auth address (keyType 2) | Landing IndexedDB (`authAddressStore.ts`) | No. |
| Developer API key (`ext-send-direct-cast`) | Each user in Warpcast | Send-only; not viable. |

**B1 result: resolved, custody-only.** Upstream rejects every `app_key` JFS
bearer on `/v2/direct-cast-*`; only the token returned by
`PUT /v2/onboarding-state` for a custody-signed `generateToken` request works
(the same flow the official client uses). Section 8 is not needed: we keep the
proxy design but swap the credential.

How the token is obtained (the phrase never leaves the device):

1. The client builds `{"method":"generateToken","params":{"expiresAt":E,"timestamp":T}}`
   (ms epoch, `E - T` = 90 days), canonical JSON (sorted keys, no whitespace),
   and signs it with the custody account (EIP-191 `personal_sign`).
2. It sends `dc_auth_request` + `dc_auth_signature` (`eip191:` + padded base64
   of the 65 bytes):
   * **New link:** on `POST /v1/auth/signer/register` alongside the signer
     signatures (`signerLink.ts` / web `protocolLogin.ts`). After the relay is
     scheduled the backend enables messaging in the background.
   * **Existing users:** `POST /v1/messages/enable` from the "Enable messages"
     flow, which reuses the recovery-phrase step but signs only this request.
3. The backend validates shape, skew (60 s) and lifetime (<= 90 d), recovers
   the signer, checks it equals the FID's on-chain custody address
   (`key_gateway.custody_of`), exchanges it upstream, and stores only the
   resulting token (AES-GCM, purpose `FARCASTER_TOKEN`, AAD `fid:<fid>`) with
   its expiry. The signature is discarded and never logged. A body that
   parses as JSON but fails the schema answers an opaque
   `400 invalid_auth_request`; a missing or non-JSON body answers the
   redacted 422 (section 4, error mapping). Neither echoes the signature.
4. Logout (`POST /v1/auth/logout`) deletes the stored token for the fid of
   the refresh token in the body and, when the request carries a valid
   first-party access JWT (`Authorization: Bearer`), for that JWT's fid too.
   An expired, invalid or partner bearer is ignored; logout never fails on
   it. Refresh-token consumption is a single `GETDEL`.

---

## 3. Architecture

### 3.1 Why a backend proxy (not client-direct)

1. **Web cannot call upstream at all.** `landing/` holds no Ed25519 key, and a
   browser on `juke.audio` would be blocked by CORS anyway (official client
   origin is `farcaster.xyz`).
2. **Redaction.** Bearers and signed payloads never reach logs; the proxy
   already enforces this convention (`farcaster_spaces_service.py`).
3. **Rate limiting and caching** in one place, with one upstream `httpx`
   client and connection pool.
4. **Key locality.** The custody key never leaves the phone (and is not
   kept there); the DC token never leaves the backend.
5. **Swappable upstream.** The client contract (section 4) is the same whether
   messages come from Farcaster or from Juke's own store (section 8).

Cost: one extra hop (~50-100 ms) and the backend becomes a real-time relay.
Acceptable.

### 3.2 Bearer resolution (per request)

```
authorize(db, fid):                       # direct_cast_service.py
  token = farcaster_token_service.get_direct_cast_bearer(db, fid)
    decrypt failure / key config -> 503 messaging_token_unavailable
  if token: return MessagingViewer(fid, bearer=token)
  status = get_token_status(db, fid)
  expired -> 403 messaging_token_expired
  else    -> 403 messaging_token_missing
upstream 401 on any call       -> 403 messaging_token_rejected
                                  + delete the stored token iff it is still
                                    the one upstream rejected
```

The fid is always the JWT's; clients send no Farcaster credential, and an
`X-Farcaster-Bearer` header is ignored. HTTP routes, the `events` websocket
(close `4403`, reason = the code above) and the phase-A inbox poller all use
the same `authorize`. Partner tokens are refused by
`require_first_party_user`. A token upstream answers 401 to is deleted
(best-effort compare-and-delete: `farcaster_token_service.revoke_rejected_token`
only removes the row if its secret still equals the rejected bearer, so a
request racing a fresh `/enable` cannot delete the new token). `/status` then
reports `token_status: "missing"` (needs enable) instead of a stale
`active`; clients treat `messaging_token_rejected` as "enable again".

### 3.3 Existing-user access

Clients read `GET /v1/messages/status` and gate on `token_status`:

* `active`: render messaging.
* `missing` / `expired` (or any `messaging_token_*` 403 / WS 4403): render
  the "Enable messages" CTA. It opens the recovery-phrase step
  (`RecoveryPhraseStep purpose="messages"` on mobile, `RecoveryPhraseEntry` on
  web), signs only the `generateToken` request with
  `signMessagingToken({ phrase, fid, custodyAddress })`, posts it to
  `POST /v1/messages/enable`, and on success uses the returned
  `{ token_status, expires_at }`.
* `signer_status: "unavailable"`: server cannot read the token; show retry.

Users who link (or relink) with the phrase after this ships get the token
automatically at register time and never see the CTA. The token lasts 90
days; the CTA reappears with "expired" copy afterwards.

### 3.4 Real-time

Phase A (ships with v1): **polling**. Inbox: every 15 s while the Messages
surface is focused. Open conversation: `recent-messages` every 4 s while
focused, backed by `direct-cast-conversation-messages` for history. Backend
caches each upstream read for 3 s per `(fid, path, params)` in Redis so
multiple tabs/devices do not multiply upstream calls. The cache key embeds a
per-fid version (`messages:cache_ver:<fid>`, 24 h TTL) that every write
(send, delete, react/unreact, mark read/unread, categorize, accept/decline
request) `INCR`s, whether or not upstream accepted it, so a read right after a write always misses the cache. If the version
cannot be read the request skips the cache.

Phase B: **upstream websocket relay**. When a client holds
`WS /v1/messages/events`, the backend opens one `wss://ws.farcaster.xyz/stream`
per FID (ref-counted across that FID's Juke sockets), authenticates with a
the stored DC token, and republishes `refresh-direct-cast-conversation`,
`direct-cast-read`, `refresh-self-direct-casts-inbox` over Redis pub/sub to
the Juke sockets exactly as `rooms.py /events` does. The relay dedupes by `messageId` and
reconnects on close.

### 3.5 Push notifications

Upstream sends its own DC pushes only to Warpcast. Juke cannot subscribe to a
per-user DC webhook. v1: no DC push from Juke; badge counts come from the
inbox poll / relay. Revisit if Phase B is live (the relay can emit an Expo
push from `refresh-direct-cast-conversation` for backgrounded users, using
`push_service.py`).

---

## 4. Backend contract

Files: `backend/app/routers/messages.py`, `backend/app/services/direct_cast_service.py`
(upstream client, bearer resolution, normalization), `backend/app/schemas/messages.py`,
`backend/app/services/direct_cast_relay.py` (Phase B), tests in
`backend/tests/test_messages_router.py`, `test_direct_cast_service.py` with an
upstream fake modelled on `tests/hypersnap_fake.py`. Register in `main.py`
next to the other `include_router` calls. Feature flag `MESSAGING_ENABLED`
in `config.py` (default false). When off, every route except `GET /status`
answers `404 { "detail": "messaging_disabled" }` and `WS /events` closes
4404; `GET /status` always answers 200 (see 4.6) so clients can tell
"feature off" from a genuine `404 not_found` / `conversation_not_found`.

All routes: `Depends(require_first_party_user)` (any `X-Farcaster-Bearer`
header is ignored), per-FID fixed-window rate limits per minute: `read` 120
(inbox/thread/recent/status/reactors), `send` 20 (send, accept, decline,
delete), `reactions` 60, `search` 30 (search, search/conversations,
recipients), `mark_read` 30 (read + unread), `preview` 30 (metadata
preview), `events` 30 (WS connects), `events_ticket` 30. Over budget:
`429 { detail: "rate_limited" }` + `Retry-After`.

Upstream error mapping (only status + path tag are logged; bodies, headers
and bearers never reach a log line or a response):

| Upstream | Client |
|---|---|
| 400 | `422 { detail: "upstream_rejected", message? }` — upstream refused the request itself (content/state), not an outage. `message` is upstream's `errors[0].message` / `message`, control characters stripped, the bearer and any token-like run (`Bearer …`, 32+ char base64/hex/JWT) replaced by `[redacted]`, capped at 200 chars; absent when upstream gave none |
| 401 | `403 messaging_token_rejected` (+ stored token revoked, 3.2) |
| 403 | `403 upstream_forbidden` |
| 404 | `404 not_found` |
| 429 | `429 upstream_rate_limited` |
| other / transport / bad envelope | `502 upstream_error` |

Request validation errors (422) on `/v1/messages/*` and `/v1/auth/*` keep
FastAPI's shape but carry only `type`, `loc` and `msg` per entry: `input`
and `ctx` are dropped (`app/routing.py` `RedactedValidationRoute`) so a 422
never echoes signatures (`dc_auth_signature`, `signer_add_signature`,
`auth_address_add_signature`), `protocol_auth_token` or message text.
`POST /v1/messages/enable` additionally answers a JSON body that fails the
schema with an opaque `400 invalid_auth_request`; a missing or non-JSON body
still gets the redacted 422.

The proxy normalizes upstream camelCase into Juke snake_case and drops
fields the clients do not render.

### 4.1 Schemas (`backend/app/schemas/messages.py`)

```python
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
    medias: list[MessageMedia] = []
    urls: list[MessageUrlEmbed] = []
    mentions: list[MessageUser] = []
    cast_hashes: list[str] = []

class MessageReactionSummary(BaseModel):
    reaction: str
    count: int
    viewer_reacted: bool

MessageType = Literal["text", "group_name_change", "group_membership_addition",
                      "group_membership_removal", "pin_message",
                      "message_ttl_change", "rich_announcement"]

class Message(BaseModel):
    message_id: str
    conversation_id: str
    sender: MessageUser
    type: MessageType
    text: str
    sent_at: int                      # ms epoch (upstream serverTimestamp)
    reactions: list[MessageReactionSummary] = []
    in_reply_to: "MessageQuote | None" = None
    metadata: MessageMetadata | None = None
    is_deleted: bool = False
    is_pinned: bool = False
    is_last_read: bool = False        # viewerContext.isLastReadMessage

class MessageQuote(BaseModel):        # one-level quoted parent
    message_id: str
    sender: MessageUser
    text: str
    is_deleted: bool = False

ConversationCategory = Literal["default", "archived", "request", "void"]

class Conversation(BaseModel):
    conversation_id: str
    is_group: bool
    name: str | None = None
    photo_url: str | None = None
    participants: list[MessageUser]
    counterparty: MessageUser | None = None   # 1:1 only
    last_message: Message | None = None
    unread_count: int
    unread_mentions_count: int
    muted: bool
    pinned: bool
    archived: bool
    category: ConversationCategory
    access: Literal["read", "read-write"]
    last_read_at: int                 # ms epoch, viewer
    manually_marked_unread: bool
    created_at: int
    peer_last_read_at: int | None = None  # ms epoch, other party (1:1 only); see 4.7

class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None

class MessagesPage(Page[Message]):    # thread pages; see 4.4
    next_newer_cursor: str | None = None

class InboxResponse(Page[Conversation]):
    requests_count: int
    has_unread_requests: bool
    has_archived: bool

class SendMessageRequest(BaseModel):
    conversation_id: str | None = None        # None => new 1:1, recipient_fids required
    recipient_fids: list[int] = Field(default_factory=list, max_length=1)
    message_id: UUID                          # client-generated, idempotency key
    text: str = Field(min_length=1, max_length=2000)
    in_reply_to_id: str | None = None
    process_metadata: bool = True             # run metadata preprocess before send

class SendMessageResponse(BaseModel):
    message: Message                          # echo of what was sent (normalized)

class ReactionRequest(BaseModel):
    conversation_id: str
    message_id: str
    reaction: str = Field(min_length=1, max_length=16)   # single emoji grapheme

class ReactorEntry(BaseModel):
    user: MessageUser
    reaction: str

class HighlightRange(BaseModel):       # [start, end) in UTF-16 code units of message.text
    start: int
    end: int

class MessageSearchHit(BaseModel):    # see 4.5
    message: Message
    conversation: Conversation
    highlights: list[str]             # raw snippets, terms wrapped in <fc_highlight>…</fc_highlight>
    before: list[Message]             # older context, newest-first
    after: list[Message]              # newer context, newest-first
    highlight_ranges: list[HighlightRange] = []
    matched_terms: list[str] = []
    thread_cursor: str | None = None        # older than `before`
    thread_newer_cursor: str | None = None  # newer than `after`

class MetadataPreviewRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)

SignerStatus = Literal["ready", "not_linked", "invalid_bearer", "unavailable"]

class MessagingStatus(BaseModel):             # GET /status; see 4.6
    enabled: bool
    signer_status: SignerStatus | None = None # null when enabled is false
    token_status: Literal["active", "missing", "expired"] | None = None
    expires_at: datetime | None = None

class MessagesEvent(BaseModel):               # websocket frames, server -> client
    type: Literal["message", "read", "inbox", "ping"]
    conversation_id: str | None = None
    message: Message | None = None
    read_by: Literal["viewer", "peer"] | None = None   # "read" frames only
```

### 4.2 Routes (`backend/app/routers/messages.py`, prefix `/v1/messages`)

| Route | Upstream | Notes |
|---|---|---|
| `GET /status` → `MessagingStatus` | none | **ungated** (200 even when the flag is off); JWT required; `read` rate bucket; resolves the credential without calling upstream (4.6) |
| `GET /inbox?category=default&filter=&cursor=&limit=25` → `InboxResponse` | `GET /v2/direct-cast-inbox` | cached 3 s per fid/params |
| `GET /conversations/with/{fid}` → `Conversation` | `GET /v2/direct-cast-conversation` with the derived `"<min>-<max>"` id | existing 1:1 with `fid` or `404 conversation_not_found` (upstream 403/404, a group, or a counterparty mismatch); self → `400 invalid_recipient`; `fid < 1` → 422. Upstream has no lookup-by-recipient [verified]; the official web client derives the id the same way (`buildNonGroupConversationId`) |
| `GET /conversations/{conversation_id}` → `Conversation` | `GET /v2/direct-cast-conversation` | |
| `GET /conversations/{conversation_id}/messages?cursor=&anchor_message_id=&limit=30` → `MessagesPage` | `GET /v2/direct-cast-conversation-messages` (`messageId=anchor`) | newest-first; `cursor` takes `next_cursor` (older) or `next_newer_cursor` (newer), see 4.4; upstream 403 on unknown conversation → `200 { items: [], next_cursor: null, next_newer_cursor: null }` |
| `GET /conversations/{conversation_id}/recent` → `Page[Message]` | `.../recent-messages` | polling target, cached 3 s; newest-first; `next_cursor` always null |
| `POST /conversations/{conversation_id}/accept` → `204` | `POST /v2/direct-cast-conversation-categorization` `{conversationId, category: "default"}` | accept a message request (4.8); `send` rate bucket |
| `POST /conversations/{conversation_id}/decline` → `204` | same, `category: "deleted"` | decline a request: removed from the viewer's side only, the sender is not told (4.8) |
| `PUT /send` → `SendMessageResponse` | `PUT /v2/direct-cast-message-metadata` then `PUT /v2/direct-cast-send` with `idempotency-key: <message_id>` | if `conversation_id` is None the service derives `"<min>-<max>"` from `(fid, recipient_fids[0])` [inferred id format; verify in B1]. Echo: `sent_at` is upstream's `serverTimestamp` when the send envelope has one (today it is `{success}` only), else the proxy clock; `in_reply_to` is filled when `in_reply_to_id` was sent — from the cached `recent` page if the parent is there, else a minimal quote `{ message_id, sender: { fid: 0, display_name: "" }, text: "", is_deleted: false }` (clients keep their local quote when `sender.fid === 0`). No extra upstream call |
| `POST /conversations/{conversation_id}/read` → `204` | `POST /v2/direct-cast-mark-read` | `mark_read` rate bucket |
| `POST /conversations/{conversation_id}/unread` → `204` | `POST /v2/direct-cast-manually-mark-unread` | `mark_read` rate bucket |
| `DELETE /conversations/{conversation_id}/messages/{message_id}` → `204` | `DELETE /v2/delete-message` | |
| `PUT /reactions` body `ReactionRequest` → `204` | `PUT /v2/direct-cast-message-reaction` | |
| `DELETE /reactions` body `ReactionRequest` → `204` | `DELETE /v2/direct-cast-message-reaction` | |
| `GET /reactions?conversation_id=&message_id=&cursor=&limit=50` → `Page[ReactorEntry]` | `GET /v2/direct-cast-message-reaction` + hydrate fids via existing user cache (`users.py` path) | who-reacted sheet |
| `GET /search?q=&conversation_id=&cursor=&limit=20` → `Page[MessageSearchHit]` | `GET /v2/direct-cast-message-search` | global search; with `conversation_id`, the **official in-thread search** (4.5) |
| `GET /search/conversations?q=&category=default&cursor=&limit=20` → `Page[Conversation]` | `GET /v2/search-direct-cast-inbox` | inbox filter box |
| `GET /recipients?q=&cursor=&limit=20` → `Page[MessageUser]` | `GET /v2/direct-cast-users` (`excludeFids=[self]`) | new-conversation picker |
| `POST /metadata/preview` body `MetadataPreviewRequest` → `MessageMetadata` | `PUT /v2/direct-cast-message-metadata` | composer link preview; debounced client-side; `preview` rate bucket |
| `POST /events/ticket` → `MessagesEventsTicket { ticket, expires_in: 30 }` | none | first-party JWT (Authorization header; a missing or non-Bearer header is `401 invalid_token` with `WWW-Authenticate: Bearer`, never 403); `events_ticket` bucket. Opaque single-use ticket (`secrets.token_urlsafe(32)`), stored in Redis **hashed** (`messages:ws_ticket:<sha256>`) with a 30 s TTL, bound to the JWT's fid and `exp`, consumed atomically (`GETDEL`) by the first WS connect |
| `WS /events?ticket=<ticket>` → `MessagesEvent` frames | Phase A: server-side poll fan-out (per-FID 5 s ticker); Phase B: upstream relay | client sends `{ "type": "ping" }`; uses the stored DC token like every route and closes 4403 (reason = `messaging_token_*` code) when it is missing, expired or rejected. Ticket is the only accepted credential (the former `?token=<jwt>` fallback was removed: a JWT in a URL leaks into proxy/access logs and history; a `?token=` param is ignored). At the handshake a missing, consumed, expired, unknown or malformed ticket closes `4401` reason `ticket_rejected`. The session is checked again every poll tick: closes `4401` reason `session_expired` once the issuing JWT's `exp` passes. Clients: `POST /events/ticket` right before each (re)connect |

### 4.3 Service shape (`direct_cast_service.py`)

```python
class DirectCastService:
    def __init__(self, http: httpx.AsyncClient, redis: Redis): ...
    async def resolve_bearer(self, db, fid: int, client_bearer: str | None) -> str
    async def inbox(self, bearer, *, category, filter_, cursor, limit) -> InboxResponse
    async def conversation_with(self, viewer, peer_fid) -> Conversation
    async def messages(self, viewer, conversation_id, *, cursor, anchor, limit) -> MessagesPage
    async def accept_request(self, viewer, conversation_id) -> None
    async def decline_request(self, viewer, conversation_id) -> None
    async def send(self, bearer, fid, body: SendMessageRequest) -> Message
    async def react(self, bearer, body: ReactionRequest, *, remove: bool) -> None
    async def reactors(self, bearer, conversation_id, message_id, cursor, limit) -> Page[ReactorEntry]
    async def mark_read(self, bearer, conversation_id) -> None
    async def search_messages(self, bearer, q, cursor, limit) -> Page[MessageSearchHit]
    async def search_recipients(self, bearer, fid, q, cursor, limit) -> Page[MessageUser]
    async def preview_metadata(self, bearer, text) -> MessageMetadata
```

`_request()` is the single place that builds upstream URLs/headers, mirrors
`farcaster_spaces_service._get_http_client`, and raises
`DirectCastUpstreamError(status, path_tag)` with no body echoed.
`normalize_message()` / `normalize_conversation()` are pure functions with
unit tests against fixture JSON captured from S2 types.

---

### 4.4 Thread paging (both directions)

**Page order:** `items` in every thread response (`/messages`, `/recent`,
`MessageSearchHit.before` and `.after`) is **newest-first** (`sent_at`
descending). The server stable-sorts, so clients can rely on it whatever
order upstream sends.

* `next_cursor` continues toward **older** messages. `next_newer_cursor`
  continues toward **newer** messages. Either one goes back as `?cursor=`;
  the direction is encoded in the cursor, so there is no `direction` param.
  `null` means nothing more in that direction.
* Upstream returns a single base64-JSON cursor
  `{page, limit, before?, after?, midpoint?}`. The server splits it the way
  the official client does: the older cursor keeps `before`, the newer one
  keeps `after`, and `midpoint` is dropped. A cursor that does not decode
  passes through as `next_cursor` and `next_newer_cursor` is null, which is
  the round-1 behaviour.
* **Normal open:** call `/messages` with no cursor, keep following
  `next_cursor` while scrolling up, and poll `/recent` for new messages.
  `next_newer_cursor` is normally null here.
* **Jump to a message:** call `/messages?anchor_message_id=X`, or seed the
  thread from a search hit as `[...after, message, ...before]` (4.5).
  Keep two cursors: the older one from the *oldest* page loaded and the
  newer one from the *newest* page loaded. Scrolling up follows the older
  cursor and replaces only that one; scrolling down follows the newer cursor
  and replaces only that one. Once the newer cursor comes back `null` you
  are at the live end: switch to `/recent` polling.
* Pages can overlap at the edges. Dedupe by `message_id`.

### 4.5 Search, in-thread search, highlights

`GET /search?q=&conversation_id=` is the official in-thread search path.
Upstream has no per-conversation search parameter [verified: S2 query
params], so the server filters global hits by
`message.conversation_id == conversation_id`. Paging rules:

* Each call scans up to 3 upstream pages (`MAX_SEARCH_SCAN_PAGES`) and
  returns **at most `limit`** hits. When an upstream page has more matches
  than fit, the response is sliced and `next_cursor` is a server cursor
  (`ts1.` + base64url `{c: upstream_cursor, o: offset, n: page_size}`) that
  re-fetches that upstream page with the same page size and resumes at the
  first unreturned match. When a page is consumed exactly, `next_cursor` is
  the plain upstream cursor. Treat both as opaque; a malformed `ts1.`
  cursor answers `400 invalid_cursor`.
* A page is short or empty **with** a non-null `next_cursor` only when the
  3-page scan budget ran out before `limit` matches were found (a sparse
  thread): keep paging. Only `next_cursor: null` ends the search. Upstream
  results can shift between calls (new messages), so a resume may skip or
  repeat a hit; de-dupe by `message.message_id`.
* Hits are in upstream relevance order (not time order). Without
  `conversation_id` each call scans exactly one upstream page.

Hit fields:

* `highlights`: raw upstream (OpenSearch) snippets, passed through
  **unchanged**. Matched terms are wrapped in `<fc_highlight>…</fc_highlight>`
  (`<em>` is also accepted). A snippet can span several lines and can be a
  fragment of `message.text`. Use it only if you want snippet display.
* `highlight_ranges`: half-open `[start, end)` ranges in **UTF-16 code
  units** of `message.text`, which are JS string indices, so
  `text.slice(start, end)` works. They are sorted and non-overlapping
  (merged). If a snippet's tag-stripped text occurs verbatim in
  `message.text`, its exact tag positions are used. Otherwise every
  case-insensitive occurrence of its matched terms is used. The list is
  empty when nothing could be located.
* `matched_terms`: distinct tag-stripped terms, in first-seen order, with
  the original casing. Use these to highlight terms in context bubbles.
* `before` / `after`: older / newer neighbours of `message`, both
  newest-first.
* `thread_cursor` / `thread_newer_cursor`: come from upstream
  `surroundingMessagesCursor` and are split as in 4.4. Seed the thread with
  `[...after, message, ...before]`, then page older with `thread_cursor` and
  newer with `thread_newer_cursor` on `GET /conversations/{id}/messages`.
  Both are null when upstream gives none. Fall back to
  `anchor_message_id=message.message_id`.

### 4.6 Feature off vs. not found: `GET /status`

`GET /v1/messages/status` is the capability probe. It never 404s and never
calls upstream:

| Situation | Response |
|---|---|
| flag off | `200 { enabled: false, signer_status: null, token_status: null, expires_at: null }` |
| flag on, token active | `200 { enabled: true, signer_status: "ready", token_status: "active", expires_at }` (not yet proven upstream; a revoked token surfaces later as `403 messaging_token_rejected`) |
| no token | `signer_status: "not_linked", token_status: "missing"` |
| token past expiry | `signer_status: "not_linked", token_status: "expired"` |
| token undecryptable / key config | `signer_status: "unavailable"` |

`token_status` / `expires_at` describe the custody-minted DC token, which is
the only credential DC calls use (section 3.2). Gate on
`token_status === "active"`; obtain one with `POST /v1/messages/enable`. Any other route
answering `404 { detail: "messaging_disabled" }` means the flag flipped off,
so refetch `/status`. `404 not_found` / `conversation_not_found` are real
misses.

### 4.7 Websocket close codes and read state

| Close code | Meaning | Client action |
|---|---|---|
| 4401 reason `ticket_rejected` | handshake: no ticket was sent, or it was unknown, already used, expired or malformed | mint a fresh ticket (`POST /events/ticket`) and reconnect. Do **not** refresh auth unless that mint itself answers 401; then refresh the JWT, mint again and reconnect once; if that fails, sign out |
| 4401 reason `session_expired` | mid-stream: the JWT that minted the ticket reached its `exp` | refresh the JWT, mint a new ticket and reconnect once; if it fails again, sign out |
| 4403 | no usable DC token; close reason is `messaging_token_missing` / `messaging_token_expired` / `messaging_token_rejected` (also raised mid-stream when a poll gets a 403) | **stop reconnecting**; show the "Enable messages" CTA |
| 4404 | messaging disabled | stop; refetch `GET /status` |
| 4429 | over the `events` budget (30 connects/min) | back off at least 60 s, then reconnect |
| 1011 | internal or setup failure (Redis/DB) | reconnect with exponential backoff |
| 1000 / 1001 / network drop | normal close or transport loss | reconnect with backoff |

The server sends `{ "type": "ping" }` after 25 s idle. Client pings are
accepted and ignored. A Redis error while reading the pub/sub channel is
logged (exception type only) and the loop continues, like a failed poll
tick.

Phase A diff (`direct_cast_relay.diff_inbox`): each snapshot also stores a
watermark (max `last_message.sent_at` on the page, reserved key
`~watermark`). A `message` frame is emitted only when the row's
`last_message.sent_at` is strictly greater than the previous tick's
watermark. This applies to rows new on page 1 and to existing rows whose
`last_message` id changed. Otherwise (unarchive, accepted request, a row
below falling off, a delete exposing an older message, `last_message`
becoming null, an equal timestamp) it emits `inbox`, as does any row
compared against a snapshot from before the watermark existed. An
unchanged `last_message` with a different `unread_count` emits `inbox`.

Read semantics:

* `Message.is_last_read` is the **viewer's own** last-read marker (upstream
  `viewerContext.isLastReadMessage`). Use it to place the "new messages"
  divider. It says nothing about the peer.
* `Conversation.last_read_at` is when the viewer last read (ms epoch).
* `Conversation.peer_last_read_at` is the other party's read position
  (upstream `lastReadTime` [verified: official client computes
  `otherPartyRead = conversation.lastReadTime >= directCast.serverTimestamp`]).
  A viewer-sent message counts as **read by the peer iff
  `peer_last_read_at >= message.sent_at`**. `0` means the peer has never
  read. `null` for groups (no per-member state upstream) or when upstream
  omits it. It is a timestamp, not a message id.
* A `read` frame has `read_by: "viewer"` when the viewer's own state
  changed (another device) and `read_by: "peer"` when `peer_last_read_at`
  advanced. Refetch the conversation, or the inbox row, to get the new
  values.

### 4.8 Message requests

Requests are conversations with `category: "request"`. List them with
`GET /inbox?category=request`; `InboxResponse.requests_count` and
`has_unread_requests` drive the badge. `POST .../accept` moves a request to
the default inbox. `POST .../decline` deletes it from the viewer's side only,
and the sender still sees the conversation. Both go to upstream
`POST /v2/direct-cast-conversation-categorization` [verified:
`ApiDirectCastConversationAlterCategory = default | archived | deleted`;
decline = `deleted` matches the official "Delete" request action]. After
either call, refetch the inbox. Replying to a request also works upstream,
but accepting first is the official UX.

## 5. Shared TypeScript types

One file per client, byte-identical content, kept in sync by a Jest test on
mobile that imports both (landing path via relative import is not possible
across packages, so the test asserts a checksum of the mobile copy against
`docs/messaging-types.sha` committed by the contract workstream; cheap and
explicit).

* `farcaster-audio/types/messages.ts`
* `landing/lib/api/messages.types.ts`

```ts
export interface MessageUser { fid: number; username: string | null; display_name: string; pfp_url: string | null }
export interface MessageMedia { url: string; width: number; height: number; mime_type: string | null }
export interface MessageUrlEmbed { url: string; title: string | null; description: string | null; image_url: string | null; domain: string | null }
export interface MessageMetadata { medias: MessageMedia[]; urls: MessageUrlEmbed[]; mentions: MessageUser[]; cast_hashes: string[] }
export interface MessageReactionSummary { reaction: string; count: number; viewer_reacted: boolean }
export type MessageType = "text" | "group_name_change" | "group_membership_addition" | "group_membership_removal" | "pin_message" | "message_ttl_change" | "rich_announcement";
/** In a send echo whose parent was not in the server cache, only message_id is known: sender.fid === 0 and text === "" — keep the locally known quote. */
export interface MessageQuote { message_id: string; sender: MessageUser; text: string; is_deleted: boolean }
export interface Message {
  message_id: string; conversation_id: string; sender: MessageUser; type: MessageType; text: string;
  sent_at: number; reactions: MessageReactionSummary[]; in_reply_to: MessageQuote | null;
  metadata: MessageMetadata | null; is_deleted: boolean; is_pinned: boolean; is_last_read: boolean;
  /** client-only, never from the server */ send_state?: "sending" | "failed";
}
export type ConversationCategory = "default" | "archived" | "request" | "void";
export interface Conversation {
  conversation_id: string; is_group: boolean; name: string | null; photo_url: string | null;
  participants: MessageUser[]; counterparty: MessageUser | null; last_message: Message | null;
  unread_count: number; unread_mentions_count: number; muted: boolean; pinned: boolean; archived: boolean;
  category: ConversationCategory; access: "read" | "read-write"; last_read_at: number;
  manually_marked_unread: boolean; created_at: number;
  /** ms epoch the other party has read up to; a viewer-sent message is read iff peer_last_read_at >= sent_at. 0 = never, null = group/unknown. Always sent; optional for older fixtures. */
  peer_last_read_at?: number | null;
}
export interface Page<T> { items: T[]; next_cursor: string | null }
/** Thread page, items newest-first. next_cursor -> older, next_newer_cursor -> newer; pass either back as ?cursor=. */
export interface MessagesPage extends Page<Message> { next_newer_cursor: string | null }
export interface InboxResponse extends Page<Conversation> { requests_count: number; has_unread_requests: boolean; has_archived: boolean }
export interface SendMessageRequest { conversation_id: string | null; recipient_fids: number[]; message_id: string; text: string; in_reply_to_id: string | null; process_metadata?: boolean }
export interface SendMessageResponse { message: Message }
export interface ReactionRequest { conversation_id: string; message_id: string; reaction: string }
export interface ReactorEntry { user: MessageUser; reaction: string }
/** Half-open [start, end) in UTF-16 code units of message.text (JS string indices). */
export interface HighlightRange { start: number; end: number }
export interface MessageSearchHit {
  message: Message; conversation: Conversation;
  /** raw upstream snippets: matched terms wrapped in <fc_highlight>…</fc_highlight> (or <em>); prefer highlight_ranges */
  highlights: string[];
  /** context, both newest-first: before = older than message, after = newer */
  before: Message[]; after: Message[];
  /** Always sent; optional for older fixtures. Sorted, non-overlapping. */
  highlight_ranges?: HighlightRange[];
  /** Distinct tag-stripped matched terms, first-seen order. */
  matched_terms?: string[];
  /** Jump seed: render [...after, message, ...before], then page /messages with these as ?cursor=. */
  thread_cursor?: string | null; thread_newer_cursor?: string | null;
}
export type SignerStatus = "ready" | "not_linked" | "invalid_bearer" | "unavailable";
/** Custody-signed Farcaster `generateToken` request (times in Unix ms). */
export interface DirectCastAuthRequest { method: "generateToken"; params: { timestamp: number; expiresAt: number } }
/** Body for POST /v1/messages/enable; also optional on signer register. */
export interface EnableMessagingRequest { dc_auth_request: DirectCastAuthRequest; dc_auth_signature: string }
export type MessagingTokenStatus = "active" | "missing" | "expired";
/**
 * GET /v1/messages/status (ungated, never 404s). `enabled` is the feature
 * flag, not credential health. `signer_status`, `token_status` and
 * `expires_at` (ISO 8601) are null when the feature is off.
 */
export interface MessagingStatus { enabled: boolean; signer_status: SignerStatus | null; token_status: MessagingTokenStatus | null; expires_at: string | null }
/** 200 from POST /v1/messages/enable — refetch status for the rest. */
export interface EnableMessagingResponse { token_status: MessagingTokenStatus; expires_at: string | null }
export type MessagesEvent =
  | { type: "message"; conversation_id: string; message: Message }
  | { type: "read"; conversation_id: string; read_by?: "viewer" | "peer" }
  | { type: "inbox"; conversation_id: string }
  | { type: "ping" };
/**
 * 200 from POST /v1/messages/events/ticket. Connect within expires_in seconds as
 * /v1/messages/events?ticket=<ticket>; single use, bound to the JWT fid.
 */
export interface MessagesEventsTicket { ticket: string; expires_in: number }
/** 422 body when upstream refused the request itself; message is sanitized, <= 200 chars, may be absent. */
export interface UpstreamRejectedError { detail: "upstream_rejected"; message?: string }
```

---

## 6. Feature checklist (Telegram-grade) and API support

| Feature | Supported by upstream? | How |
|---|---|---|
| Inbox with unread badges, requests folder, archived | Yes | `inbox` `unread_count`, `category` |
| Optimistic send, retry on failure | Yes | client uuid `message_id` + upstream idempotency; `send_state` |
| Swipe-to-reply (mobile) / hover reply (web) | Yes | `in_reply_to_id`; quoted bubble from `in_reply_to` |
| Long-press reaction picker, tap-to-toggle | Yes | `PUT/DELETE /reactions`; `viewer_reacted` |
| Who-reacted sheet | Yes | `GET /reactions` paginated |
| Global message search with highlights + context | Yes | `GET /search` (`highlights`, `before`, `after`) |
| In-thread search, jump-to-message, highlight | Yes (server-filtered) | `GET /search?conversation_id=` (4.5); seed from hit + `thread_cursor`/`thread_newer_cursor` or `anchor_message_id`; page both ways (4.4); `highlight_ranges`; 1.2 s flash |
| Read receipts (per conversation, not per message) | Yes (1:1) | peer: `peer_last_read_at >= sent_at`; own: `last_read_at`, `is_last_read`; `read` event with `read_by` (4.7) |
| Message requests accept / decline | Yes | `POST /conversations/{id}/accept`, `/decline` (4.8) |
| Open DM from a profile | Yes | `GET /conversations/with/{fid}` → thread, 404 → compose new |
| Typing indicators | **No** (no upstream message type) | omit; do not fake it. Possible later only for Juke-native fallback |
| Delete own message | Yes | `DELETE .../messages/{id}` (upstream marks `is_deleted`) |
| Link previews / OG embeds | Yes | `POST /metadata/preview` while composing; `metadata.urls` on render (reuse `useOgPreview` / landing embed cards) |
| Image attachments | Partial, v2 | `POST /v1/generate-image-upload-url` only verified via S5; defer |
| Mentions `@user` | Yes | `metadata.mentions`; reuse `MentionSuggestions` |
| Pagination / virtualized list | Yes | cursor pages, 30 per page; `FlashList` inverted on mobile, `@tanstack/react-virtual` on web |
| Haptics | n/a | `expo-haptics` on reaction pick, send, swipe threshold |
| Mark unread, mute, pin, archive | Yes | mark-unread in v1; mute/pin/archive v2 (endpoints catalogued) |
| Group chats: read + send | Yes | same message endpoints; group create/admin v2 |
| Push notifications | No (v1) | see 3.5 |
| Real-time | Phase A poll / Phase B relay | see 3.4 |

---

## 7. Client plans

### 7.1 Mobile (`farcaster-audio/`)

Navigation:
* `app/(tabs)/_layout.tsx`: add `<Tabs.Screen name="messages" options={{ title: "Messages" }} />`.
* `components/navigation/GlassTabBar.tsx`: widen `renderTab`/`getTabConfig`
  union to `"index" | "messages" | "notifications"`, add a `chatbubbles` icon
  and an unread badge sourced from `messageStore.unreadTotal`.
* Routes: `app/(tabs)/messages.tsx` (inbox), `app/messages/[conversationId].tsx`
  (thread), `app/messages/new.tsx` (recipient picker), `app/messages/search.tsx`
  (global search).

State and data:
* `stores/messageStore.ts` (zustand, same style as `notificationStore.ts`):
  conversations by id, messages by conversation (ordered, deduped by
  `message_id`), optimistic queue, unread total, selected reply target.
* `services/messagesApi.ts`: thin typed wrappers over `apiClient` for every
  route in 4.2 plus `getMessagingStatus` / `enableMessaging`; sends no
  Farcaster credential (section 3.2).
* `hooks/useInbox.ts`, `hooks/useConversation.ts` (pagination, anchor jump,
  poll while focused, WS subscription via a `useMessagesEvents.ts` modelled on
  `useLiveSpaces.ts`), `hooks/useSendMessage.ts` (optimistic + retry),
  `hooks/useMessageSearch.ts`.

Components (`components/messages/`):
`ConversationRow`, `MessageList` (inverted FlashList, day separators,
grouped bubbles), `MessageBubble` (text, quote, embeds, reactions strip),
`SwipeToReply` (Reanimated + Gesture Handler, haptic at threshold),
`ReactionPicker` (long-press, quick row + full emoji), `ReactorsSheet`
(bottom sheet, paginated), `Composer` (reply preview, mention suggestions,
link preview via `/metadata/preview`), `SearchResultRow` (highlights),
`SignerGate` (wraps the tab: `useFarcasterAppKey.ensureApproved` or managed
signer status, CTA otherwise).

### 7.2 Web (`landing/`)

* `app/app/_components/nav-items.tsx`: add `{ href: "/app/messages", label: "Messages", mobileLabel: "DMs", icon: MessagesIcon, showsUnreadBadge: true }`
  (extend the badge slot to accept a source selector or add a second badge
  field; the current flag is notification-specific).
* Routes: `app/app/messages/page.tsx` (two-pane on desktop: inbox left,
  thread right; single-pane on mobile), `app/app/messages/[conversationId]/page.tsx`,
  `app/app/messages/new/page.tsx`, search as a slide-over inside the inbox
  pane, plus `?q=` deep link.
* Data: `lib/api/messages.ts` (`apiFetch` wrappers, no bearer header on web),
  `lib/api/messages.types.ts`, `lib/api/messagesEvents.ts` (copy of
  `events.ts` for `/v1/messages/events`), `lib/stores/messageStore.ts`.
* Components `components/messages/`: same list as mobile, web-idiomatic:
  hover action bar (reply, react, more), keyboard shortcuts (Enter send,
  Shift+Enter newline, Esc cancel reply, Cmd+K search), `react-virtual` list,
  `ReactorsPopover`, `EmojiPicker` (reuse whatever compose already uses).
* Read-only sessions (`signerStatus.isReadOnly`) see an inbox empty state with
  the relink CTA.

---

## 8. Fallback if B1 fails: Juke-native messaging

Same client contract (sections 4 and 5), different storage:

* Tables `conversations(id uuid, is_group, created_by_fid, created_at)`,
  `conversation_members(conversation_id, fid, last_read_at, muted, archived)`,
  `messages(id uuid, conversation_id, sender_fid, text, in_reply_to_id, metadata jsonb, deleted_at, created_at)`,
  `message_reactions(message_id, fid, reaction, created_at)`.
  Full-text search via Postgres `tsvector` on `messages.text`; `highlights`
  via `ts_headline`.
* `DirectCastService` becomes an interface with two implementations
  (`FarcasterDirectCastService`, `NativeDirectCastService`) selected by
  `MESSAGING_BACKEND = "farcaster" | "native"`.
* Real-time is trivially Redis pub/sub on write; typing indicators become
  possible (`{ type: "typing" }` with a 4 s TTL key).
* Reach limitation is the real cost: only Juke users can be messaged. Mitigate
  with an invite DC sent from the @jukeaudio service FID via the custody
  bearer we do hold (`farcaster_spaces_service._mint_bearer_for_key`) using
  `PUT /v2/direct-cast-send` [verified path, custody auth verified] or
  `ext-send-direct-cast`. This is an outbound notification, not an inbox.

Do not pursue a custody-bearer path for users: it would require retaining the
recovery phrase or a derived custody key, which `signerLink.ts` forbids.
If product insists, it is a separate security review, not an implementation
detail.

---

## 9. Workstreams

All four start after B1 is answered. W1 and W4 unblock W2/W3 via the
contract in sections 4-5, which is frozen on day one; W2/W3 develop against a
mocked `messagesApi` until W1 lands.

| # | Workstream | Owns (create/modify) | Deliverable |
|---|---|---|---|
| W1 | Backend proxy + realtime | `backend/app/routers/messages.py`, `backend/app/services/direct_cast_service.py`, `backend/app/services/direct_cast_relay.py`, `backend/app/schemas/messages.py`, `backend/app/config.py` (flags), `backend/app/main.py` (include_router), `backend/tests/test_messages_router.py`, `backend/tests/test_direct_cast_service.py`, `backend/tests/direct_cast_fake.py` | All routes in 4.2 behind `MESSAGING_ENABLED`; Phase A WS; Phase B relay behind `MESSAGING_RELAY_ENABLED` |
| W2 | Mobile UI | `farcaster-audio/app/(tabs)/_layout.tsx`, `app/(tabs)/messages.tsx`, `app/messages/**`, `components/navigation/GlassTabBar.tsx`, `components/messages/**`, `stores/messageStore.ts`, `services/messagesApi.ts`, `hooks/useInbox.ts`, `hooks/useConversation.ts`, `hooks/useSendMessage.ts`, `hooks/useMessageSearch.ts`, `hooks/useMessagesEvents.ts`, tests under `__tests__` next to each | Section 7.1 |
| W3 | Web UI | `landing/app/app/_components/nav-items.tsx`, `landing/app/app/messages/**`, `landing/components/messages/**`, `landing/lib/api/messages.ts`, `landing/lib/api/messagesEvents.ts`, `landing/lib/stores/messageStore.ts` | Section 7.2 |
| W4 | Contract + fixtures + verification | `farcaster-audio/types/messages.ts`, `landing/lib/api/messages.types.ts`, `docs/messaging-types.sha`, `backend/tests/fixtures/direct_cast/*.json` (captured upstream envelopes, redacted), a `scripts/probe_direct_cast.py` (B1 test, bearer from env only, never printed), and the B1 result appended to this doc | Frozen contract, shared fixtures used by W1 tests and W2/W3 mocks |

No file is owned by two workstreams. `backend/app/main.py` and
`config.py` edits are one-line and belong to W1 only.

Sequencing: W4 day 1 (B1 + types) -> W1/W2/W3 in parallel (~1 week each for
v1 scope: inbox, thread, send/reply, reactions, who-reacted, read state, global
+ in-thread search, polling) -> Phase B relay (W1, after v1) -> v2 (groups
admin, mute/pin/archive, images).

---

