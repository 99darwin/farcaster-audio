import { useCallback } from "react";
import { useNotificationStore } from "@/stores/notificationStore";
import { useAuthStore } from "@/stores/authStore";
import * as api from "@/services/api";
import {
  likeCast,
  recastCast,
  removeLike,
  removeRecast,
  publishCast,
} from "@/services/neynar";
import { saveLastSeenNotificationTimestamp } from "@/services/storage";

export function useNotifications() {
  // Select stable action references individually — avoids re-render loops
  const notifications = useNotificationStore((s) => s.notifications);
  const isLoading = useNotificationStore((s) => s.isLoading);
  const isRefreshing = useNotificationStore((s) => s.isRefreshing);
  const hasMore = useNotificationStore((s) => s.hasMore);
  const cursor = useNotificationStore((s) => s.cursor);
  const error = useNotificationStore((s) => s.error);
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  const setNotifications = useNotificationStore((s) => s.setNotifications);
  const appendNotifications = useNotificationStore(
    (s) => s.appendNotifications,
  );
  const setLoading = useNotificationStore((s) => s.setLoading);
  const setRefreshing = useNotificationStore((s) => s.setRefreshing);
  const setError = useNotificationStore((s) => s.setError);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const updateCastReaction = useNotificationStore((s) => s.updateCastReaction);

  const user = useAuthStore((s) => s.user);

  const fetch = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await api.getNotifications({ limit: 25 });
      setNotifications(data.notifications, data.next.cursor);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch notifications",
      );
    }
  }, [user, setLoading, setNotifications, setError]);

  const fetchMore = useCallback(async () => {
    if (!user || !hasMore || isLoading || !cursor) return;
    setLoading(true);
    try {
      const data = await api.getNotifications({ limit: 25, cursor });
      appendNotifications(data.notifications, data.next.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    }
  }, [
    user,
    hasMore,
    isLoading,
    cursor,
    setLoading,
    appendNotifications,
    setError,
  ]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const data = await api.getNotifications({ limit: 25 });
      setNotifications(data.notifications, data.next.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh");
    }
  }, [user, setRefreshing, setNotifications, setError]);

  const markAsRead = useCallback(() => {
    const current = useNotificationStore.getState().notifications;
    if (current.length === 0) return;
    const latestTimestamp = current[0]?.most_recent_timestamp;
    if (latestTimestamp) {
      saveLastSeenNotificationTimestamp(latestTimestamp);
    }
    markAllRead();
  }, [markAllRead]);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      if (!user) return;
      updateCastReaction(castHash, "like", !isLiked, user.fid);
      try {
        if (isLiked) {
          await removeLike(castHash);
        } else {
          await likeCast(castHash);
        }
      } catch {
        updateCastReaction(castHash, "like", isLiked, user.fid);
      }
    },
    [user, updateCastReaction],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      if (!user) return;
      updateCastReaction(castHash, "recast", !isRecasted, user.fid);
      try {
        if (isRecasted) {
          await removeRecast(castHash);
        } else {
          await recastCast(castHash);
        }
      } catch {
        updateCastReaction(castHash, "recast", isRecasted, user.fid);
      }
    },
    [user, updateCastReaction],
  );

  const handlePublishCast = useCallback(
    async (
      text: string,
      parentHash?: string,
      imageUris?: string[],
      quote?: { fid: number; hash: string },
    ) => {
      await publishCast(
        text,
        parentHash,
        imageUris && imageUris.length > 0 ? imageUris : undefined,
        quote,
      );
    },
    [],
  );

  return {
    notifications,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    unreadCount,
    fetch,
    fetchMore,
    refresh,
    markAsRead,
    handleLike,
    handleRecast,
    handlePublishCast,
  };
}
