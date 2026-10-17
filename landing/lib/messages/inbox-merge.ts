/**
 * Merging an inbox refresh (page 1) into an inbox the user has already paged
 * through. Replacing the list with page 1 would drop every conversation the
 * user scrolled to; keeping everything would resurrect conversations that left
 * page 1 (accepted requests, archived chats).
 */

import type { Conversation } from "@/lib/api/messages.types";

export interface InboxIdsState {
  ids: readonly string[];
  cursor: string | null;
  hasMore: boolean;
}

/** Recency key the inbox is ordered by (after pinned conversations). */
export function inboxActivityAt(conversation: Conversation): number {
  return conversation.last_message?.sent_at ?? conversation.created_at;
}

/**
 * Apply a fresh first page. Existing ids strictly older than page 1's oldest
 * unpinned conversation are kept as the tail (with the existing cursor, which
 * already points past them); anything inside page 1's range that the page no
 * longer lists is dropped. A final page (no `nextCursor`) is authoritative.
 */
export function mergeInboxRefresh({
  existing,
  pageIds,
  nextCursor,
  conversations,
}: {
  existing: InboxIdsState;
  pageIds: readonly string[];
  nextCursor: string | null;
  conversations: Readonly<Record<string, Conversation>>;
}): InboxIdsState {
  const fresh: InboxIdsState = { ids: pageIds, cursor: nextCursor, hasMore: nextCursor !== null };
  if (nextCursor === null) return fresh;

  const unpinned = pageIds
    .map((id) => conversations[id])
    .filter((conversation): conversation is Conversation => Boolean(conversation && !conversation.pinned));
  if (unpinned.length === 0) return fresh;
  const boundary = Math.min(...unpinned.map(inboxActivityAt));

  const onPage = new Set(pageIds);
  const tail = existing.ids.filter((id) => {
    if (onPage.has(id)) return false;
    const conversation = conversations[id];
    return Boolean(conversation && !conversation.pinned && inboxActivityAt(conversation) < boundary);
  });
  if (tail.length === 0) return fresh;
  return { ids: [...pageIds, ...tail], cursor: existing.cursor, hasMore: existing.hasMore };
}
