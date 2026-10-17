"use client";

/**
 * Notifications store for the Juke web app.
 *
 * Ported from mobile `stores/notificationStore.ts` + `hooks/useNotifications.ts`,
 * collapsed into a single client-only zustand store. Holds the paginated
 * notification feed and derives an `unreadCount` from `lastSeenTs` (the
 * timestamp of the most-recent notification the user has viewed).
 *
 * `lastSeenTs` is persisted to localStorage via zustand's `persist` middleware
 * so the unread badge survives reloads. Only `lastSeenTs` is persisted — the
 * feed itself is always re-fetched. SSR renders defaults, so consumers that
 * would flicker should gate on `hasHydrated` (see {@link useNotificationsHydrated}).
 *
 * The header badge reads `unreadCount` via:
 *   const unreadCount = useNotificationStore((s) => s.unreadCount);
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  getNotifications,
  type Notification,
  type NotificationCast,
} from "@/lib/api/notifications";

type ReactionKind = "like" | "recast";

/** Count notifications newer than the last-seen timestamp. */
function computeUnreadCount(
  notifications: Notification[],
  lastSeenTs: string | null,
): number {
  if (!lastSeenTs) return notifications.length;
  const seenMs = new Date(lastSeenTs).getTime();
  return notifications.filter(
    (n) => new Date(n.most_recent_timestamp).getTime() > seenMs,
  ).length;
}

/**
 * Optimistically set the viewer's like/recast state on a raw notification cast,
 * adjusting the visible count. Returns the same reference when already in the
 * requested state so React can bail out of re-rendering unrelated rows.
 */
function withCastReaction(
  cast: NotificationCast,
  kind: ReactionKind,
  value: boolean,
): NotificationCast {
  const viewer = cast.viewer_context ?? {};
  const reactions = cast.reactions ?? {};
  if (kind === "like") {
    if ((viewer.liked ?? false) === value) return cast;
    return {
      ...cast,
      viewer_context: { ...viewer, liked: value },
      reactions: {
        ...reactions,
        likes_count: Math.max(0, (reactions.likes_count ?? 0) + (value ? 1 : -1)),
      },
    };
  }
  if ((viewer.recasted ?? false) === value) return cast;
  return {
    ...cast,
    viewer_context: { ...viewer, recasted: value },
    reactions: {
      ...reactions,
      recasts_count: Math.max(
        0,
        (reactions.recasts_count ?? 0) + (value ? 1 : -1),
      ),
    },
  };
}

/** Optimistically set the viewer's bookmark state on a raw notification cast. */
function withCastBookmark(
  cast: NotificationCast,
  value: boolean,
): NotificationCast {
  const viewer = cast.viewer_context ?? {};
  if ((viewer.bookmarked ?? false) === value) return cast;
  return { ...cast, viewer_context: { ...viewer, bookmarked: value } };
}

/**
 * Apply `transform` to every notification whose attached cast matches `hash`.
 * Aggregate like/recast notifications carry the viewer's own cast, and
 * reply/mention/quote notifications carry the actor's cast — either is matched
 * by hash, so a single cast can be updated wherever it appears in the feed.
 */
