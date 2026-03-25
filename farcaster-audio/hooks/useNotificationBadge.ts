import { useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';
import * as api from '@/services/api';
import { getLastSeenNotificationTimestamp } from '@/services/storage';
import type { NeynarNotification } from '@/types/neynar';

const POLL_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;

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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failureCount = useRef(0);

  const startPolling = useCallback((pollFn: () => Promise<void>) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    failureCount.current = 0;
    intervalRef.current = setInterval(pollFn, POLL_INTERVAL_MS);
  }, []);

  const poll = useCallback(async () => {
    try {
      const data = await api.getNotifications({ limit: 25 });
      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      setUnreadCount(unread);
      failureCount.current = 0;
    } catch {
      failureCount.current += 1;
      if (failureCount.current >= MAX_CONSECUTIVE_FAILURES && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [setUnreadCount]);

  useEffect(() => {
    if (!isAuthenticated) return;

    poll();
    startPolling(poll);

    // Resume polling when app returns to foreground
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !intervalRef.current) {
        poll();
        startPolling(poll);
      }
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      subscription.remove();
    };
  }, [isAuthenticated, poll, startPolling]);
}
