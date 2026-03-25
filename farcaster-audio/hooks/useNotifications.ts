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
    (n) => new Date(n.timestamp).getTime() > lastSeen,
  ).length;
}

export function useNotifications() {
  const store = useNotificationStore();
  const user = useAuthStore((s) => s.user);

  const fetch = useCallback(async () => {
    if (!user) return;
    store.setLoading(true);
    try {
      const data = await api.getNotifications({ limit: 25 });
      store.setNotifications(data.notifications, data.next.cursor);

      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      store.setUnreadCount(unread);
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Failed to fetch notifications');
    }
  }, [user, store]);

  const fetchMore = useCallback(async () => {
    if (!user || !store.hasMore || store.isLoading || !store.cursor) return;
    store.setLoading(true);
    try {
      const data = await api.getNotifications({ limit: 25, cursor: store.cursor });
      store.appendNotifications(data.notifications, data.next.cursor);
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Failed to load more');
    }
  }, [user, store]);

  const refresh = useCallback(async () => {
    if (!user) return;
    store.setRefreshing(true);
    try {
      const data = await api.getNotifications({ limit: 25 });
      store.setNotifications(data.notifications, data.next.cursor);

      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      store.setUnreadCount(unread);
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Failed to refresh');
    }
  }, [user, store]);

  const markAsRead = useCallback(async () => {
    if (store.notifications.length === 0) return;
    const latestTimestamp = store.notifications[0]?.timestamp;
    if (latestTimestamp) {
      await saveLastSeenNotificationTimestamp(latestTimestamp);
    }
    store.markAllRead();
  }, [store]);

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
    notifications: store.notifications,
    isLoading: store.isLoading,
    isRefreshing: store.isRefreshing,
    hasMore: store.hasMore,
    error: store.error,
    unreadCount: store.unreadCount,
    fetch,
    fetchMore,
    refresh,
    markAsRead,
    handleLike,
  };
}
