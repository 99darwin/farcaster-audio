import { useCallback } from 'react';
import { useFeedStore } from '@/stores/feedStore';
import { useAuthStore } from '@/stores/authStore';
import { fetchFollowingFeed, likeCast, recastCast, removeLike, removeRecast, publishCast } from '@/services/neynar';

export function useFeed() {
  const { casts, isLoading, isRefreshing, hasMore, error, cursor } = useFeedStore();
  const { setCasts, appendCasts, setLoading, setRefreshing, setError, updateCastReaction } = useFeedStore();
  const user = useAuthStore((s) => s.user);

  const fetch = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await fetchFollowingFeed(user.fid);
      setCasts(data.casts, data.next.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch feed');
    }
  }, [user, setCasts, setLoading, setError]);

  const fetchMore = useCallback(async () => {
    if (!user || !hasMore || isLoading || !cursor) return;
    setLoading(true);
    try {
      const data = await fetchFollowingFeed(user.fid, 25, cursor);
      appendCasts(data.casts, data.next.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    }
  }, [user, hasMore, isLoading, cursor, appendCasts, setLoading, setError]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const data = await fetchFollowingFeed(user.fid);
      setCasts(data.casts, data.next.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh feed');
    }
  }, [user, setCasts, setRefreshing, setError]);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      if (!user) return;
      updateCastReaction(castHash, 'like', !isLiked, user.fid);
      try {
        if (isLiked) {
          await removeLike(castHash);
        } else {
          await likeCast(castHash);
        }
      } catch {
        updateCastReaction(castHash, 'like', isLiked, user.fid);
      }
    },
    [user, updateCastReaction],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      if (!user) return;
      updateCastReaction(castHash, 'recast', !isRecasted, user.fid);
      try {
        if (isRecasted) {
          await removeRecast(castHash);
        } else {
          await recastCast(castHash);
        }
      } catch {
        updateCastReaction(castHash, 'recast', isRecasted, user.fid);
      }
    },
    [user, updateCastReaction],
  );

  const handlePublishCast = useCallback(
    async (text: string, parentHash?: string) => {
      await publishCast(text, parentHash);
      await refresh();
    },
    [refresh],
  );

  return {
    casts,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    fetch,
    fetchMore,
    refresh,
    handleLike,
    handleRecast,
    handlePublishCast,
  };
}
