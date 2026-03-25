import { useCallback } from 'react';
import { useNotificationStore } from '@/stores/notificationStore';
import { useAuthStore } from '@/stores/authStore';
import * as api from '@/services/api';
import { likeCast, removeLike } from '@/services/neynar';
import {
  getLastSeenNotificationTimestamp,
  saveLastSeenNotificationTimestamp,
} from '@/services/storage';
import type { NeynarNotification } from '@/types/neynar';

function computeUnreadCount(
  notifications: NeynarNotification[],
  lastSeenTimestamp: string | null,
): number {
  if (!lastSeenTimestamp) return notifications.length;
  const lastSeen = new Date(lastSeenTimestamp).getTime();
  return notifications.filter(
    (n) => new Date(n.most_recent_timestamp).getTime() > lastSeen,
  ).length;
}

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
  const appendNotifications = useNotificationStore((s) => s.appendNotifications);
  const setLoading = useNotificationStore((s) => s.setLoading);
  const setRefreshing = useNotificationStore((s) => s.setRefreshing);
  const setError = useNotificationStore((s) => s.setError);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const markAllRead = useNotificationStore((s) => s.markAllRead);

  const user = useAuthStore((s) => s.user);

  const fetch = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await api.getNotifications({ limit: 25 });
      setNotifications(data.notifications, data.next.cursor);

      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      setUnreadCount(unread);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch notifications');
    }
  }, [user, setLoading, setNotifications, setUnreadCount, setError]);

  const fetchMore = useCallback(async () => {
    if (!user || !hasMore || isLoading || !cursor) return;
    setLoading(true);
    try {
      const data = await api.getNotifications({ limit: 25, cursor });
      appendNotifications(data.notifications, data.next.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    }
  }, [user, hasMore, isLoading, cursor, setLoading, appendNotifications, setError]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const data = await api.getNotifications({ limit: 25 });
      setNotifications(data.notifications, data.next.cursor);

      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      setUnreadCount(unread);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh');
    }
  }, [user, setRefreshing, setNotifications, setUnreadCount, setError]);

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
      try {
        if (isLiked) {
          await removeLike(castHash);
        } else {
          await likeCast(castHash);
        }
      } catch {
        // Silently fail — notification list doesn't need optimistic updates
      }
    },
    [user],
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
  };
}
