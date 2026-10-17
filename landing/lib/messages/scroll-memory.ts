/**
 * Per-conversation scroll position, kept for the session so switching
 * conversations and coming back lands where the user left off.
 */

import type { ScrollAnchor } from "@/lib/messages/windowing";

/** Conversations remembered before the least recently saved is dropped. */
const SCROLL_MEMORY_LIMIT = 50;

export type ScrollSnapshot =
  | { kind: "bottom" }
  | { kind: "anchor"; anchor: ScrollAnchor };

export interface ScrollMemory {
  save: (conversationId: string, snapshot: ScrollSnapshot) => void;
  recall: (conversationId: string) => ScrollSnapshot | null;
  forget: (conversationId: string) => void;
  clear: () => void;
}

export function createScrollMemory(limit = SCROLL_MEMORY_LIMIT): ScrollMemory {
  // Map iteration order is insertion order: re-inserting on save makes the
  // first key the least recently saved.
  const snapshots = new Map<string, ScrollSnapshot>();
  return {
    save: (conversationId, snapshot) => {
      snapshots.delete(conversationId);
      snapshots.set(conversationId, snapshot);
      while (snapshots.size > limit) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) break;
        snapshots.delete(oldest);
      }
    },
    recall: (conversationId) => snapshots.get(conversationId) ?? null,
    forget: (conversationId) => {
      snapshots.delete(conversationId);
    },
    clear: () => snapshots.clear(),
  };
}

/** Session-wide instance used by the thread view. */
export const threadScrollMemory = createScrollMemory();
