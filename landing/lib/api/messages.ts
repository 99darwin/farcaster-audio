/**
 * Direct Casts (messaging) API for the Juke web app.
 *
 * Thin typed wrappers over {@link apiFetch} for every `/v1/messages/*` route in
 * the messaging design doc, section 4.2. Shapes live in `messages.types.ts`
 * (the frozen cross-client contract). The web client never sends
 * `X-Farcaster-Bearer` (the backend ignores it): every call is authorized with
 * the viewer's stored custody-minted Direct Cast token.
 */

import { ApiFetchError, apiFetch } from "@/lib/api/client";
import type {
  ConversationCategory,
  Conversation,
  EnableMessagingRequest,
  EnableMessagingResponse,
  InboxResponse,
  Message,
  MessageMetadata,
  MessageSearchHit,
  MessageUser,
  MessagesEventsTicket,
  MessagesPage,
  MessagingStatus,
  Page,
  ReactionRequest,
  ReactorEntry,
  SendMessageRequest,
  SendMessageResponse,
} from "@/lib/api/messages.types";
import { MAX_MESSAGE_LENGTH } from "@/lib/api/messages.types";

const BASE = "/v1/messages";

/** Page sizes mirror the backend defaults in design doc 4.2. */
const INBOX_PAGE_SIZE = 25;
const MESSAGES_PAGE_SIZE = 30;
const REACTORS_PAGE_SIZE = 50;
const SEARCH_PAGE_SIZE = 20;
/** Re-exported from the shared contract so callers have one import site. */
export { MAX_MESSAGE_LENGTH };

/** 403 details: the stored Direct Cast token is unusable (Enable-messages gate). */
export const MESSAGING_TOKEN_MISSING = "messaging_token_missing";
export const MESSAGING_TOKEN_EXPIRED = "messaging_token_expired";
export const MESSAGING_TOKEN_REJECTED = "messaging_token_rejected";
/** 503 detail: the server can't decrypt the stored token (transient). */
export const MESSAGING_TOKEN_UNAVAILABLE = "messaging_token_unavailable";

const MESSAGING_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  MESSAGING_TOKEN_MISSING,
  MESSAGING_TOKEN_EXPIRED,
  MESSAGING_TOKEN_REJECTED,
]);
/** 404 detail when the `MESSAGING_ENABLED` flag is off (design doc 4.6). */
export const MESSAGING_DISABLED = "messaging_disabled";
/** 404 details for a real miss on an existing feature (design doc 4.6). */
const NOT_FOUND_DETAILS: ReadonlySet<string> = new Set([
  "not_found",
  "conversation_not_found",
]);

type QueryValue = string | number | null | undefined;

/** Build `?a=1&b=2`, dropping null/undefined/empty values. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function conversationPath(conversationId: string): string {
  return `${BASE}/conversations/${encodeURIComponent(conversationId)}`;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** True for a 403 reason meaning the Direct Cast token must be (re)enabled. */
function isMessagingTokenDetail(detail: string | undefined): boolean {
  return detail !== undefined && MESSAGING_TOKEN_ERRORS.has(detail);
}

/** An {@link ApiFetchError} with `status` (and `detail`, when given). */
function isApiError(error: unknown, status: number, detail?: string): error is ApiFetchError {
  return (
    error instanceof ApiFetchError &&
    error.status === status &&
    (detail === undefined || error.detail === detail)
  );
}

/**
 * The stored Direct Cast token is missing, expired or rejected upstream. The
 * UI shows the Enable-messages gate; retrying won't help.
 */
export function isMessagingTokenError(error: unknown): boolean {
  return isApiError(error, 403) && isMessagingTokenDetail(error.detail);
}

/**
 * `MESSAGING_ENABLED` is off. Only a 404 whose detail is `messaging_disabled`
 * means that; any other 404 is a per-resource miss (design doc 4.6).
 */
export function isMessagingDisabledError(error: unknown): boolean {
  return isApiError(error, 404, MESSAGING_DISABLED);
}

/** The conversation (or message) doesn't exist or isn't visible to the viewer. */
export function isConversationNotFoundError(error: unknown): boolean {
  if (!isApiError(error, 404)) return false;
  // A bare 404 (no detail) from a proxy is treated as a miss, never as "off".
  return error.detail === undefined || NOT_FOUND_DETAILS.has(error.detail);
}

/**
 * 422 detail: upstream refused the request itself (content or state), not an
 * outage (design doc 4). The body may carry a sanitized `message`.
 */
