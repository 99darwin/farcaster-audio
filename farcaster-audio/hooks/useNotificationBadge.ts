import { useEffect, useCallback } from "react";
import { AppState } from "react-native";
import { useAuthStore } from "@/stores/authStore";
import { useNotificationStore } from "@/stores/notificationStore";
import * as api from "@/services/api";
import { getLastSeenNotificationTimestamp } from "@/services/storage";
import type { NeynarNotification } from "@/types/neynar";

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

const BADGE_REFETCH_THROTTLE_MS = 60_000;

export function useNotificationBadge() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const setNotifications = useNotificationStore((s) => s.setNotifications);

  const fetchBadge = useCallback(async () => {
    try {
      const data = await api.getNotifications({ limit: 5 });
      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      const existing = useNotificationStore.getState().notifications;
      if (existing.length === 0) {
        setNotifications(data.notifications, data.next?.cursor ?? null);
      }
      setUnreadCount(unread);
    } catch {
      // Silently fail — badge is non-critical
    }
  }, [setUnreadCount, setNotifications]);

  useEffect(() => {
    if (!isAuthenticated) return;

    fetchBadge();

    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const lastFetchedAt = useNotificationStore.getState().lastFetchedAt;
      if (
        lastFetchedAt &&
        Date.now() - lastFetchedAt <= BADGE_REFETCH_THROTTLE_MS
      )
        return;
      fetchBadge();
    });

    return () => subscription.remove();
  }, [isAuthenticated, fetchBadge]);
}
