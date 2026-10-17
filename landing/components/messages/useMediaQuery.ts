"use client";

import { useSyncExternalStore } from "react";

/** Live `matchMedia` result. Returns `serverValue` during SSR/hydration. */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : serverValue,
    () => serverValue,
  );
}

/** Touch-first devices: swipe-to-reply and long-press menus. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";
/** Two-pane layout breakpoint (Tailwind `lg`). */
export const TWO_PANE_QUERY = "(min-width: 1024px)";

/** `document.visibilityState === "visible"`, live. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
    () => document.visibilityState === "visible",
    () => true,
  );
}