export const UPSTREAM_REJECTED = "upstream_rejected";
/** 400 detail: a paging cursor the server can no longer resolve. */
export const INVALID_CURSOR = "invalid_cursor";

/** Shown when an `upstream_rejected` response carries no `message`. */
export const UPSTREAM_REJECTED_FALLBACK_COPY =
  "Farcaster didn't accept that. Check it and try again.";

/** Upstream refused the request; retrying the same request won't help. */
export function isUpstreamRejectedError(error: unknown): error is ApiFetchError {
  return isApiError(error, 422, UPSTREAM_REJECTED);
}

/**
 * User-facing copy for an `upstream_rejected` error: upstream's own `message`
 * when it gave one, else {@link UPSTREAM_REJECTED_FALLBACK_COPY}.
 */
export function upstreamRejectedCopy(error: ApiFetchError): string {
  const message = error.serverMessage?.trim();
  return message ? message : UPSTREAM_REJECTED_FALLBACK_COPY;
}

/** The paging cursor is stale or malformed: drop it and reload from the start. */
export function isInvalidCursorError(error: unknown): boolean {
  return isApiError(error, 400, INVALID_CURSOR);
}

/** Rate-limited by the per-FID sliding window. */
export function isRateLimitedError(error: unknown): boolean {
  return isApiError(error, 429);
}

/**
 * User-facing copy for a failed messaging call. `upstream_rejected` shows
 * upstream's own reason (it's about the request, not an outage); a rate
 * limit asks the user to slow down; anything else uses `fallback` unless the
 * error carries a non-API message.
 */
