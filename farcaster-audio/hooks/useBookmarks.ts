import { useCallback, useMemo, useState } from "react";
import { useAuthStore } from "@/stores/authStore";
import {
  getBookmarkedCasts,
  getErrorMessage,
  bookmarkCast,
  removeBookmark,
} from "@/services/api";
import {
  likeCast,
  recastCast,
  removeLike,
  removeRecast,
  publishCast,
} from "@/services/neynar";
import type { NeynarCast } from "@/types/neynar";
import type { FeedItem } from "@/types/voiceNote";

function updateReaction(
  casts: NeynarCast[],
  hash: string,
  type: "like" | "recast",
  added: boolean,
  myFid: number,
): NeynarCast[] {
  return casts.map((cast) => {
    if (cast.hash !== hash) return cast;
    const reactions = { ...cast.reactions };
    const viewerContext = {
      liked: false,
      recasted: false,
      ...cast.viewer_context,
    };

    if (type === "like") {
      reactions.likes_count = added
        ? reactions.likes_count + 1
        : Math.max(0, reactions.likes_count - 1);
      reactions.likes = added
        ? [...reactions.likes, { fid: myFid }]
        : reactions.likes.filter((l) => l.fid !== myFid);
      viewerContext.liked = added;
    } else {
      reactions.recasts_count = added
        ? reactions.recasts_count + 1
        : Math.max(0, reactions.recasts_count - 1);
      reactions.recasts = added
        ? [...reactions.recasts, { fid: myFid }]
        : reactions.recasts.filter((r) => r.fid !== myFid);
      viewerContext.recasted = added;
    }

    return { ...cast, reactions, viewer_context: viewerContext };
  });
}

function updateBookmark(
  casts: NeynarCast[],
  hash: string,
  bookmarked: boolean,
): NeynarCast[] {
  return casts.map((cast) =>
    cast.hash === hash
      ? {
          ...cast,
          viewer_context: {
            liked: false,
            recasted: false,
            ...cast.viewer_context,
            bookmarked,
          },
        }
      : cast,
  );
}

export function useBookmarks() {
  const user = useAuthStore((s) => s.user);
  const [casts, setCasts] = useState<NeynarCast[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasMore = cursor !== null;
  const items = useMemo<FeedItem[]>(
    () => casts.map((cast) => ({ type: "cast", data: cast })),
    [casts],
  );

  const fetch = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await getBookmarkedCasts({ limit: 25 });
      setCasts(data.casts);
      setCursor(data.next.cursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setIsRefreshing(true);
    setError(null);
    try {
      const data = await getBookmarkedCasts({ limit: 25 });
      setCasts(data.casts);
      setCursor(data.next.cursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsRefreshing(false);
    }
  }, [user]);

  const fetchMore = useCallback(async () => {
    if (!user || isLoading || !cursor) return;
    setIsLoading(true);
    try {
      const data = await getBookmarkedCasts({ limit: 25, cursor });
      setCasts((prev) => [...prev, ...data.casts]);
      setCursor(data.next.cursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [cursor, isLoading, user]);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      if (!user) return;
      setCasts((prev) =>
        updateReaction(prev, castHash, "like", !isLiked, user.fid),
      );
      try {
        if (isLiked) await removeLike(castHash);
        else await likeCast(castHash);
      } catch {
        setCasts((prev) =>
          updateReaction(prev, castHash, "like", isLiked, user.fid),
        );
      }
    },
    [user],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      if (!user) return;
      setCasts((prev) =>
        updateReaction(prev, castHash, "recast", !isRecasted, user.fid),
      );
      try {
        if (isRecasted) await removeRecast(castHash);
        else await recastCast(castHash);
      } catch {
        setCasts((prev) =>
          updateReaction(prev, castHash, "recast", isRecasted, user.fid),
        );
      }
    },
    [user],
  );

  const handleBookmark = useCallback(
    async (castHash: string, isBookmarked: boolean) => {
      if (isBookmarked) {
        let removedCast: NeynarCast | undefined;
        let removedIndex = -1;
        setCasts((prev) => {
          removedIndex = prev.findIndex((cast) => cast.hash === castHash);
          removedCast = removedIndex >= 0 ? prev[removedIndex] : undefined;
          return prev.filter((cast) => cast.hash !== castHash);
        });
        try {
          await removeBookmark(castHash);
        } catch {
          if (removedCast) {
            const restoredCast = removedCast;
            setCasts((prev) => {
              const next = [...prev];
              next.splice(Math.max(0, removedIndex), 0, restoredCast);
              return next;
            });
          }
        }
        return;
      }

      setCasts((prev) => updateBookmark(prev, castHash, true));
      try {
        await bookmarkCast(castHash);
      } catch {
        setCasts((prev) => updateBookmark(prev, castHash, false));
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
      await refresh();
      return result;
    },
    [refresh],
  );

  return {
    casts,
    items,
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
