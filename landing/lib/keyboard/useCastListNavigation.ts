"use client";

import { useCallback, useEffect } from "react";
import type { Cast } from "@/lib/api/types";
import { useFeedNavigation } from "./useFeedNavigation";

/**
 * Row props to spread onto the wrapper element of each rendered item so the
 * focus-ring scroll logic in {@link useFeedNavigation} can locate it.
 */
export interface CastRowProps {
  "data-feed-index": number;
}

/** `getCast` for plain `Cast[]` lists where every row is itself a cast. */
export const identityCast = (cast: Cast): Cast => cast;

export interface UseCastListNavigationOptions<T> {
  /**
   * The rendered items. May be a plain cast list or a discriminated union that
   * also contains non-cast rows (voice notes, recordings) — j/k still traverse
   * those rows, but per-cast actions are no-ops on them.
   */
  items: T[];
  /**
   * Extract the actionable cast from an item. Return `null` for rows that are
   * not casts so l/r/t/b/Enter become no-ops while j/k navigation still works.
   */
  getCast: (item: T) => Cast | null;
  /** Enter on the focused cast — usually routes to the thread. */
  onOpen: (cast: Cast) => void;
  /** `l` on the focused cast. */
  onLike?: (cast: Cast) => void;
  /** `r` on the focused cast. */
  onReply?: (cast: Cast) => void;
  /** `t` on the focused cast. */
  onRecast?: (cast: Cast) => void;
  /** `b` on the focused cast. */
  onBookmark?: (cast: Cast) => void;
  /**
   * `.`-to-refresh. Omit on pages without a refresh path — refresh is home-only
   * today, so leaving this undefined makes `.` a no-op elsewhere.
   */
  onRefresh?: () => void;
  /**
   * When this value changes the focus ring resets to -1. Use it for tab or
   * query switches where the list is replaced wholesale. Route changes are
   * already handled by {@link useFeedNavigation}.
   */
  resetKey?: unknown;
}

export interface UseCastListNavigationResult {
  /** -1 means no item is focused. Pass `focusedIndex === i` to CastCard's `focused`. */
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  /** Props for the wrapper element of the item at `index`. */
  getRowProps: (index: number) => CastRowProps;
}

/**
 * Feed keyboard navigation for any cast-list view.
 *
 * Wraps {@link useFeedNavigation}, mapping its index-based callbacks onto the
 * page's cast-level action handlers via `getCast`. It also owns the two focus
 * resets every list needs — when the list shrinks past the focused index (e.g.
 * a delete or bookmark removal) and when `resetKey` changes (tab / query
 * switch) — so pages don't re-implement that boilerplate.
 *
 * Empty lists are inherently safe: `useFeedNavigation` no-ops j/k when
 * `itemCount === 0` and actions require a focused index, so a page rendering
 * an empty state never handles feed keys.
 */
export function useCastListNavigation<T>({
  items,
  getCast,
  onOpen,
  onLike,
  onReply,
  onRecast,
  onBookmark,
  onRefresh,
  resetKey,
}: UseCastListNavigationOptions<T>): UseCastListNavigationResult {
  // Resolve the cast at a focused index, tolerating an out-of-range index.
  const castAt = useCallback(
    (index: number): Cast | null => {
      const item = items[index];
      return item === undefined ? null : getCast(item);
    },
    [items, getCast],
  );

  const { focusedIndex, setFocusedIndex } = useFeedNavigation({
    itemCount: items.length,
    onOpen: (index) => {
      const cast = castAt(index);
      if (cast) onOpen(cast);
    },
    onLike: (index) => {
      const cast = castAt(index);
      if (cast) onLike?.(cast);
    },
    onReply: (index) => {
      const cast = castAt(index);
      if (cast) onReply?.(cast);
    },
    onRecast: (index) => {
      const cast = castAt(index);
      if (cast) onRecast?.(cast);
    },
    onBookmark: (index) => {
      const cast = castAt(index);
      if (cast) onBookmark?.(cast);
    },
    onRefresh,
  });

  // Reset focus when the list shrinks below the current index so the ring never
  // points past the end.
  useEffect(() => {
    if (focusedIndex >= items.length) {
      setFocusedIndex(Math.max(-1, items.length - 1));
    }
  }, [items.length, focusedIndex, setFocusedIndex]);

  // Reset focus on an explicit tab/query switch.
  useEffect(() => {
    setFocusedIndex(-1);
  }, [resetKey, setFocusedIndex]);

  const getRowProps = useCallback(
    (index: number): CastRowProps => ({ "data-feed-index": index }),
    [],
  );

  return { focusedIndex, setFocusedIndex, getRowProps };
}
