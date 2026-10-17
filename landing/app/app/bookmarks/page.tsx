"use client";

/**
 * Bookmarks — the current user's saved casts.
 *
 * Mirrors mobile `app/bookmarks.tsx`: an infinite-scroll list of bookmarked
 * casts (`GET /v1/feed/bookmarks`) with an inline remove action
 * (`DELETE /v1/feed/bookmarks/{hash}`). Removing is optimistic — the row drops
 * immediately and is restored if the request fails.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  getBookmarkedCasts,
  removeBookmark,
} from "@/lib/api/bookmarks";
import {
  identityCast,
  useCastListNavigation,
} from "@/lib/keyboard/useCastListNavigation";
import { CastCard } from "@/components/ui/cast-card";
import { FeedList } from "@/components/ui/feed-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import type { Cast } from "@/lib/api/types";

const PAGE_SIZE = 25;

export default function BookmarksPage() {
  const { status, signIn } = useAuth();
  const router = useRouter();

  const [casts, setCasts] = useState<Cast[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Guards a fetch from overlapping itself (sentinel can fire rapidly).
  const inFlight = useRef(false);

  const loadPage = useCallback(async (nextCursor: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await getBookmarkedCasts({
        limit: PAGE_SIZE,
        cursor: nextCursor ?? undefined,
      });
      setCasts((prev) =>
        nextCursor ? [...prev, ...res.casts] : res.casts,
      );
      setCursor(res.next_cursor);
    } catch {
      setError("Couldn't load your bookmarks. Please try again.");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setInitialized(true);
    }
  }, []);

  // Initial load once the session resolves to authenticated.
  useEffect(() => {
    if (status !== "authenticated" || initialized) return;
    void loadPage(null);
  }, [status, initialized, loadPage]);

  const handleLoadMore = useCallback(() => {
    if (cursor) void loadPage(cursor);
  }, [cursor, loadPage]);

  const handleRemove = useCallback(
    async (cast: Cast) => {
      // Capture the current position for restore-on-failure, then optimistically
      // drop the row.
      const index = casts.findIndex((c) => c.hash === cast.hash);
      if (index === -1) return;
      const removed = casts[index];
      setCasts((prev) => prev.filter((c) => c.hash !== cast.hash));
      try {
        await removeBookmark(cast.hash);
      } catch {
        setCasts((prev) => {
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, removed);
          return next;
        });
      }
    },
    [casts],
  );

  // Feed keyboard navigation: j/k move focus, Enter opens the thread, `b`
  // removes the bookmark (this page's only cast action).
  const { focusedIndex, getRowProps } = useCastListNavigation({
    items: casts,
    getCast: identityCast,
    onOpen: (cast) => router.push(`/app/cast/${cast.hash}`),
    onBookmark: handleRemove,
  });

  if (status === "loading") {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <EmptyState
        title="Sign in to see your bookmarks"
        description="Connect Farcaster to save casts and find them here later."
        action={
          <Button onClick={() => void signIn()}>Connect Farcaster</Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col">
      <header className="border-b border-juke-border px-4 py-4">
        <h1 className="text-lg font-semibold text-juke-text-on-dark">
          Bookmarks
        </h1>
      </header>

      {error && casts.length === 0 && initialized ? (
        <EmptyState
          title="Something went wrong"
          description={error}
          action={
            <Button variant="ghost" onClick={() => void loadPage(null)}>
              Try again
            </Button>
          }
        />
      ) : (
        <FeedList
          items={casts}
          loading={loading}
          hasMore={cursor != null}
          onLoadMore={handleLoadMore}
          getKey={(cast) => cast.hash}
          renderItem={(cast, index) => (
            <div {...getRowProps(index)}>
              <CastCard
                cast={cast}
                focused={index === focusedIndex}
                onBookmark={handleRemove}
              />
            </div>
          )}
          emptyState={
            <EmptyState
              title="No bookmarks yet"
              description="Save casts to find them here later."
            />
          }
        />
      )}
    </div>
  );
}