export function messagingErrorCopy(error: unknown, fallback: string): string {
  if (isUpstreamRejectedError(error)) return upstreamRejectedCopy(error);
  if (isRateLimitedError(error)) return "Slow down a little, then try again.";
  if (error instanceof ApiFetchError) return fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Inbox + conversations
// ---------------------------------------------------------------------------

export type InboxFilter = "unread" | "group" | "1-1";

export interface GetInboxParams {
  category?: ConversationCategory;
  filter?: InboxFilter | null;
  cursor?: string | null;
  limit?: number;
}

export function getInbox({
  category = "default",
  filter = null,
  cursor = null,
  limit = INBOX_PAGE_SIZE,
}: GetInboxParams = {}): Promise<InboxResponse> {
  return apiFetch<InboxResponse>(
    `${BASE}/inbox${buildQuery({ category, filter, cursor, limit })}`,
  );
}

export function getConversation(conversationId: string): Promise<Conversation> {
  return apiFetch<Conversation>(conversationPath(conversationId));
}

/**
 * The viewer's existing 1:1 with `fid` (design doc 4.3). 404
 * `conversation_not_found` when there is none yet (compose a draft), 400
 * `invalid_recipient` for the viewer's own fid.
 */
export function getConversationWith(fid: number): Promise<Conversation> {
  return apiFetch<Conversation>(`${BASE}/conversations/with/${encodeURIComponent(String(fid))}`);
}

/** Move a request into the default inbox (204). Refetch the inbox after. */
export function acceptConversation(conversationId: string): Promise<void> {
  return apiFetch<void>(`${conversationPath(conversationId)}/accept`, { method: "POST" });
}

/** Decline a request (204). Refetch the inbox after. */
export function declineConversation(conversationId: string): Promise<void> {
  return apiFetch<void>(`${conversationPath(conversationId)}/decline`, { method: "POST" });
}

export interface GetMessagesParams {
  cursor?: string | null;
  /** Load the page containing this message (jump-to-message). */
  anchorMessageId?: string | null;
  limit?: number;
}

/**
 * A thread page, newest-first. `next_cursor` pages older, `next_newer_cursor`
 * pages newer (null at the live end); pass either back as `cursor`.
 */
export function getMessages(
  conversationId: string,
  {
    cursor = null,
    anchorMessageId = null,
    limit = MESSAGES_PAGE_SIZE,
  }: GetMessagesParams = {},
): Promise<MessagesPage> {
  return apiFetch<MessagesPage>(
    `${conversationPath(conversationId)}/messages${buildQuery({
      cursor,
      anchor_message_id: anchorMessageId,
      limit,
    })}`,
  );
}

/** Polling target: the newest messages of a conversation. */
export function getRecentMessages(conversationId: string): Promise<Page<Message>> {
  return apiFetch<Page<Message>>(`${conversationPath(conversationId)}/recent`);
}

export function markConversationRead(conversationId: string): Promise<void> {
  return apiFetch<void>(`${conversationPath(conversationId)}/read`, {
    method: "POST",
  });
}

export function markConversationUnread(conversationId: string): Promise<void> {
  return apiFetch<void>(`${conversationPath(conversationId)}/unread`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function sendMessage(
  request: SendMessageRequest,
): Promise<SendMessageResponse> {
  return apiFetch<SendMessageResponse>(`${BASE}/send`, {
    method: "PUT",
    body: request,
  });
}

export function deleteMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  return apiFetch<void>(
    `${conversationPath(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  );
}

export function addReaction(request: ReactionRequest): Promise<void> {
  return apiFetch<void>(`${BASE}/reactions`, { method: "PUT", body: request });
}

export function removeReaction(request: ReactionRequest): Promise<void> {
  return apiFetch<void>(`${BASE}/reactions`, {
    method: "DELETE",
    body: request,
  });
}

export interface GetReactorsParams {
  conversationId: string;
  messageId: string;
  cursor?: string | null;
  limit?: number;
}

export function getReactors({
  conversationId,
  messageId,
  cursor = null,
  limit = REACTORS_PAGE_SIZE,
}: GetReactorsParams): Promise<Page<ReactorEntry>> {
  return apiFetch<Page<ReactorEntry>>(
    `${BASE}/reactions${buildQuery({
      conversation_id: conversationId,
      message_id: messageId,
      cursor,
      limit,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// Search + recipients + metadata
// ---------------------------------------------------------------------------

export interface SearchParams {
  q: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export interface SearchMessagesParams extends SearchParams {
  /** Restrict to one conversation (in-thread search). */
  conversationId?: string | null;
}

/**
 * Message search. A short or empty page with a non-null `next_cursor` means
 * "keep paging", not "no more results" (design doc 4.5).
 */
export function searchMessages({
  q,
  cursor = null,
  limit = SEARCH_PAGE_SIZE,
  signal,
  conversationId = null,
}: SearchMessagesParams): Promise<Page<MessageSearchHit>> {
  return apiFetch<Page<MessageSearchHit>>(
    `${BASE}/search${buildQuery({ q, conversation_id: conversationId, cursor, limit })}`,
    { signal },
  );
}

export function searchConversations({
  q,
  cursor = null,
  limit = SEARCH_PAGE_SIZE,
  signal,
  category = "default",
}: SearchParams & { category?: ConversationCategory }): Promise<
  Page<Conversation>
> {
  return apiFetch<Page<Conversation>>(
    `${BASE}/search/conversations${buildQuery({ q, category, cursor, limit })}`,
    { signal },
  );
}

export function searchRecipients({
  q,
  cursor = null,
  limit = SEARCH_PAGE_SIZE,
  signal,
}: SearchParams): Promise<Page<MessageUser>> {
  return apiFetch<Page<MessageUser>>(
    `${BASE}/recipients${buildQuery({ q, cursor, limit })}`,
    { signal },
  );
}

export function previewMetadata(
  text: string,
  signal?: AbortSignal,
): Promise<MessageMetadata> {
  return apiFetch<MessageMetadata>(`${BASE}/metadata/preview`, {
    method: "POST",
    body: { text },
    signal,
  });
}

// ---------------------------------------------------------------------------
// Messaging access (custody-signed Direct Cast token)
// ---------------------------------------------------------------------------

/**
 * Mint a single-use websocket ticket (30 s TTL) for `WS /events?ticket=`
 * (design doc 4.2). Call right before every (re)connect. `skipAuthRefresh`
 * lets the socket layer own the 401 -> refresh -> retry-once decision.
 */
export function createMessagesEventsTicket(): Promise<MessagesEventsTicket> {
  return apiFetch<MessagesEventsTicket>(`${BASE}/events/ticket`, {
    method: "POST",
    skipAuthRefresh: true,
  });
}

/** Ungated: `enabled: false` (not a 404) when the feature is off. */
export function getMessagingStatus(signal?: AbortSignal): Promise<MessagingStatus> {
  return apiFetch<MessagingStatus>(`${BASE}/status`, { signal });
}

/**
 * Store a custody-signed `generateToken` request. 400 `invalid_auth_request` /
 * `invalid_signature`, 429 `rate_limited`, 502 `registry_unavailable` /
 * `upstream_error`, 503 `messaging_unavailable`; 404 when the feature is off.
 */
export function enableMessaging(
  body: EnableMessagingRequest,
): Promise<EnableMessagingResponse> {
  return apiFetch<EnableMessagingResponse>(`${BASE}/enable`, { method: "POST", body });
}
