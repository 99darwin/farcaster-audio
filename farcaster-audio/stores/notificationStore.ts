import { create } from "zustand";
import type { NeynarNotification } from "@/types/neynar";

interface NotificationStore {
  notifications: NeynarNotification[];
  cursor: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  error: string | null;
  unreadCount: number;
  lastFetchedAt: number | null;

  // Actions
  setNotifications: (
    notifications: NeynarNotification[],
    cursor: string | null,
  ) => void;
  appendNotifications: (
    notifications: NeynarNotification[],
    cursor: string | null,
  ) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setError: (error: string | null) => void;
  setUnreadCount: (count: number) => void;
  markAllRead: () => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  cursor: null,
  isLoading: false,
  isRefreshing: false,
  hasMore: true,
  error: null,
  unreadCount: 0,
  lastFetchedAt: null,

  setNotifications: (notifications, cursor) =>
    set({
      notifications,
      cursor,
      hasMore: cursor !== null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      lastFetchedAt: Date.now(),
    }),

  appendNotifications: (newNotifications, cursor) =>
    set((state) => ({
      notifications: [...state.notifications, ...newNotifications],
      cursor,
      hasMore: cursor !== null,
      isLoading: false,
      error: null,
    })),

  setLoading: (isLoading) => set({ isLoading }),
  setRefreshing: (isRefreshing) => set({ isRefreshing }),
  setError: (error) => set({ error, isLoading: false, isRefreshing: false }),
  setUnreadCount: (unreadCount) => set({ unreadCount }),
  markAllRead: () => set({ unreadCount: 0 }),
  reset: () =>
    set({
      notifications: [],
      cursor: null,
      isLoading: false,
      isRefreshing: false,
      hasMore: true,
      error: null,
      unreadCount: 0,
      lastFetchedAt: null,
    }),
}));
