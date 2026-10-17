"use client";

/**
 * Channel feed screen — mirrors mobile `app/channel/[id].tsx`.
 *
 * A channel header over an infinite-scroll `FeedList` of the channel's casts.
 * Reactions/bookmarks are wired optimistically; tapping a cast opens its thread.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedList } from "@/components/ui/feed-list";
import { Spinner } from "@/components/ui/spinner";
import { CastCard } from "@/components/ui/cast-card";
import {
  identityCast,
  useCastListNavigation,
} from "@/lib/keyboard/useCastListNavigation";
import { useComposeStore } from "@/lib/stores/composeStore";
import type { Cast } from "@/lib/api/types";
import {
  applyBookmark,
  applyReaction,
  bookmarkCast,
  getChannelFeed,
  likeCast,
  recastCast,
  unbookmarkCast,
  unlikeCast,
  unrecastCast,
} from "@/lib/api/users";

export default function ChannelPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const channelId = params.id;
  const openCompose = useComposeStore((s) => s.openCompose);

  const [casts, setCasts] = useState<Cast[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setCasts([]);
    setCursor(null);
    getChannelFeed(channelId)
      .then((page) => {
        if (!active) return;
        setCasts(page.casts);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (active) setError("This channel could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [channelId]);

  const loadMore = useCallback(() => {
    if (loading || !cursor) return;
    setLoading(true);
    getChannelFeed(channelId, cursor)
      .then((page) => {
        setCasts((prev) => [...prev, ...page.casts]);
        setCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channelId, cursor, loading]);

  const patchCast = useCallback((hash: string, fn: (c: Cast) => Cast) => {
    setCasts((prev) => prev.map((c) => (c.hash === hash ? fn(c) : c)));
  }, []);

  const handleLike = useCallback(
    (cast: Cast) => {
      const wasLiked = cast.reactions.viewer_liked;
      patchCast(cast.hash, (c) => applyReaction(c, "like"));
      (wasLiked ? unlikeCast(cast.hash) : likeCast(cast.hash)).catch(() =>
        patchCast(cast.hash, (c) => applyReaction(c, "like")),
      );
    },
    [patchCast],
  );

  const handleRecast = useCallback(
    (cast: Cast) => {
      const wasRecast = cast.reactions.viewer_recasted;
      patchCast(cast.hash, (c) => applyReaction(c, "recast"));
      (wasRecast ? unrecastCast(cast.hash) : recastCast(cast.hash)).catch(() =>
        patchCast(cast.hash, (c) => applyReaction(c, "recast")),
      );
    },
    [patchCast],
  );

  const handleBookmark = useCallback(
    (cast: Cast) => {
      const wasBookmarked = cast.viewer_bookmarked;
      patchCast(cast.hash, applyBookmark);
      (wasBookmarked
        ? unbookmarkCast(cast.hash)
        : bookmarkCast(cast.hash)
      ).catch(() => patchCast(cast.hash, applyBookmark));
    },
    [patchCast],
  );

  const handlePress = useCallback(
    (cast: Cast) => router.push(`/app/cast/${cast.hash}`),
    [router],
  );

  const handleReply = useCallback(
    (cast: Cast) =>
      openCompose({
        mode: "reply",
        target: { hash: cast.hash, author: cast.author },
      }),
    [openCompose],
  );

  const handleQuote = useCallback(
    (cast: Cast) =>
      openCompose({
        mode: "quote",
        target: { hash: cast.hash, author: cast.author },
      }),
    [openCompose],
  );

  // Feed keyboard navigation (j/k/Enter/l/r/t/b) over the channel's casts.
  const { focusedIndex, getRowProps } = useCastListNavigation({
    items: casts,
    getCast: identityCast,
    onOpen: handlePress,
    onLike: handleLike,
    onReply: handleReply,
    onRecast: handleRecast,
    onBookmark: handleBookmark,
  });

  if (loading && casts.length === 0) {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error && casts.length === 0) {
    return (
      <EmptyState
        title="Channel unavailable"
        description={error}
        action={
          <Button variant="ghost" onClick={() => router.refresh()}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <div>
      <header className="border-b border-juke-border px-4 py-5">
        <p className="text-xs font-bold uppercase tracking-wide text-juke-text-on-dark-secondary">
          Channel
        </p>
        <h1 className="truncate text-2xl font-bold text-juke-text-on-dark">
          /{channelId}
        </h1>
      </header>

      <FeedList
        items={casts}
        getKey={(c) => c.hash}
        loading={loading}
        hasMore={!!cursor}
        onLoadMore={loadMore}
        emptyState={<EmptyState title="No casts in this channel yet" />}
        renderItem={(cast, index) => (
          <div {...getRowProps(index)}>
            <CastCard
              cast={cast}
              focused={index === focusedIndex}
              onLike={handleLike}
              onRecast={handleRecast}
              onBookmark={handleBookmark}
              onReply={handleReply}
              onQuote={handleQuote}
              onPress={handlePress}
            />
          </div>
        )}
      />
    </div>
  );
}
