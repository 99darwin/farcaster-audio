"use client";

/**
 * Home — the authenticated merged timeline.
 *
 * Mirrors mobile `app/(tabs)/index.tsx` + `hooks/useFeed.ts`: a live-spaces
 * rail header over an infinite-scroll `FeedList` of Farcaster casts with voice
 * notes interleaved every ~4 casts. Like/recast/bookmark are optimistic (mutate
 * the store first, fire the API, revert on failure). Reply routes to compose.
 *
 * Keyboard navigation: j/k move focus, Enter opens thread, l/r/t/b trigger
 * the matching action. Voice-note rows are traversable but actions are no-ops.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { LiveSpacesStrip } from "@/components/live-spaces-strip";
import { NativeSpacesRail } from "@/components/native/NativeSpacesRail";
import { VoiceNoteFeedItem } from "@/components/voice-note-feed-item";
import { InlineComposer } from "@/app/app/_components/InlineComposer";
import { CastCard } from "@/components/ui/cast-card";
import { FeedList } from "@/components/ui/feed-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useFeedStore } from "@/lib/stores/feedStore";
import { useVoiceNoteStore } from "@/lib/stores/voiceNoteStore";
import {
  useComposeStore,
  OPTIMISTIC_REPLY_WINDOW_MS,
} from "@/lib/stores/composeStore";
import { useCastListNavigation } from "@/lib/keyboard/useCastListNavigation";
import {
  getFollowingFeed,
  getVoiceNoteFeed,
  likeCast,
  removeLike,
  recastCast,
  removeRecast,
  bookmarkCast,
  removeBookmark,
  deleteCast,
} from "@/lib/api/feed";
import type { Cast } from "@/lib/api/types";
import type { VoiceNoteDetail } from "@/lib/voice-notes";

type FeedItem =
  | { type: "cast"; data: Cast }
  | { type: "voice_note"; data: VoiceNoteDetail };

const VOICE_NOTE_INTERVAL = 4; // Insert a voice note every N casts.

/** Interleave voice notes into the cast stream so they don't cluster. */
function mergeFeedItems(casts: Cast[], voiceNotes: VoiceNoteDetail[]): FeedItem[] {
  const castItems: FeedItem[] = casts.map((data) => ({ type: "cast", data }));
  if (voiceNotes.length === 0) return castItems;
  const vnItems: FeedItem[] = voiceNotes.map((data) => ({
    type: "voice_note",
    data,
  }));
  if (castItems.length === 0) return vnItems;

  const merged: FeedItem[] = [];
  let vnIdx = 0;
  for (let i = 0; i < castItems.length; i++) {
    merged.push(castItems[i]);
    if ((i + 1) % VOICE_NOTE_INTERVAL === 0 && vnIdx < vnItems.length) {
      merged.push(vnItems[vnIdx++]);
    }
  }
  while (vnIdx < vnItems.length) merged.push(vnItems[vnIdx++]);
  return merged;
}

