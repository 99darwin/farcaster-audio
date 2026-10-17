import { useCallback, useMemo, useState } from "react";
import { useAuthStore } from "@/stores/authStore";
import {
  getChannelFeed,
  getErrorMessage,
  publishCastToChannel,
  bookmarkCast,
  removeBookmark,
  blockUser,
} from "@/services/api";
import {
  likeCast,
  recastCast,
  removeLike,
  removeRecast,
} from "@/services/feed";
import type { FarcasterCast } from "@/types/farcaster";
import {
  appendUniqueCasts,
  removeCastsByAuthor,
  updateCastBookmark,
  updateCastReaction,
} from "@/utils/castUpdates";
import type { FeedItem } from "@/types/voiceNote";

export function useChannelFeed(channelId: string) {
  const user = useAuthStore((s) => s.user);
  const [casts, setCasts] = useState<FarcasterCast[]>([]);
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
    if (!user || !channelId) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await getChannelFeed(channelId, { limit: 25 });
      setCasts(data.casts);
      setCursor(data.next.cursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [channelId, user]);

  const refresh = useCallback(async () => {
    if (!user || !channelId) return;
    setIsRefreshing(true);
    setError(null);
    try {
      const data = await getChannelFeed(channelId, { limit: 25 });
      setCasts(data.casts);
      setCursor(data.next.cursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsRefreshing(false);
    }
  }, [channelId, user]);

  const fetchMore = useCallback(async () => {
    if (!user || !channelId || isLoading || !cursor) return;
    setIsLoading(true);
    try {
      const data = await getChannelFeed(channelId, { limit: 25, cursor });
      setCasts((prev) => appendUniqueCasts(prev, data.casts));
      setCursor(data.next.cursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [channelId, cursor, isLoading, user]);

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

  const handleBlockAuthor = useCallback(
    async (fid: number) => {
      if (!user || fid === user.fid) return;
      setCasts((prev) => removeCastsByAuthor(prev, fid));
      try {
        await blockUser(fid);
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh, user],
  );

  const handlePublishCast = useCallback(
    async (
      text: string,
      parentHash?: string,
      imageUris?: string[],
      quote?: { fid: number; hash: string },
      selectedChannelId?: string,
    ): Promise<{ hash: string } | void> => {
      const result = await publishCastToChannel({
        text,
        parent: parentHash,
        embeds: imageUris && imageUris.length > 0 ? imageUris : undefined,
        quote,
        channel_id: parentHash ? undefined : selectedChannelId,
      });
      await refresh();
      return result.hash ? { hash: result.hash } : undefined;
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
    handleBlockAuthor,
    handlePublishCast,
  };
}
