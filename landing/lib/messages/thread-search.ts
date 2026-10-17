/**
 * In-thread search over `GET /search?conversation_id=` (design doc 4.5).
 * The server filters to the conversation, so the client pages until
 * `next_cursor` is null; a short or empty page with a cursor means "keep
 * paging", not "done".
 */

import { isInvalidCursorError } from "@/lib/api/messages";
import type { MessageSearchHit } from "@/lib/api/messages.types";

/**
 * Cap on remote pages per query. Each page is an upstream Direct Cast search
 * call, so a broad term in a long thread stops here; loaded messages still
 * match locally, and a longer query narrows the server results.
 */
export const MAX_THREAD_SEARCH_PAGES = 10;
/** Server search runs only from this many (trimmed) characters. */
export const MIN_REMOTE_QUERY_LENGTH = 3;

/** True when `query` is long enough to search the server. */
export function shouldSearchRemotely(query: string): boolean {
  return query.trim().length >= MIN_REMOTE_QUERY_LENGTH;
}

export interface SearchPage {
  items: MessageSearchHit[];
  next_cursor: string | null;
}

export type FetchSearchPage = (cursor: string | null) => Promise<SearchPage>;

/**
 * Fetch every page, reporting the hits so far after each one. Stops early when
 * `isCancelled()` turns true. Errors propagate; hits already reported stay.
 * A stale cursor (400 `invalid_cursor`) restarts from the first page once;
 * hits are deduped by message id, so the restart only adds what was missed.
 */
export async function collectThreadSearchHits(
  fetchPage: FetchSearchPage,
  {
    onProgress,
    isCancelled = () => false,
    maxPages = MAX_THREAD_SEARCH_PAGES,
  }: {
    onProgress: (hits: MessageSearchHit[]) => void;
    isCancelled?: () => boolean;
    maxPages?: number;
  },
): Promise<MessageSearchHit[]> {
  const byId = new Map<string, MessageSearchHit>();
  let cursor: string | null = null;
  let hasRestarted = false;
  for (let page = 0; page < maxPages; page += 1) {
    let result: SearchPage;
    try {
      result = await fetchPage(cursor);
    } catch (error) {
      if (cursor === null || hasRestarted || !isInvalidCursorError(error)) throw error;
      if (isCancelled()) break;
      hasRestarted = true;
      cursor = null;
      continue;
    }
    if (isCancelled()) break;
    for (const hit of result.items) byId.set(hit.message.message_id, hit);
    onProgress([...byId.values()]);
    if (result.next_cursor === null || result.next_cursor === cursor) break;
    cursor = result.next_cursor;
  }
  return [...byId.values()];
}
