/**
 * Typed client for the Juke messaging proxy (`/v1/messages/*`, contract in
 * docs/messaging-design.md §4.2). Every call goes through the shared
 * `apiClient`, so the session JWT, refresh-on-401 and signer-revocation
 * handling all apply unchanged.
 *
 * Upstream auth (design §3.2): the backend acts with the viewer's stored
 * custody-minted Direct Cast token. The client sends no Farcaster credential;
 * a missing / expired / rejected token surfaces as a `token_*` error, which
 * the UI resolves with the "Enable messages" flow (`enableMessaging`).
 */

import axios, { type AxiosRequestConfig } from "axios";
import { apiClient, getApiErrorCode } from "@/services/api";
import type {
  EnableMessagingRequest,
  EnableMessagingResponse,
  MessagingStatus,
  Conversation,
  ConversationCategory,
  InboxResponse,
  MessageMetadata,
  MessageSearchHit,
  MessagesEventsTicket,
  MessagesPage,
  MessageUser,
  Page,
  ReactionRequest,
  ReactorEntry,
  SendMessageRequest,
  SendMessageResponse,
} from "@/types/messages";

const BASE_PATH = "/v1/messages";

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNPROCESSABLE = 422;

/** 404 detail on any gated route when `MESSAGING_ENABLED` is off (§4.6). */
const MESSAGING_DISABLED_DETAIL = "messaging_disabled";
const INVALID_RECIPIENT_DETAIL = "invalid_recipient";
/** 422 detail when upstream refused the request itself (content/state), §4. */
const UPSTREAM_REJECTED_DETAIL = "upstream_rejected";
/** 400 detail for a malformed paging cursor (search `ts1.` cursors, §4.5). */
const INVALID_CURSOR_DETAIL = "invalid_cursor";

export type MessagesErrorCode =
  /** `MESSAGING_ENABLED` is off: the inbox (our availability probe) 404s. */
  | "unavailable"
  | "not_found"
  /** `GET /conversations/with/{fid}` with the viewer's own fid (400). */
  | "invalid_recipient"
  /** No stored Direct Cast token: render the "Enable messages" flow. */
  | "token_missing"
  /** The stored token is past its expiry: enable again. */
  | "token_expired"
  /** Upstream refused the stored token (e.g. revoked): enable again. */
  | "token_rejected"
  | "rate_limited"
  /**
   * Farcaster refused this request (422 `upstream_rejected`): not an outage,
   * and a send must not be retried automatically.
   */
  | "upstream_rejected"
  /** The paging cursor no longer decodes (400): restart from the first page. */
  | "invalid_cursor"
  /** The session JWT was refused (401 that survived, or skipped, refresh). */
  | "unauthorized"
  | "upstream_error"
  | "network"
  | "unknown";

/** Typed failure for every messages call; never carries request config. */
export class MessagesApiError extends Error {
  readonly code: MessagesErrorCode;
  readonly status: number | null;
  /**
   * Upstream's own explanation on an `upstream_rejected` 422, already
   * sanitized and capped server-side; null when upstream gave none.
   */
  readonly upstreamMessage: string | null;

  constructor(
    code: MessagesErrorCode,
    status: number | null,
    upstreamMessage: string | null = null,
  ) {
    super(`messages_api:${code}`);
    this.name = "MessagesApiError";
    this.code = code;
    this.status = status;
    this.upstreamMessage = upstreamMessage;
  }
}

export type MessagingTokenErrorCode = Extract<
  MessagesErrorCode,
  "token_missing" | "token_expired" | "token_rejected"
>;

/** Backend 403 `detail` (and WS 4403 close reason) to client code (§4.7). */
const TOKEN_ERROR_BY_DETAIL: Readonly<Record<string, MessagingTokenErrorCode>> = {
  messaging_token_missing: "token_missing",
  messaging_token_expired: "token_expired",
  messaging_token_rejected: "token_rejected",
};

/**
 * Map a backend token `detail` / WS close reason to its client code. Any
 * unrecognised value on a 403 / 4403 is treated as "no token".
 */
export function toMessagingTokenError(
  detail: string | null | undefined,
): MessagingTokenErrorCode {
  return (detail && TOKEN_ERROR_BY_DETAIL[detail]) || "token_missing";
}