function mapCastByHash(
  notifications: Notification[],
  hash: string,
  transform: (cast: NotificationCast) => NotificationCast,
): Notification[] {
  let changed = false;
  const next = notifications.map((notification) => {
    if (!notification.cast || notification.cast.hash !== hash) return notification;
    const updatedCast = transform(notification.cast);
    if (updatedCast === notification.cast) return notification;
    changed = true;
    return { ...notification, cast: updatedCast };
  });
  return changed ? next : notifications;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export interface NotificationState {
  notifications: Notification[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Notifications newer than `lastSeenTs`. Drives the header badge. */
  unreadCount: number;
  /** ISO timestamp of the newest notification the user has seen. */
  lastSeenTs: string | null;
  /** True once persisted state has rehydrated from localStorage. */
  hasHydrated: boolean;

  /** Initial fetch. No-op if a load is already in flight. */
  load: () => Promise<void>;
  /** Append the next page. No-op without a cursor / when loading. */
  loadMore: () => Promise<void>;
  /** Pull-to-refresh: replace the feed with a fresh first page. */
  refresh: () => Promise<void>;
  /** Mark everything currently loaded as seen (advances `lastSeenTs`). */
  markSeen: () => void;
  /**
   * Optimistically toggle a like/recast on the notification cast(s) with this
   * hash. Callers fire the API and call again with the prior value on failure.
   */
  setCastReaction: (hash: string, kind: ReactionKind, value: boolean) => void;
  /** Optimistically toggle the viewer bookmark on the cast(s) with this hash. */
  setCastBookmark: (hash: string, value: boolean) => void;
  setHasHydrated: (value: boolean) => void;
}

const STORAGE_KEY = "juke-notifications";

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      notifications: [],
      cursor: null,
      hasMore: true,
      loading: false,
      refreshing: false,
      error: null,
      unreadCount: 0,
      lastSeenTs: null,
      hasHydrated: false,

      load: async () => {
        if (get().loading) return;
        set({ loading: true, error: null });
        try {
          const data = await getNotifications();
          const { notifications } = data;
          set({
            notifications,
            cursor: data.next.cursor,
            hasMore: data.next.cursor !== null,
            loading: false,
            unreadCount: computeUnreadCount(notifications, get().lastSeenTs),
          });
        } catch (err) {
          set({
            loading: false,
            error: errorMessage(err, "Failed to load notifications"),
          });
        }
      },

      loadMore: async () => {
        const { loading, hasMore, cursor } = get();
        if (loading || !hasMore || !cursor) return;
        set({ loading: true, error: null });
        try {
          const data = await getNotifications(cursor);
          const notifications = [...get().notifications, ...data.notifications];
          set({
            notifications,
            cursor: data.next.cursor,
            hasMore: data.next.cursor !== null,
            loading: false,
            unreadCount: computeUnreadCount(notifications, get().lastSeenTs),
          });
        } catch (err) {
          set({
            loading: false,
            error: errorMessage(err, "Failed to load more notifications"),
          });
        }
      },

      refresh: async () => {
        if (get().refreshing) return;
        set({ refreshing: true, error: null });
        try {
          const data = await getNotifications();
          const { notifications } = data;
          set({
            notifications,
            cursor: data.next.cursor,
            hasMore: data.next.cursor !== null,
            refreshing: false,
            unreadCount: computeUnreadCount(notifications, get().lastSeenTs),
          });
        } catch (err) {
          set({
            refreshing: false,
            error: errorMessage(err, "Failed to refresh notifications"),
          });
        }
      },

      markSeen: () => {
        const { notifications, lastSeenTs, unreadCount } = get();
        const latest = notifications[0]?.most_recent_timestamp;
        if (!latest) return;
        // Never move `lastSeenTs` backwards.
        const isAlreadySeen =
          lastSeenTs !== null &&
          new Date(latest).getTime() <= new Date(lastSeenTs).getTime();
        if (isAlreadySeen) {
          if (unreadCount !== 0) set({ unreadCount: 0 });
          return;
        }
        set({ lastSeenTs: latest, unreadCount: 0 });
      },

      setCastReaction: (hash, kind, value) => {
        const notifications = mapCastByHash(get().notifications, hash, (cast) =>
          withCastReaction(cast, kind, value),
        );
        if (notifications !== get().notifications) set({ notifications });
      },

      setCastBookmark: (hash, value) => {
        const notifications = mapCastByHash(get().notifications, hash, (cast) =>
          withCastBookmark(cast, value),
        );
        if (notifications !== get().notifications) set({ notifications });
      },

      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    }),
    {
      name: STORAGE_KEY,
      // Only the last-seen marker is durable; the feed is always re-fetched.
      partialize: (state) => ({ lastSeenTs: state.lastSeenTs }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

/** Gate persisted reads (e.g. the badge) until localStorage has rehydrated. */
export function useNotificationsHydrated(): boolean {
  return useNotificationStore((state) => state.hasHydrated);
}
