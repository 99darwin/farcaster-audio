/**
 * Debounced message search (design §4.4). Each keystroke cancels the
 * previous request; pages append through `loadMore`. Pass `conversationId`
 * for in-thread search: the server filters, so there is no client-side scan.
 *
 * Paging contract: a short or even empty page with a non-null `next_cursor`
 * does not end the results (the server filters after fetching upstream
 * pages), so each fetch keeps paging until it has at least one hit or the
 * cursor is exhausted. Only `next_cursor === null` means "no more".
 *
 * A cursor the server can no longer decode (`400 invalid_cursor`) is dropped
 * and the results reload from the first page, replacing what was shown.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessagesApiError,
  searchMessages,
  type MessagesErrorCode,
} from "@/services/messagesApi";
import { applyMessagesError } from "@/utils/messagesErrors";
import type { MessageSearchHit, Page } from "@/types/messages";

export const SEARCH_DEBOUNCE_MS = 250;
export const MIN_QUERY_LENGTH = 2;
/**
 * Guard against a server bug returning empty pages forever: stop one fetch
 * after this many consecutive empty pages and leave the cursor for loadMore.
 */
export const MAX_EMPTY_PAGES_PER_FETCH = 10;

export interface UseMessageSearchOptions {
  query: string;
  isEnabled: boolean;
  /** Restrict hits to one conversation (in-thread search). */
  conversationId?: string | null;
}

export interface UseMessageSearchResult {
  /** Relevance order, as the server returns them. */
  hits: MessageSearchHit[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  errorCode: MessagesErrorCode | null;
  loadMore: () => Promise<void>;
}

type FetchSearchPage = (cursor: string | null) => Promise<Page<MessageSearchHit>>;

/** Page from `startCursor` until a page has hits or the cursor runs out. */
export async function fetchUntilHits(
  fetchPage: FetchSearchPage,
  startCursor: string | null,
): Promise<{ items: MessageSearchHit[]; nextCursor: string | null }> {
  let cursor = startCursor;
  for (let emptyPages = 0; emptyPages < MAX_EMPTY_PAGES_PER_FETCH; emptyPages += 1) {
    const page = await fetchPage(cursor);
    cursor = page.next_cursor;
    if (page.items.length > 0 || cursor === null) {
      return { items: page.items, nextCursor: cursor };
    }
  }
  return { items: [], nextCursor: cursor };
}

function isInvalidCursorError(error: unknown): boolean {
  return error instanceof MessagesApiError && error.code === "invalid_cursor";
}

type FetchFrom = (
  startCursor: string | null,
) => Promise<{ items: MessageSearchHit[]; nextCursor: string | null }>;

/**
 * Continue from `cursor`; on `invalid_cursor` drop it and fetch from the
 * first page once. `isRestart` tells the caller to replace, not append.
 */
export async function fetchMoreOrRestart(
  fetchFrom: FetchFrom,
  cursor: string,
): Promise<{ items: MessageSearchHit[]; nextCursor: string | null; isRestart: boolean }> {
  try {
    return { ...(await fetchFrom(cursor)), isRestart: false };
  } catch (error) {
    if (!isInvalidCursorError(error)) throw error;
    return { ...(await fetchFrom(null)), isRestart: true };
  }
}

export function appendUniqueHits(
  previous: MessageSearchHit[],
  incoming: MessageSearchHit[],
): MessageSearchHit[] {
  const seen = new Set(previous.map((h) => h.message.message_id));
  const fresh = incoming.filter((h) => {
    if (seen.has(h.message.message_id)) return false;
    seen.add(h.message.message_id);
    return true;
  });
  return fresh.length > 0 ? [...previous, ...fresh] : previous;
}

export function useMessageSearch({
  query,
  isEnabled,
  conversationId = null,
}: UseMessageSearchOptions): UseMessageSearchResult {
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errorCode, setErrorCode] = useState<MessagesErrorCode | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const trimmed = query.trim();

  const fetchFrom = useCallback(
    (startCursor: string | null, signal: AbortSignal) =>
      fetchUntilHits(
        (pageCursor) =>
          searchMessages(
            trimmed,
            { conversationId, cursor: pageCursor },
            { signal },
          ),
        startCursor,
      ),
    [conversationId, trimmed],
  );

  useEffect(() => {
    controllerRef.current?.abort();
    setHits([]);
    setCursor(null);
    setErrorCode(null);
    if (!isEnabled || trimmed.length < MIN_QUERY_LENGTH) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    const timer = setTimeout(() => {
      fetchFrom(null, controller.signal)
        .then(({ items, nextCursor }) => {
          if (controller.signal.aborted) return;
          setHits(appendUniqueHits([], items));
          setCursor(nextCursor);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const code = applyMessagesError(error);
          if (code) setErrorCode(code);
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchFrom, isEnabled, trimmed]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoadingMore || isLoading) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoadingMore(true);
    try {
      const { items, nextCursor, isRestart } = await fetchMoreOrRestart(
        (startCursor) => fetchFrom(startCursor, controller.signal),
        cursor,
      );
      if (controller.signal.aborted) return;
      setHits((previous) => appendUniqueHits(isRestart ? [] : previous, items));
      setCursor(nextCursor);
    } catch (error) {
      if (!controller.signal.aborted) applyMessagesError(error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [cursor, fetchFrom, isLoading, isLoadingMore]);

  return {
    hits,
    isLoading,
    isLoadingMore,
    hasMore: cursor !== null,
    errorCode,
    loadMore,
  };
}