/** Token problems the UI resolves by showing the "Enable messages" gate. */
export function isSignerError(
  error: unknown,
): error is MessagesApiError & { code: MessagingTokenErrorCode } {
  return (
    error instanceof MessagesApiError &&
    (error.code === "token_missing" ||
      error.code === "token_expired" ||
      error.code === "token_rejected")
  );
}

export function isAbortError(error: unknown): boolean {
  if (axios.isCancel(error)) return true;
  return error instanceof Error && error.name === "CanceledError";
}

/** The optional `message` of a 422 `upstream_rejected` body, if usable. */
function readUpstreamMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const message = (data as Record<string, unknown>).message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toMessagesError(error: unknown): MessagesApiError | unknown {
  if (isAbortError(error)) return error;
  if (!axios.isAxiosError(error)) return error;
  const status = error.response?.status ?? null;
  if (status === null) return new MessagesApiError("network", null);
  const detail = getApiErrorCode(error);
  if (status === HTTP_NOT_FOUND && detail === MESSAGING_DISABLED_DETAIL) {
    return new MessagesApiError("unavailable", status);
  }
  if (status === HTTP_BAD_REQUEST && detail === INVALID_RECIPIENT_DETAIL) {
    return new MessagesApiError("invalid_recipient", status);
  }
  if (status === HTTP_BAD_REQUEST && detail === INVALID_CURSOR_DETAIL) {
    return new MessagesApiError("invalid_cursor", status);
  }
  if (status === HTTP_UNPROCESSABLE && detail === UPSTREAM_REJECTED_DETAIL) {
    return new MessagesApiError(
      "upstream_rejected",
      status,
      readUpstreamMessage(error.response?.data),
    );
  }
  if (status === HTTP_UNAUTHORIZED) {
    return new MessagesApiError("unauthorized", status);
  }
  if (status === HTTP_NOT_FOUND) {
    return new MessagesApiError("not_found", status);
  }
  if (status === HTTP_FORBIDDEN && detail && detail in TOKEN_ERROR_BY_DETAIL) {
    return new MessagesApiError(toMessagingTokenError(detail), status);
  }
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return new MessagesApiError("rate_limited", status);
  }
  if (status === HTTP_BAD_GATEWAY) {
    return new MessagesApiError("upstream_error", status);
  }
  return new MessagesApiError("unknown", status);
}

interface RequestOptions {
  signal?: AbortSignal;
}

async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await apiClient.request<T>(config);
    return response.data;
  } catch (error) {
    throw toMessagesError(error);
  }
}

/** Drop empty params so the backend sees its own defaults. */
function compactParams(
  params: Record<string, string | number | null | undefined>,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    result[key] = value;
  }
  return result;
}

const conversationPath = (conversationId: string) =>
  `${BASE_PATH}/conversations/${encodeURIComponent(conversationId)}`;

// ---------------------------------------------------------------------------
// Routes (§4.2)
// ---------------------------------------------------------------------------

export interface InboxParams {
  category?: ConversationCategory;
  filter?: "unread" | "group" | "1-1";
  cursor?: string | null;
  limit?: number;
}

const INBOX_PAGE_SIZE = 25;
const MESSAGES_PAGE_SIZE = 30;
const SEARCH_PAGE_SIZE = 20;
const REACTORS_PAGE_SIZE = 50;

export async function getInbox(
  params: InboxParams = {},
  options: RequestOptions = {},
): Promise<InboxResponse> {
  try {
    return await request<InboxResponse>({
      method: "GET",
      url: `${BASE_PATH}/inbox`,
      params: compactParams({
        category: params.category ?? "default",
        filter: params.filter,
        cursor: params.cursor,
        limit: params.limit ?? INBOX_PAGE_SIZE,
      }),
      signal: options.signal,
    });
  } catch (error) {
    // The router is mounted behind `MESSAGING_ENABLED`; a 404 on the inbox
    // means the feature is off for this deployment, not a missing resource.
    if (error instanceof MessagesApiError && error.code === "not_found") {
      throw new MessagesApiError("unavailable", error.status);
    }
    throw error;
  }
}

export function getConversation(
  conversationId: string,
  options: RequestOptions = {},
): Promise<Conversation> {
  return request<Conversation>({
    method: "GET",
    url: conversationPath(conversationId),
    signal: options.signal,
  });
}

export interface MessagesParams {
  cursor?: string | null;
  anchorMessageId?: string | null;
  limit?: number;
}

