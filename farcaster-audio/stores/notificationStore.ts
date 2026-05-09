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
  updateCastReaction: (
    hash: string,
    type: "like" | "recast",
    added: boolean,
    myFid: number,
  ) => void;
  updateCastBookmark: (hash: string, bookmarked: boolean) => void;
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

  updateCastReaction: (hash, type, added, myFid) =>
    set((state) => ({
      notifications: state.notifications.map((n) => {
        if (n.cast?.hash !== hash) return n;
        const cast = n.cast;
        const reactions = { ...cast.reactions };
        const viewerContext = {
          liked: false,
          recasted: false,
          ...cast.viewer_context,
        };
        if (type === "like") {
          reactions.likes_count = added
            ? reactions.likes_count + 1
            : Math.max(0, reactions.likes_count - 1);
          reactions.likes = added
            ? [...reactions.likes, { fid: myFid }]
            : reactions.likes.filter((l) => l.fid !== myFid);
          viewerContext.liked = added;
        } else {
          reactions.recasts_count = added
            ? reactions.recasts_count + 1
            : Math.max(0, reactions.recasts_count - 1);
          reactions.recasts = added
            ? [...reactions.recasts, { fid: myFid }]
            : reactions.recasts.filter((r) => r.fid !== myFid);
          viewerContext.recasted = added;
        }
        return {
          ...n,
          cast: { ...cast, reactions, viewer_context: viewerContext },
        };
      }),
    })),

  updateCastBookmark: (hash, bookmarked) =>
    set((state) => ({
      notifications: state.notifications.map((n) => {
        if (n.cast?.hash !== hash) return n;
        const cast = n.cast;
        return {
          ...n,
          cast: {
            ...cast,
            viewer_context: {
              liked: false,
              recasted: false,
              ...cast.viewer_context,
              bookmarked,
            },
          },
        };
      }),
    })),

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
