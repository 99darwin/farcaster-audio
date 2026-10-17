/**
 * Pure operations on a conversation's message list.
 *
 * The store keeps each conversation's loaded messages ascending by `sent_at`
 * (oldest first, the order they render) and deduped by `message_id`. The
 * backend's page order is not part of the contract, so everything here is
 * order-agnostic on input.
 */

import type {
  Message,
  MessageReactionSummary,
  MessageUser,
} from "@/lib/api/messages.types";

/** Ascending by `sent_at`, then `message_id` for a stable total order. */
export function compareMessages(a: Message, b: Message): number {
  if (a.sent_at !== b.sent_at) return a.sent_at - b.sent_at;
  return a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0;
}

/**
 * Merge `incoming` into `existing`, deduping by `message_id`. A server copy
 * always replaces a local optimistic one (it drops `send_state`); a local
 * optimistic copy never replaces a server one. Returns `existing` unchanged
 * (same reference) when nothing changed, so selectors can bail out.
 */
export function mergeMessages(
  existing: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  if (incoming.length === 0) return existing as Message[];
  const byId = new Map<string, Message>();
  for (const message of existing) byId.set(message.message_id, message);

  let changed = false;
  for (const message of incoming) {
    const current = byId.get(message.message_id);
    if (current === message) continue;
    if (current && !current.send_state && message.send_state) continue;
    if (current && isSameMessage(current, message)) continue;
    byId.set(message.message_id, message);
    changed = true;
  }
  if (!changed) return existing as Message[];
  return Array.from(byId.values()).sort(compareMessages);
}

/**
 * Shallow equality on the fields that change after send (reactions, deletion,
 * pin, read marker). Avoids churning renders on identical poll results.
 */
function isSameMessage(a: Message, b: Message): boolean {
  return (
    a.sent_at === b.sent_at &&
    a.text === b.text &&
    a.is_deleted === b.is_deleted &&
    a.is_pinned === b.is_pinned &&
    a.is_last_read === b.is_last_read &&
    a.send_state === b.send_state &&
    sameReactions(a.reactions, b.reactions)
  );
}

function sameReactions(
  a: readonly MessageReactionSummary[],
  b: readonly MessageReactionSummary[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (reaction, i) =>
      reaction.reaction === b[i].reaction &&
      reaction.count === b[i].count &&
      reaction.viewer_reacted === b[i].viewer_reacted,
  );
}

/** Replace one message by id. Returns the same array when not found. */
export function updateMessage(
  messages: readonly Message[],
  messageId: string,
  update: (message: Message) => Message,
): Message[] {
  const index = messages.findIndex((m) => m.message_id === messageId);
  if (index === -1) return messages as Message[];
  const next = messages.slice();
  next[index] = update(messages[index]);
  return next;
}

/** Remove one message by id (e.g. discarding a failed optimistic send). */
export function removeMessage(
  messages: readonly Message[],
  messageId: string,
): Message[] {
  const next = messages.filter((m) => m.message_id !== messageId);
  return next.length === messages.length ? (messages as Message[]) : next;
}

/**
 * Toggle the viewer's `reaction` on a message summary list. Adds a chip when
 * the first reaction lands and drops it when the count reaches zero.
 */
export function toggleReaction(
  reactions: readonly MessageReactionSummary[],
  reaction: string,
  add: boolean,
): MessageReactionSummary[] {
  const index = reactions.findIndex((r) => r.reaction === reaction);
  if (index === -1) {
    if (!add) return reactions as MessageReactionSummary[];
    return [...reactions, { reaction, count: 1, viewer_reacted: true }];
  }
  const current = reactions[index];
  if (current.viewer_reacted === add) return reactions as MessageReactionSummary[];
  const count = Math.max(0, current.count + (add ? 1 : -1));
  if (count === 0) return reactions.filter((_, i) => i !== index);
  const next = reactions.slice();
  next[index] = { ...current, count, viewer_reacted: add };
  return next;
}

export interface OptimisticMessageInput {
  messageId: string;
  conversationId: string;
  sender: MessageUser;
  text: string;
  sentAt: number;
  replyTo: Message | null;
}

/** The local placeholder rendered while a send is in flight. */
export function buildOptimisticMessage({
  messageId,
  conversationId,
  sender,
  text,
  sentAt,
  replyTo,
}: OptimisticMessageInput): Message {
  return {
    message_id: messageId,
    conversation_id: conversationId,
    sender,
    type: "text",
    text,
    sent_at: sentAt,
    reactions: [],
    in_reply_to: replyTo
      ? {
          message_id: replyTo.message_id,
          sender: replyTo.sender,
          text: replyTo.text,
          is_deleted: replyTo.is_deleted,
        }
      : null,
    metadata: null,
    is_deleted: false,
    is_pinned: false,
    is_last_read: false,
    send_state: "sending",
  };
}

/** Number of messages after `lastSeenId` that weren't sent by `viewerFid`. */
export function countIncomingAfter(
  messages: readonly Message[],
  lastSeenId: string | null,
  viewerFid: number | null,
): number {
  if (!lastSeenId) return 0;
  const index = messages.findIndex((m) => m.message_id === lastSeenId);
  if (index === -1) return 0;
  let count = 0;
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i].sender.fid !== viewerFid) count += 1;
  }
  return count;
}

/**
 * Two pages overlap when they share any message. A jump-to-message page that
 * doesn't overlap what's loaded can't be merged without a hole in the list.
 */
export function pagesOverlap(
  loaded: readonly Message[],
  page: readonly Message[],
): boolean {
  if (loaded.length === 0 || page.length === 0) return false;
  const ids = new Set(loaded.map((m) => m.message_id));
  return page.some((m) => ids.has(m.message_id));
}

/**
 * `sent_at` for a new optimistic message: now, but never at or before the
 * newest loaded message, so a skewed local clock can't sort a fresh send
 * above messages the server already stamped later.
 */
export function optimisticSentAt(messages: readonly Message[], now: number): number {
  const newest = messages.at(-1)?.sent_at;
  return newest === undefined ? now : Math.max(now, newest + 1);
}

/**
 * Sender fid of the minimal reply quote the send echo carries when the parent
 * wasn't in the server's cache (design doc 4.2, `PUT /send`): only
 * `message_id` is real, so the client keeps its own quote.
 */
const PLACEHOLDER_QUOTE_SENDER_FID = 0;

/**
 * The server echo of a send, merged onto the optimistic row it replaces. The
 * echo can omit the reply quote (upstream doesn't always hydrate it) or carry
 * only a placeholder (`sender.fid === 0`), so the optimistic quote is kept in
 * either case.
 */
export function mergeSendEcho(echo: Message, optimistic: Message | undefined): Message {
  const localQuote = optimistic?.in_reply_to;
  if (!localQuote) return echo;
  const isPlaceholder = echo.in_reply_to?.sender.fid === PLACEHOLDER_QUOTE_SENDER_FID;
  if (echo.in_reply_to && !isPlaceholder) return echo;
  return { ...echo, in_reply_to: localQuote };
}
