"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export interface UseFeedNavigationOptions {
  /** Total number of items in the feed. Used to clamp the focused index. */
  itemCount: number;
  /** Called when Enter is pressed on the focused item. */
  onOpen?: (index: number) => void;
  /** Called when `l` is pressed on the focused item. */
  onLike?: (index: number) => void;
  /** Called when `r` is pressed on the focused item. */
  onReply?: (index: number) => void;
  /**
   * Called when `.` is pressed (Twitter convention: refresh the feed and
   * scroll to top). Fires regardless of whether a cast is focused.
   */
  onRefresh?: () => void;
  /** Called when `t` is pressed on the focused item. */
  onRecast?: (index: number) => void;
  /** Called when `b` is pressed on the focused item. */
  onBookmark?: (index: number) => void;
}

export interface UseFeedNavigationResult {
  /** -1 means no item is focused. */
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
}

/**
 * Feed-scoped keyboard navigation hook.
 *
 * Maintains a state-driven focus ring (`focusedIndex`) for j/k navigation and
 * action shortcuts (l/r/t/b/Enter). The focus ring is purely presentational —
 * real DOM focus stays on <body>; set `data-feed-index={i}` on each cast card
 * to get automatic `scrollIntoView` on focus change.
 *
 * Actions (Enter/l/r/t/b) are no-ops when `focusedIndex < 0` or when
 * `document.activeElement` is not the body (e.g. a button has focus).
 *
 * The focused index resets to -1 on route change.
 */
export function useFeedNavigation({
  itemCount,
  onOpen,
  onLike,
  onReply,
  onRefresh,
  onRecast,
  onBookmark,
}: UseFeedNavigationOptions): UseFeedNavigationResult {
  const pathname = usePathname();
  const [focusedIndex, setFocusedIndexState] = useState(-1);

  /**
   * Ref that is always kept in sync with `focusedIndex` state. Handlers read
   * from this ref so they see the current index even when two keydown events
   * fire in the same frame before React has had a chance to re-render (stale
   * closure fix: rapid j→action would otherwise act on the wrong index).
   */
  const focusedIndexRef = useRef(-1);

  /** Public setter — keeps state and ref in sync. */
  const setFocusedIndex = useCallback((index: number) => {
    focusedIndexRef.current = index;
    setFocusedIndexState(index);
  }, []);

  // Reset on route change.
  useEffect(() => {
    setFocusedIndex(-1);
  }, [pathname, setFocusedIndex]);

  // Scroll the focused card into view whenever the index changes.
  useEffect(() => {
    if (focusedIndex < 0) return;
    const el = document.querySelector<HTMLElement>(
      `[data-feed-index="${focusedIndex}"]`,
    );
    if (!el) return;

    if (focusedIndex === 0) {
      // Top cast: scroll to the very top of the page so the composer and strip
      // context above the first cast are fully visible.
      window.scrollTo({ top: 0 });
      return;
    }

    // For all other casts, start with a "nearest" scroll so we don't jump
    // when the card is already partially visible.
    el.scrollIntoView({ block: "nearest" });

    // Guard the tall-cast / header-occlusion case: if the card's top edge is
    // hidden behind the sticky header (≈56 px) scroll the page so the top of
    // the card sits just below it. This ensures you always read a cast from
    // the top, even when the card is taller than the viewport.
    const HEADER_CLEARANCE = 56 + 8; // header height + small margin (px)
    const rect = el.getBoundingClientRect();
    if (rect.top < HEADER_CLEARANCE) {
      window.scrollTo({ top: window.scrollY + rect.top - HEADER_CLEARANCE });
    }
  }, [focusedIndex]);

  const moveFocus = useCallback(
    (delta: number) => {
      if (itemCount === 0) return;
      // Read from ref, not state, so two consecutive events (j then action)
      // that fire before a re-render both see the correct current index.
      const prev = focusedIndexRef.current;
      const next =
        prev < 0
          ? // No item focused yet — land on first (down) or last (up).
            delta > 0 ? 0 : itemCount - 1
          : Math.max(0, Math.min(prev + delta, itemCount - 1));
      setFocusedIndex(next);
    },
    [itemCount, setFocusedIndex],
  );

  /**
   * True when the shortcut surface is "at rest": real DOM focus is on the body
   * (not a button/input). Reads live DOM state so it is never stale.
   */
  const isBodyFocused = useCallback((): boolean => {
    const active = document.activeElement;
    return !active || active === document.body;
  }, []);

  /**
   * True when per-cast actions should fire (body has focus AND an item is
   * selected). Reads from focusedIndexRef so it is never stale between renders.
   */
  const canAct = useCallback(
    (): boolean => focusedIndexRef.current >= 0 && isBodyFocused(),
    [isBodyFocused],
  );

  const handlers = {
    j: () => moveFocus(1),
    k: () => moveFocus(-1),
    // Actions call preventDefault when they fire so the triggering keystroke is
    // not also delivered as text input to a field the action focuses — e.g. `r`
    // opening the reply composer would otherwise type "r" into its textarea.
    Enter: (e: KeyboardEvent) => {
      if (!canAct()) return;
      e.preventDefault();
      onOpen?.(focusedIndexRef.current);
    },
    l: (e: KeyboardEvent) => {
      if (!canAct()) return;
      e.preventDefault();
      onLike?.(focusedIndexRef.current);
    },
    r: (e: KeyboardEvent) => {
      if (!canAct()) return;
      e.preventDefault();
      onReply?.(focusedIndexRef.current);
    },
    ".": (e: KeyboardEvent) => {
      // Refresh + scroll to top (Twitter convention), regardless of focus ring.
      if (!isBodyFocused()) return;
      e.preventDefault();
      onRefresh?.();
    },
    t: (e: KeyboardEvent) => {
      if (!canAct()) return;
      e.preventDefault();
      onRecast?.(focusedIndexRef.current);
    },
    b: (e: KeyboardEvent) => {
      if (!canAct()) return;
      e.preventDefault();
      onBookmark?.(focusedIndexRef.current);
    },
  };

  useKeyboardShortcuts(handlers, { enabled: true });

  return { focusedIndex, setFocusedIndex };
}
