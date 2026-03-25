import { useEffect, useCallback } from 'react';
import { AppState } from 'react-native';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';
import * as api from '@/services/api';
import { getLastSeenNotificationTimestamp } from '@/services/storage';
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

export function useNotificationBadge() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);

  const fetchBadge = useCallback(async () => {
    try {
      const data = await api.getNotifications({ limit: 25 });
      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      setUnreadCount(unread);
    } catch {
      // Silently fail — badge is non-critical
    }
  }, [setUnreadCount]);

  useEffect(() => {
    if (!isAuthenticated) return;

    // Fetch once on mount
    fetchBadge();

    // Re-fetch when app returns to foreground
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchBadge();
    });

    return () => subscription.remove();
  }, [isAuthenticated, fetchBadge]);
}
