"use client";

/**
 * useAutoGrowTextarea — grows a textarea with its content, capped at a
 * fraction of the viewport height; past the cap the textarea scrolls
 * internally.
 *
 * #313 regression guard: resizing is driven ONLY by a post-commit effect on
 * the controlled `value` (plus layout inputs), never by a native `input`
 * listener. A native `input` handler that sets React state synchronously
 * re-renders the controlled textarea mid-dispatch and resets its DOM value
 * before React's delegated `onChange` fires, silently killing typing (see
 * `useComposerAutocomplete.ts` for the full write-up). This hook also never
 * touches the value — it only reads `scrollHeight` and writes `style.height`.
 *
 * The `rows` attribute keeps working as the MINIMUM height: with
 * `height: auto`, `scrollHeight` is never smaller than the rows-derived
 * client height, so `min(scrollHeight, cap)` can only grow past it.
 */

import { useCallback, useEffect, type RefObject } from "react";

/** Inline composers grow up to ~40% of the viewport height. */
export const INLINE_TEXTAREA_MAX_VIEWPORT_FRACTION = 0.4;
/** The modal composer grows up to ~55% of the viewport height. */
export const MODAL_TEXTAREA_MAX_VIEWPORT_FRACTION = 0.55;

export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxViewportFraction: number,
  /** Any extra input that changes the natural height (e.g. the `rows` attr). */
  layoutKey?: unknown,
): void {
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Border is outside scrollHeight but inside a border-box height.
    const borderHeight = el.offsetHeight - el.clientHeight;
    el.style.height = "auto";
    const maxPx = Math.round(window.innerHeight * maxViewportFraction);
    const contentHeight = el.scrollHeight + borderHeight;
    el.style.height = `${Math.min(contentHeight, maxPx)}px`;
    el.style.overflowY = contentHeight > maxPx ? "auto" : "hidden";
  }, [ref, maxViewportFraction]);

  useEffect(() => {
    resize();
  }, [resize, value, layoutKey]);

  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);
}
