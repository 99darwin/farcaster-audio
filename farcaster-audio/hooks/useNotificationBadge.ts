import { useEffect, useCallback, useRef } from "react";
import { AppState } from "react-native";
import { useAuthStore } from "@/stores/authStore";
import { useNotificationStore } from "@/stores/notificationStore";
import * as api from "@/services/api";
import { getLastSeenNotificationTimestamp } from "@/services/storage";
import type { FarcasterNotification } from "@/types/farcaster";

function computeUnreadCount(
  notifications: FarcasterNotification[],
  lastSeenTimestamp: string | null,
): number {
  if (!lastSeenTimestamp) return notifications.length;
  const lastSeen = new Date(lastSeenTimestamp).getTime();
  if (!Number.isFinite(lastSeen)) return notifications.length;
  return notifications.filter(
    (n) => new Date(n.most_recent_timestamp).getTime() > lastSeen,
  ).length;
}

const BADGE_REFETCH_THROTTLE_MS = 60_000;

export function useNotificationBadge() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const setNotifications = useNotificationStore((s) => s.setNotifications);
  const fetchInFlightRef = useRef(false);
  const lastBadgeFetchAtRef = useRef<number | null>(null);

  const fetchBadge = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    lastBadgeFetchAtRef.current = Date.now();
    try {
      // One full first page is enough to produce an exact count below the
      // visual 20+ cap, while avoiding pagination just for a badge.
      const data = await api.getNotifications({ limit: 25 });
      const lastSeen = await getLastSeenNotificationTimestamp();
      const unread = computeUnreadCount(data.notifications, lastSeen);
      const existing = useNotificationStore.getState().notifications;
      if (existing.length === 0) {
        setNotifications(data.notifications, data.next?.cursor ?? null);
      }
      setUnreadCount(unread);
    } catch {
      // Silently fail — badge is non-critical
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [setUnreadCount, setNotifications]);

  useEffect(() => {
    if (!isAuthenticated) {
      setUnreadCount(0);
      return;
    }

    fetchBadge();

    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const storeFetchedAt = useNotificationStore.getState().lastFetchedAt;
      const lastFetchedAt = Math.max(
        storeFetchedAt ?? 0,
        lastBadgeFetchAtRef.current ?? 0,
      );
      if (
        lastFetchedAt &&
        Date.now() - lastFetchedAt <= BADGE_REFETCH_THROTTLE_MS
      )
        return;
      fetchBadge();
    });

    return () => subscription.remove();
  }, [isAuthenticated, fetchBadge, setUnreadCount]);
}
