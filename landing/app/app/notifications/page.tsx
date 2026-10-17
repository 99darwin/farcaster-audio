"use client";

/**
 * Notifications feed for the Juke web app (`/app/notifications`).
 *
 * Mirrors the mobile `app/(tabs)/notifications.tsx`: every cast-bearing
 * notification (reply, mention, quote, and likes/recasts of your own cast)
 * renders the full interactive {@link CastCard} so like/recast/reply/bookmark/
 * quote and open-thread all work straight from the feed. `follows` rows show
 * the reactor stack and profile links only. Like/recast/bookmark are optimistic
 * (mutate the store first, fire the API, revert on failure); reply/quote open
 * the shared composer. Infinite scroll via {@link FeedList}. Everything loaded
 * is marked seen once the feed renders, zeroing the header unread badge.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedList } from "@/components/ui/feed-list";
import { Spinner } from "@/components/ui/spinner";
import {
  NotificationRow,
  castHref,
  resolveNotificationCast,
} from "@/components/notifications/NotificationRow";
import { useCastListNavigation } from "@/lib/keyboard/useCastListNavigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useComposeStore } from "@/lib/stores/composeStore";
import { useNotificationStore } from "@/lib/stores/notificationStore";
import {
  likeCast,
  unlikeCast,
  recastCast,
  unrecastCast,
  bookmarkCast,
  unbookmarkCast,
} from "@/lib/api/users";
import type { Notification } from "@/lib/api/notifications";
import type { Cast } from "@/lib/api/types";

function keyFor(notification: Notification, index: number): string {
  return `${notification.type}-${notification.most_recent_timestamp}-${index}`;
}

export default function NotificationsPage() {
  const { status } = useAuth();
  const router = useRouter();
  const notifications = useNotificationStore((s) => s.notifications);
  const loading = useNotificationStore((s) => s.loading);
  const hasMore = useNotificationStore((s) => s.hasMore);
  const error = useNotificationStore((s) => s.error);
  const load = useNotificationStore((s) => s.load);
  const loadMore = useNotificationStore((s) => s.loadMore);
  const markSeen = useNotificationStore((s) => s.markSeen);
  const openCompose = useComposeStore((s) => s.openCompose);

  const isAuthed = status === "authenticated";

  // Initial load once authenticated.
  useEffect(() => {
    if (isAuthed) void load();
  }, [isAuthed, load]);

  // Mark everything loaded as seen whenever the feed changes while viewing.
  const newestTs = notifications[0]?.most_recent_timestamp;
  useEffect(() => {
    if (newestTs) markSeen();
  }, [newestTs, markSeen]);

  // Optimistic like/recast/bookmark: flip store state, fire API, revert on fail.
  const handleLike = useCallback((cast: Cast) => {
    const store = useNotificationStore.getState();
    const wasLiked = cast.reactions.viewer_liked ?? false;
    store.setCastReaction(cast.hash, "like", !wasLiked);
    const call = wasLiked ? unlikeCast : likeCast;
    call(cast.hash).catch(() => {
      store.setCastReaction(cast.hash, "like", wasLiked);
    });
  }, []);

  const handleRecast = useCallback((cast: Cast) => {
    const store = useNotificationStore.getState();
    const wasRecasted = cast.reactions.viewer_recasted ?? false;
    store.setCastReaction(cast.hash, "recast", !wasRecasted);
    const call = wasRecasted ? unrecastCast : recastCast;
    call(cast.hash).catch(() => {
      store.setCastReaction(cast.hash, "recast", wasRecasted);
    });
  }, []);

  const handleBookmark = useCallback((cast: Cast) => {
    const store = useNotificationStore.getState();
    const wasBookmarked = cast.viewer_bookmarked ?? false;
    store.setCastBookmark(cast.hash, !wasBookmarked);
    const call = wasBookmarked ? unbookmarkCast : bookmarkCast;
    call(cast.hash).catch(() => {
      store.setCastBookmark(cast.hash, wasBookmarked);
    });
  }, []);

  const handleReply = useCallback(
    (cast: Cast) => {
      openCompose({
        mode: "reply",
        target: { hash: cast.hash, author: cast.author },
      });
    },
    [openCompose],
  );

  const handleQuote = useCallback(
    (cast: Cast) => {
      openCompose({
        mode: "quote",
        target: { hash: cast.hash, author: cast.author },
      });
    },
    [openCompose],
  );

  // Enter opens the notification's thread — matches NotificationRow's own
  // onPress by routing through the shared castHref (thread + focus), reusing the
  // raw NotificationCast located by hash.
  const openThread = useCallback(
    (cast: Cast) => {
      const raw = notifications.find((n) => n.cast?.hash === cast.hash)?.cast;
      router.push(raw ? castHref(raw) : `/app/cast/${cast.hash}`);
    },
    [notifications, router],
  );

  // Feed keyboard navigation over cast-bearing rows: j/k move focus, Enter
  // opens the thread, l/r/t/b act on the notification's cast. Follows and
  // spam-collapsed rows carry no cast (resolveNotificationCast → null), so
  // their actions no-op while j/k still traverse them.
  const { focusedIndex, getRowProps } = useCastListNavigation({
    items: notifications,
    getCast: resolveNotificationCast,
    onOpen: openThread,
    onLike: handleLike,
    onReply: handleReply,
    onRecast: handleRecast,
    onBookmark: handleBookmark,
  });

  const emptyState = useMemo(
    () => (
      <EmptyState
        title="No notifications yet"
        description="Likes, recasts, replies, and follows will show up here."
      />
    ),
    [],
  );

  if (status === "loading") {
    return (
      <main className="flex min-h-[50vh] items-center justify-center">
        <Spinner size="lg" />
      </main>
    );
  }

  if (!isAuthed) {
    return (
      <main className="mx-auto w-full max-w-2xl">
        <EmptyState
          title="Sign in to see your notifications"
          description="Connect Farcaster to view likes, recasts, replies, and follows."
        />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl">
      <header className="sticky top-0 z-10 border-b border-juke-border bg-juke-navy/80 px-4 py-3 backdrop-blur">
        <h1 className="text-lg font-semibold text-juke-text-on-dark">
          Notifications
        </h1>
      </header>

      {error && notifications.length === 0 ? (
        <EmptyState title="Couldn't load notifications" description={error} />
      ) : (
        <FeedList<Notification>
          items={notifications}
          getKey={keyFor}
          onLoadMore={loadMore}
          hasMore={hasMore}
          loading={loading}
          emptyState={emptyState}
          renderItem={(notification, index) => (
            <div {...getRowProps(index)}>
              <NotificationRow
                notification={notification}
                focused={index === focusedIndex}
                onLike={handleLike}
                onRecast={handleRecast}
                onReply={handleReply}
                onBookmark={handleBookmark}
                onQuote={handleQuote}
              />
            </div>
          )}
        />
      )}
    </main>
  );
}
