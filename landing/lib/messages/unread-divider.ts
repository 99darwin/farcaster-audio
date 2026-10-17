/**
 * Where the "New messages" divider goes when a thread opens.
 *
 * The divider sits after the message that precedes the oldest unread one.
 * `unread_count` says how many incoming messages are unread; when that is more
 * than the loaded page holds, the caller loads older pages (bounded by
 * {@link MAX_UNREAD_DIVIDER_PAGES}) until the target is loaded, and failing
 * that anchors on the conversation's `last_read_at` (ms epoch) instead.
 */

import type { Message } from "@/lib/api/messages.types";

/** Older pages loaded on open to reach the oldest unread message. */
export const MAX_UNREAD_DIVIDER_PAGES = 5;

export type UnreadDividerResolution =
  /** `afterId` null means no divider (nothing unread, or everything is). */
  | { kind: "found"; afterId: string | null }
  /** The target is older than what is loaded; load an older page and retry. */
  | { kind: "load_older" };

export interface UnreadDividerInput {
  /** Thread messages, oldest first. */
  messages: readonly Message[];
  unreadCount: number;
  viewerFid: number | null;
  /** Conversation `last_read_at` (ms epoch, 0 = never). */
  lastReadAt: number;
  /** More older pages exist on the server. */
  hasOlder: boolean;
  /** Older pages already loaded for the divider. */
  pagesLoaded: number;
  maxPages?: number;
}

function isIncoming(message: Message, viewerFid: number | null): boolean {
  return message.sender.fid !== viewerFid;
}

/** Divider anchored by count; null when the loaded page is too short. */
function afterIdByCount(
  messages: readonly Message[],
  unreadCount: number,
  viewerFid: number | null,
): { index: number } | null {
  let remaining = unreadCount;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isIncoming(messages[i], viewerFid)) remaining -= 1;
    if (remaining === 0) return { index: i };
  }
  return null;
}

/**
 * Divider anchored on `last_read_at`: before the oldest loaded incoming
 * message sent after it. Null without a usable timestamp.
 */
export function afterIdByLastRead(
  messages: readonly Message[],
  lastReadAt: number,
  viewerFid: number | null,
): string | null {
  if (!(lastReadAt > 0)) return null;
  const index = messages.findIndex((m) => isIncoming(m, viewerFid) && m.sent_at > lastReadAt);
  return index > 0 ? messages[index - 1].message_id : null;
}

export function resolveUnreadDivider({
  messages,
  unreadCount,
  viewerFid,
  lastReadAt,
  hasOlder,
  pagesLoaded,
  maxPages = MAX_UNREAD_DIVIDER_PAGES,
}: UnreadDividerInput): UnreadDividerResolution {
  if (unreadCount <= 0) return { kind: "found", afterId: null };
  const canLoadOlder = hasOlder && pagesLoaded < maxPages;

  const byCount = afterIdByCount(messages, unreadCount, viewerFid);
  if (byCount) {
    if (byCount.index > 0) return { kind: "found", afterId: messages[byCount.index - 1].message_id };
    // The oldest unread is the oldest loaded: the divider needs the message
    // before it, which is only there if older history exists.
    if (canLoadOlder) return { kind: "load_older" };
    return { kind: "found", afterId: hasOlder ? afterIdByLastRead(messages, lastReadAt, viewerFid) : null };
  }

  if (canLoadOlder) return { kind: "load_older" };
  // Out of history (or over the page budget): fall back on the read timestamp.
  return { kind: "found", afterId: afterIdByLastRead(messages, lastReadAt, viewerFid) };
}