export function getMessages(
  conversationId: string,
  params: MessagesParams = {},
  options: RequestOptions = {},
): Promise<MessagesPage> {
  return request<MessagesPage>({
    method: "GET",
    url: `${conversationPath(conversationId)}/messages`,
    params: compactParams({
      cursor: params.cursor,
      anchor_message_id: params.anchorMessageId,
      limit: params.limit ?? MESSAGES_PAGE_SIZE,
    }),
    signal: options.signal,
  });
}

export function getRecentMessages(
  conversationId: string,
  options: RequestOptions = {},
): Promise<MessagesPage> {
  return request<MessagesPage>({
    method: "GET",
    url: `${conversationPath(conversationId)}/recent`,
    signal: options.signal,
  });
}

/**
 * `GET /conversations/with/{fid}`: the viewer's 1:1 with `fid`. Rejects with
 * `not_found` when none exists yet (open a draft) and `invalid_recipient` for
 * the viewer's own fid.
 */
export function getConversationWith(
  fid: number,
  options: RequestOptions = {},
): Promise<Conversation> {
  return request<Conversation>({
    method: "GET",
    url: `${BASE_PATH}/conversations/with/${encodeURIComponent(String(fid))}`,
    signal: options.signal,
  });
}

type ConversationAction = "accept" | "decline" | "read" | "unread";

function postConversationAction(
  conversationId: string,
  action: ConversationAction,
): Promise<void> {
  return request<void>({
    method: "POST",
    url: `${conversationPath(conversationId)}/${action}`,
  });
}

/** Move a request into the main inbox. */
export function acceptConversationRequest(conversationId: string): Promise<void> {
  return postConversationAction(conversationId, "accept");
}

/** Dismiss a message request. */
export function declineConversationRequest(conversationId: string): Promise<void> {
  return postConversationAction(conversationId, "decline");
}

export function sendMessage(
  body: SendMessageRequest,
): Promise<SendMessageResponse> {
  return request<SendMessageResponse>({
    method: "PUT",
    url: `${BASE_PATH}/send`,
    data: body,
  });
}

export function markConversationRead(conversationId: string): Promise<void> {
  return postConversationAction(conversationId, "read");
}

export function markConversationUnread(conversationId: string): Promise<void> {
  return postConversationAction(conversationId, "unread");
}

export function deleteMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  return request<void>({
    method: "DELETE",
    url: `${conversationPath(conversationId)}/messages/${encodeURIComponent(messageId)}`,
  });
}

export function addReaction(body: ReactionRequest): Promise<void> {
  return request<void>({ method: "PUT", url: `${BASE_PATH}/reactions`, data: body });
}

export function removeReaction(body: ReactionRequest): Promise<void> {
  return request<void>({
    method: "DELETE",
    url: `${BASE_PATH}/reactions`,
    data: body,
  });
}

export interface ReactorsParams {
  conversationId: string;
  messageId: string;
  cursor?: string | null;
  limit?: number;
}

export function getReactors(
  params: ReactorsParams,
  options: RequestOptions = {},
): Promise<Page<ReactorEntry>> {
  return request<Page<ReactorEntry>>({
    method: "GET",
    url: `${BASE_PATH}/reactions`,
    params: compactParams({
      conversation_id: params.conversationId,
      message_id: params.messageId,
      cursor: params.cursor,
      limit: params.limit ?? REACTORS_PAGE_SIZE,
    }),
    signal: options.signal,
  });
}

export interface SearchMessagesParams {
  /** Restrict hits to one thread (in-thread search). */
  conversationId?: string | null;
  cursor?: string | null;
  limit?: number;
}

export function searchMessages(
  query: string,
  params: SearchMessagesParams = {},
  options: RequestOptions = {},
): Promise<Page<MessageSearchHit>> {
  return request<Page<MessageSearchHit>>({
    method: "GET",
    url: `${BASE_PATH}/search`,
    params: compactParams({
      q: query,
      conversation_id: params.conversationId,
      cursor: params.cursor,
      limit: params.limit ?? SEARCH_PAGE_SIZE,
    }),
    signal: options.signal,
  });
}

export function searchRecipients(
  query: string,
  params: { cursor?: string | null; limit?: number } = {},
  options: RequestOptions = {},
): Promise<Page<MessageUser>> {
  return request<Page<MessageUser>>({
    method: "GET",
    url: `${BASE_PATH}/recipients`,
    params: compactParams({
      q: query,
      cursor: params.cursor,
      limit: params.limit ?? SEARCH_PAGE_SIZE,
    }),
    signal: options.signal,
  });
}

