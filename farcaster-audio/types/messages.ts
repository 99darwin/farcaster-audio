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
/** SendMessageRequest.text max length, enforced by the backend schema. */
export const MAX_MESSAGE_LENGTH = 2000;
