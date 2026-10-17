import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/stores/authStore";
import {
  bookmarkCast,
  getErrorMessage,
  removeBookmark,
  searchCasts,
} from "@/services/api";
import {
  likeCast,
  publishCast,
  recastCast,
  removeLike,
  removeRecast,
} from "@/services/feed";
import type { FarcasterCast } from "@/types/farcaster";
import { updateCastBookmark, updateCastReaction } from "@/utils/castUpdates";
import type { CastSearchMeta } from "@/types/api";
import type { FeedItem } from "@/types/voiceNote";

type CastSort = "popular" | "recent";

interface UseSearchCastsOptions {
  /** When false, the hook will not auto-fetch on (query, sort) change. */
  enabled?: boolean;
}

/**
 * Hook owning the casts result list for the global search screen.
 * Mirrors the shape of `useBookmarks` so the Casts tab can reuse FeedList directly.
 *
 * Empty query → no fetches, `items` stays empty.
 */
export function useSearchCasts(
  query: string,
  sort: CastSort,
  options: UseSearchCastsOptions = {},
) {
  const { enabled = true } = options;
  const user = useAuthStore((s) => s.user);
  const [casts, setCasts] = useState<FarcasterCast[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [meta, setMeta] = useState<CastSearchMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Abort the previous in-flight request when (query, sort) changes so a slow
  // response from a stale keystroke can't overwrite fresh results.
  const abortRef = useRef<AbortController | null>(null);
  const queryRef = useRef(query);
  const sortRef = useRef(sort);
  queryRef.current = query;
  sortRef.current = sort;

  const hasMore = cursor !== null;
  const items = useMemo<FeedItem[]>(
    () => casts.map((cast) => ({ type: "cast", data: cast })),
    [casts],
  );

  const fetch = useCallback(async () => {
    const q = query.trim();
    if (!user) return;
    if (!q) {
      abortRef.current?.abort();
      abortRef.current = null;
      setCasts([]);
      setCursor(null);
      setMeta(null);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    try {
      const data = await searchCasts(q, sort, undefined, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setCasts(data.casts);
      setCursor(data.next.cursor);
      setMeta(data.meta);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }, [query, sort, user]);

  const refresh = useCallback(async () => {
    const q = query.trim();
    if (!user || !q) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRefreshing(true);
    setError(null);
    try {
      const data = await searchCasts(q, sort, undefined, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setCasts(data.casts);
      setCursor(data.next.cursor);
      setMeta(data.meta);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      if (!controller.signal.aborted) setIsRefreshing(false);
    }
  }, [query, sort, user]);

  const fetchMore = useCallback(async () => {
    const q = query.trim();
    if (!user || isLoading || !cursor || !q) return;
    setIsLoading(true);
    try {
      const data = await searchCasts(q, sort, cursor);
      // Only commit if query/sort hasn't changed during the request.
      if (queryRef.current !== query || sortRef.current !== sort) return;
      setCasts((prev) => [...prev, ...data.casts]);
      setCursor(data.next.cursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [cursor, isLoading, query, sort, user]);

  // Auto-fetch when (query, sort) changes — only when explicitly enabled.
  // Empty query is a no-op inside `fetch`. Debounce to coalesce keystrokes.
  useEffect(() => {
    if (!enabled) return;
    const handle = setTimeout(() => {
      fetch();
    }, 250);
    return () => clearTimeout(handle);
  }, [enabled, fetch]);

  // Abort any in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      if (!user) return;
      setCasts((prev) =>
        updateCastReaction(prev, {
          hash: castHash,
          type: "like",
          added: !isLiked,
          myFid: user.fid,
        }),
      );
      try {
        if (isLiked) await removeLike(castHash);
        else await likeCast(castHash);
      } catch {
        setCasts((prev) =>
          updateCastReaction(prev, {
          hash: castHash,
          type: "like",
          added: isLiked,
          myFid: user.fid,
        }),
        );
      }
    },
    [user],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      if (!user) return;
      setCasts((prev) =>
        updateCastReaction(prev, {
          hash: castHash,
          type: "recast",
          added: !isRecasted,
          myFid: user.fid,
        }),
      );
      try {
        if (isRecasted) await removeRecast(castHash);
        else await recastCast(castHash);
      } catch {
        setCasts((prev) =>
          updateCastReaction(prev, {
          hash: castHash,
          type: "recast",
          added: isRecasted,
          myFid: user.fid,
        }),
        );
      }
    },
    [user],
  );

  const handleBookmark = useCallback(
    async (castHash: string, isBookmarked: boolean) => {
      setCasts((prev) => updateCastBookmark(prev, castHash, !isBookmarked));
      try {
        if (isBookmarked) await removeBookmark(castHash);
        else await bookmarkCast(castHash);
      } catch {
        setCasts((prev) => updateCastBookmark(prev, castHash, isBookmarked));
      }
    },
    [],
  );

  const handlePublishCast = useCallback(
    async (
      text: string,
      parentHash?: string,
      imageUris?: string[],
      quote?: { fid: number; hash: string },
    ): Promise<{ hash: string } | void> => {
      const result = await publishCast(
        text,
        parentHash,
        imageUris && imageUris.length > 0 ? imageUris : undefined,
        quote,
      );
      return result;
    },
    [],
  );

  return {
    casts,
    items,
    meta,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    fetch,
    fetchMore,
    refresh,
    handleLike,
    handleRecast,
    handleBookmark,
    handlePublishCast,
  };
}