export default function HomePage() {
  const { user, status } = useAuth();
  const router = useRouter();

  const openCompose = useComposeStore((s) => s.openCompose);
  const lastPublished = useComposeStore((s) => s.lastPublished);

  const casts = useFeedStore((s) => s.casts);
  const loading = useFeedStore((s) => s.loading);
  const refreshing = useFeedStore((s) => s.refreshing);
  const hasMore = useFeedStore((s) => s.hasMore);
  const error = useFeedStore((s) => s.error);
  const refreshRequestedAt = useFeedStore((s) => s.refreshRequestedAt);
  const voiceNotes = useVoiceNoteStore((s) => s.voiceNotes);

  // Redirect unauthenticated visitors to the connect screen.
  useEffect(() => {
    if (status === "anonymous") router.replace("/app/login");
  }, [status, router]);

  const loadFeed = useCallback(async () => {
    const feedStore = useFeedStore.getState();
    const vnStore = useVoiceNoteStore.getState();
    feedStore.setLoading(true);
    vnStore.setLoading(true);
    try {
      const [feed, vn] = await Promise.all([
        getFollowingFeed(),
        // Voice notes are non-critical — an empty list must never block casts.
        getVoiceNoteFeed().catch(() => ({ voice_notes: [], next_cursor: null })),
      ]);
      feedStore.setCasts(feed.casts, feed.cursor);
      vnStore.setVoiceNotes(vn.voice_notes, vn.next_cursor);
    } catch (err) {
      feedStore.setError(
        err instanceof Error ? err.message : "Failed to load your feed",
      );
    }
  }, []);

  // Refresh = reload page-1 without blanking the current feed. Uses the
  // `refreshing` flag (not `loading`) so the list stays rendered and is
  // replaced only once the new page resolves.
  const refreshFeed = useCallback(async () => {
    const feedStore = useFeedStore.getState();
    const vnStore = useVoiceNoteStore.getState();
    feedStore.setRefreshing(true);
    try {
      const [feed, vn] = await Promise.all([
        getFollowingFeed(),
        getVoiceNoteFeed().catch(() => ({ voice_notes: [], next_cursor: null })),
      ]);
      feedStore.setCasts(feed.casts, feed.cursor);
      vnStore.setVoiceNotes(vn.voice_notes, vn.next_cursor);
    } catch (err) {
      feedStore.setError(
        err instanceof Error ? err.message : "Failed to refresh your feed",
      );
    }
  }, []);

  const loadMore = useCallback(async () => {
    const feedStore = useFeedStore.getState();
    if (!feedStore.hasMore || feedStore.loading || !feedStore.cursor) return;
    feedStore.setLoading(true);
    try {
      const feed = await getFollowingFeed(feedStore.cursor);
      feedStore.appendCasts(feed.casts, feed.cursor);
    } catch (err) {
      feedStore.setError(
        err instanceof Error ? err.message : "Failed to load more",
      );
    }
  }, []);

  // Load once we have an authenticated user.
  const didLoad = useRef(false);
  useEffect(() => {
    if (status !== "authenticated" || didLoad.current) return;
    didLoad.current = true;
    void loadFeed();
  }, [status, loadFeed]);

  const handleLike = useCallback((cast: Cast) => {
    const store = useFeedStore.getState();
    const wasLiked = cast.reactions.viewer_liked;
    if (wasLiked) store.removeLike(cast.hash);
    else store.like(cast.hash);
    const call = wasLiked ? removeLike : likeCast;
    call(cast.hash).catch(() => {
      // Revert on failure.
      if (wasLiked) store.like(cast.hash);
      else store.removeLike(cast.hash);
    });
  }, []);

  const handleRecast = useCallback((cast: Cast) => {
    const store = useFeedStore.getState();
    const wasRecasted = cast.reactions.viewer_recasted;
    if (wasRecasted) store.removeRecast(cast.hash);
    else store.recast(cast.hash);
    const call = wasRecasted ? removeRecast : recastCast;
    call(cast.hash).catch(() => {
      if (wasRecasted) store.recast(cast.hash);
      else store.removeRecast(cast.hash);
    });
  }, []);

  const handleBookmark = useCallback((cast: Cast) => {
    const store = useFeedStore.getState();
    const wasBookmarked = cast.viewer_bookmarked ?? false;
    store.bookmark(cast.hash, !wasBookmarked);
    const call = wasBookmarked ? removeBookmark : bookmarkCast;
    call(cast.hash).catch(() => store.bookmark(cast.hash, wasBookmarked));
  }, []);

  // Reply opens Stream I's composer in reply mode, anchored to this cast.
  const handleReply = useCallback(
    (cast: Cast) => {
      openCompose({ mode: "reply", target: { hash: cast.hash, author: cast.author } });
    },
    [openCompose],
  );

  const handlePress = useCallback(
    (cast: Cast) => {
      router.push(`/app/cast/${cast.hash}`);
    },
    [router],
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

  const handleDelete = useCallback(
    (cast: Cast) => {
      const store = useFeedStore.getState();
      // Capture position for potential rollback.
      const priorCasts = store.casts;
      // Optimistically remove.
      store.removeCast(cast.hash);
      deleteCast(cast.hash).catch(() => {
        // Revert: restore the prior cast list.
        useFeedStore.setState({ casts: priorCasts });
      });
    },
    [],
  );

  const items = useMemo(
    () => mergeFeedItems(casts, voiceNotes),
    [casts, voiceNotes],
  );

  // Keyboard navigation — maps j/k/Enter/l/r/t/b onto the feed's optimistic
  // handlers. Voice-note rows are traversable (getCast → null) but their
  // per-cast actions are no-ops. `.` refreshes through the same store signal
  // the Home nav button uses, so both entry points share one code path.
  const getCast = useCallback(
    (item: FeedItem): Cast | null => (item.type === "cast" ? item.data : null),
    [],
  );
  const { focusedIndex, setFocusedIndex, getRowProps } = useCastListNavigation({
    items,
    getCast,
    onOpen: (cast) => router.push(`/app/cast/${cast.hash}`),
    onLike: handleLike,
    onReply: handleReply,
    onRecast: handleRecast,
    onBookmark: handleBookmark,
    onRefresh: () => useFeedStore.getState().requestRefresh(),
  });

  // Home-nav / `r`-at-rest refresh: reload page-1, scroll to top, reset focus.
  // Skips the initial mount value (0) via the last-handled ref so it never
  // double-loads alongside the mount-time `loadFeed`.
  const lastHandledRefresh = useRef(refreshRequestedAt);
  useEffect(() => {
    if (refreshRequestedAt === lastHandledRefresh.current) return;
    lastHandledRefresh.current = refreshRequestedAt;
    window.scrollTo({ top: 0, behavior: "smooth" });
    setFocusedIndex(-1);
    void refreshFeed();
  }, [refreshRequestedAt, refreshFeed, setFocusedIndex]);

  // Instant parity for the shared compose modal:
  //   "reply" → bump the target cast's reply count in the feed (no-ops if the
  //              target isn't currently visible).
  //   "cast"  → prepend the new cast to the top of the feed (hash dedup in
  //              prependCast prevents duplicates when the feed later refreshes).
  // Both paths reuse the same freshness-window + last-handled ref so a stale
  // event on mount never re-applies.
  const lastHandledPublish = useRef(0);
  useEffect(() => {
    if (!lastPublished) return;
    if (lastPublished.at <= lastHandledPublish.current) return;
    if (Date.now() - lastPublished.at > OPTIMISTIC_REPLY_WINDOW_MS) return;

    if (lastPublished.mode === "reply") {
      const targetHash = lastPublished.target?.hash;
      if (!targetHash) return;
      lastHandledPublish.current = lastPublished.at;
      useFeedStore.getState().incrementReplies(targetHash);
    } else if (lastPublished.mode === "cast") {
      lastHandledPublish.current = lastPublished.at;
      useFeedStore.getState().prependCast(lastPublished.cast);
    }
  }, [lastPublished]);

  const getKey = useCallback(
    (item: FeedItem) =>
      item.type === "cast"
        ? `cast:${item.data.hash}`
        : `vn:${item.data.voice_note.id}`,
    [],
  );

  const renderItem = useCallback(
    (item: FeedItem, index: number) => (
      <div {...getRowProps(index)}>
        {item.type === "cast" ? (
          <CastCard
            cast={item.data}
            focused={index === focusedIndex}
            onLike={handleLike}
            onRecast={handleRecast}
            onBookmark={handleBookmark}
            onReply={handleReply}
            onPress={handlePress}
            onQuote={handleQuote}
            onDelete={
              user?.fid === item.data.author.fid ? handleDelete : undefined
            }
          />
        ) : (
          <VoiceNoteFeedItem item={item.data} />
        )}
      </div>
    ),
    [
      focusedIndex,
      getRowProps,
      handleLike,
      handleRecast,
      handleBookmark,
      handleReply,
      handlePress,
      handleQuote,
      handleDelete,
      user?.fid,
    ],
  );

  // Auth still resolving, or bouncing an anonymous visitor.
  if (status === "loading" || status === "anonymous") {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  const isInitialLoad = loading && items.length === 0;

  return (
    <div>
      {/* At xl+ these strips are replaced by the persistent RightRail panel.
          Both components share the same discovery store, so hiding them here
          causes no refetch — the store remains populated by the panel. */}
      <div className="xl:hidden">
        <LiveSpacesStrip />
        <NativeSpacesRail />
      </div>

      <InlineComposer />

      {error && items.length === 0 ? (
        <EmptyState
          title="Couldn't load your feed"
          description={error}
          action={
            <Button
              onClick={() => {
                useFeedStore.getState().setError(null);
                void loadFeed();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : isInitialLoad ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Refresh-error banner: shown above the feed when a background
              refresh fails but casts are already rendered. Dismissing clears
              the error from the store so it never re-surfaces stale. */}
          {error && (
            <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              <span className="flex-1">{error}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={() => useFeedStore.getState().setError(null)}
                className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
              >
                ×
              </button>
            </div>
          )}
          <FeedList
            items={items}
            renderItem={renderItem}
            getKey={getKey}
            onLoadMore={loadMore}
            hasMore={hasMore}
            loading={loading || refreshing}
            emptyState={
              <EmptyState
                title="Your feed is quiet"
                description={
                  user
                    ? "Follow more people on Farcaster to fill your timeline, or start a space."
                    : "Sign in to see casts and voice notes from people you follow."
                }
              />
            }
          />
        </>
      )}
    </div>
  );
}
