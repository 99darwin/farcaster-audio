"use client";

/**
 * Home-feed store for the Juke web app — ported from mobile
 * `stores/feedStore.ts`, but typed against the normalised `Cast` shape the
 * web app uses everywhere (`@/lib/api/types`) instead of the raw v2 wire cast.
 *
 * Holds the merged-feed's cast half plus the optimistic reaction/bookmark
 * mutations. The Home page toggles a reaction locally (instant UI), fires the
 * API call, and reverts the same action on failure — so all four mutators are
 * their own inverse-friendly pairs.
 */

import { create } from "zustand";
import type { Cast } from "@/lib/api/types";

interface FeedStore {
  casts: Cast[];
  cursor: string | null;
  loading: boolean;
  refreshing: boolean;
  hasMore: boolean;
  error: string | null;
  /**
   * Monotonic timestamp bumped by {@link requestRefresh}. The Home page
   * subscribes to this value and reloads page-1 when it changes, letting
   * out-of-tree callers (nav components, keyboard shortcuts) trigger a feed
   * refresh without holding a ref to the page's loader.
   */
  refreshRequestedAt: number;

  setCasts: (casts: Cast[], cursor: string | null) => void;
  appendCasts: (casts: Cast[], cursor: string | null) => void;
  /** Optimistically place a freshly-published cast at the top of the feed. */
  prependCast: (cast: Cast) => void;
  /** Optimistically bump a cast's reply count (e.g. after publishing a reply). */
  incrementReplies: (hash: string) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setError: (error: string | null) => void;
  /** Ask the Home page to reload page-1 + scroll to top. */
  requestRefresh: () => void;

  /** Optimistic reaction toggles (each is its own revert). */
  like: (hash: string) => void;
  removeLike: (hash: string) => void;
  recast: (hash: string) => void;
  removeRecast: (hash: string) => void;
  bookmark: (hash: string, bookmarked: boolean) => void;

  /** Remove a single cast by hash (delete). */
  removeCast: (hash: string) => void;
  /** Drop every cast by `fid` (block). */
  removeAuthor: (fid: number) => void;
  reset: () => void;
}

function mapCast(
  casts: Cast[],
  hash: string,
  fn: (cast: Cast) => Cast,
): Cast[] {
  return casts.map((cast) => (cast.hash === hash ? fn(cast) : cast));
}

/** Set a viewer flag + adjust the matching count, guarding against no-ops. */
function setLike(cast: Cast, liked: boolean): Cast {
  if (cast.reactions.viewer_liked === liked) return cast;
  return {
    ...cast,
    reactions: {
      ...cast.reactions,
      viewer_liked: liked,
      likes_count: liked
        ? cast.reactions.likes_count + 1
        : Math.max(0, cast.reactions.likes_count - 1),
    },
  };
}

function setRecast(cast: Cast, recasted: boolean): Cast {
  if (cast.reactions.viewer_recasted === recasted) return cast;
  return {
    ...cast,
    reactions: {
      ...cast.reactions,
      viewer_recasted: recasted,
      recasts_count: recasted
        ? cast.reactions.recasts_count + 1
        : Math.max(0, cast.reactions.recasts_count - 1),
    },
  };
}

const INITIAL = {
  casts: [] as Cast[],
  cursor: null as string | null,
  loading: false,
  refreshing: false,
  hasMore: true,
  error: null as string | null,
  refreshRequestedAt: 0,
};

export const useFeedStore = create<FeedStore>((set) => ({
  ...INITIAL,

  setCasts: (casts, cursor) =>
    set({
      casts,
      cursor,
      hasMore: cursor !== null,
      loading: false,
      refreshing: false,
      error: null,
    }),

  appendCasts: (newCasts, cursor) =>
    set((state) => ({
      casts: [...state.casts, ...newCasts],
      cursor,
      hasMore: cursor !== null,
      loading: false,
      error: null,
    })),

  prependCast: (cast) =>
    set((state) =>
      // Guard against a duplicate if the real cast later arrives with the same
      // hash (e.g. a refresh that overlaps the optimistic insert).
      state.casts.some((c) => c.hash === cast.hash)
        ? {}
        : { casts: [cast, ...state.casts] },
    ),

  incrementReplies: (hash) =>
    set((state) => ({
      casts: mapCast(state.casts, hash, (c) => ({
        ...c,
        reactions: {
          ...c.reactions,
          replies_count: c.reactions.replies_count + 1,
        },
      })),
    })),

  setLoading: (loading) => set({ loading }),
  setRefreshing: (refreshing) => set({ refreshing }),
  setError: (error) => set({ error, loading: false, refreshing: false }),

  requestRefresh: () => set({ refreshRequestedAt: Date.now() }),

  like: (hash) =>
    set((state) => ({ casts: mapCast(state.casts, hash, (c) => setLike(c, true)) })),
  removeLike: (hash) =>
    set((state) => ({
      casts: mapCast(state.casts, hash, (c) => setLike(c, false)),
    })),
  recast: (hash) =>
    set((state) => ({
      casts: mapCast(state.casts, hash, (c) => setRecast(c, true)),
    })),
  removeRecast: (hash) =>
    set((state) => ({
      casts: mapCast(state.casts, hash, (c) => setRecast(c, false)),
    })),

  bookmark: (hash, bookmarked) =>
    set((state) => ({
      casts: mapCast(state.casts, hash, (c) => ({
        ...c,
        viewer_bookmarked: bookmarked,
      })),
    })),

  removeCast: (hash) =>
    set((state) => ({
      casts: state.casts.filter((cast) => cast.hash !== hash),
    })),

  removeAuthor: (fid) =>
    set((state) => ({
      casts: state.casts.filter((cast) => cast.author.fid !== fid),
    })),

  reset: () => set({ ...INITIAL }),
}));