export function previewMetadata(
  text: string,
  options: RequestOptions = {},
): Promise<MessageMetadata> {
  return request<MessageMetadata>({
    method: "POST",
    url: `${BASE_PATH}/metadata/preview`,
    data: { text },
    signal: options.signal,
  });
}

// ---------------------------------------------------------------------------
// Access: capability probe and the "Enable messages" token exchange (§4.6)
// ---------------------------------------------------------------------------

/** `GET /status`: never 404s and never calls upstream. */
export function getMessagingStatus(
  options: RequestOptions = {},
): Promise<MessagingStatus> {
  return request<MessagingStatus>({
    method: "GET",
    url: `${BASE_PATH}/status`,
    signal: options.signal,
  });
}

export type EnableMessagingErrorCode =
  /** Signature did not recover to the account's custody address. */
  | "invalid_signature"
  | "invalid_auth_request"
  | "rate_limited"
  /** Feature flag off (404). */
  | "unavailable"
  | "network"
  | "upstream_error"
  | "unknown";

const ENABLE_ERROR_BY_DETAIL: Readonly<Record<string, EnableMessagingErrorCode>> = {
  invalid_signature: "invalid_signature",
  invalid_auth_request: "invalid_auth_request",
  rate_limited: "rate_limited",
  registry_unavailable: "upstream_error",
  upstream_error: "upstream_error",
  token_rejected: "upstream_error",
  messaging_unavailable: "upstream_error",
};

/** Typed `POST /enable` failure; never carries the request body. */
export class EnableMessagingError extends Error {
  readonly code: EnableMessagingErrorCode;

  constructor(code: EnableMessagingErrorCode) {
    super(`enable_messaging:${code}`);
    this.name = "EnableMessagingError";
    this.code = code;
  }
}

function toEnableError(error: unknown): EnableMessagingError {
  if (!axios.isAxiosError(error)) return new EnableMessagingError("unknown");
  const status = error.response?.status ?? null;
  if (status === null) return new EnableMessagingError("network");
  if (status === HTTP_TOO_MANY_REQUESTS) return new EnableMessagingError("rate_limited");
  const detail = getApiErrorCode(error);
  const mapped = detail ? ENABLE_ERROR_BY_DETAIL[detail] : undefined;
  if (mapped) return new EnableMessagingError(mapped);
  if (status === HTTP_NOT_FOUND) return new EnableMessagingError("unavailable");
  return new EnableMessagingError("unknown");
}

/**
 * `POST /enable`: exchange a custody-signed `generateToken` request for the
 * stored Direct Cast token. The axios error (which holds the signed body in
 * its config) is never rethrown, only a typed code.
 */
export async function enableMessaging(
  body: EnableMessagingRequest,
): Promise<EnableMessagingResponse> {
  try {
    const response = await apiClient.request<EnableMessagingResponse>({
      method: "POST",
      url: `${BASE_PATH}/enable`,
      data: body,
    });
    return response.data;
  } catch (error) {
    throw toEnableError(error);
  }
}

/**
 * Axios config flag the shared 401 interceptor (`services/api.ts`) reads to
 * decide a request was already retried. Set up front on the ticket mint so
 * the interceptor does not refresh: `useMessagesEvents` owns that policy
 * (refresh once, retry, then sign out) and shares it with WS 4401 closes, so
 * a 401 never burns two refreshes.
 */
interface SkipInterceptorRefresh {
  _retry: true;
}

/**
 * `POST /events/ticket`: a single-use, ~30 s ticket for `WS /events`. Mint
 * one right before every (re)connect; a ticket is consumed by the first
 * connect that presents it. A 401 rejects with `unauthorized` (no refresh
 * here, see above).
 */
export function createMessagesEventsTicket(): Promise<MessagesEventsTicket> {
  const config: AxiosRequestConfig & SkipInterceptorRefresh = {
    method: "POST",
    url: `${BASE_PATH}/events/ticket`,
    _retry: true,
  };
  return request<MessagesEventsTicket>(config);
}

/**
 * Websocket URL for `WS /v1/messages/events?ticket=` (§4.2). The session JWT
 * never goes in the URL, where proxy and access logs would keep it.
 */
export function messagesEventsUrl(baseUrl: string, ticket: string): string {
  const wsBase = baseUrl.replace(/^http/, "ws");
  return `${wsBase}${BASE_PATH}/events?ticket=${encodeURIComponent(ticket)}`;
}
