/**
 * Pure helpers for in-thread search: the stepper walks hits newest first and
 * tracks the active hit by id so paging never moves it.
 */

import type { MessageSearchHit } from "@/types/messages";

/** Search hits newest first, the order the in-thread stepper walks. */
export function sortHitsByTime(hits: MessageSearchHit[]): MessageSearchHit[] {
  return [...hits].sort((a, b) => b.message.sent_at - a.message.sent_at);
}

/**
 * Next active hit after the hit list changes: keep the current one while it
 * is still present (paging must not move the cursor), else the newest hit.
 */
export function resolveActiveHitId(
  activeHitId: string | null,
  sortedHits: MessageSearchHit[],
): string | null {
  if (activeHitId && sortedHits.some((h) => h.message.message_id === activeHitId)) {
    return activeHitId;
  }
  return sortedHits[0]?.message.message_id ?? null;
}

/** Highlight terms for in-thread search: server terms, else query words. */
export function threadSearchTerms(hits: MessageSearchHit[], query: string): string[] {
  const serverTerms = new Set(hits.flatMap((h) => h.matched_terms ?? []));
  if (serverTerms.size > 0) return [...serverTerms];
  return query.trim().split(/\s+/).filter(Boolean);
}
