"use client";

/**
 * Appearance / behaviour preferences for the `/app` web client.
 *
 * Persisted to localStorage via zustand's `persist` middleware. Because the
 * store hydrates on the client only, SSR renders the default values; consumers
 * that would flicker should gate on `hasHydrated` before reading persisted
 * fields (see {@link usePrefsHydrated}).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "system" | "dark";

export interface PrefsState {
  theme: ThemePreference;
  /** Retro "Winamp" visualizer skin for the audio player. */
  winampMode: boolean;
  /** True once the persisted state has rehydrated from localStorage. */
  hasHydrated: boolean;

  setTheme: (theme: ThemePreference) => void;
  setWinampMode: (enabled: boolean) => void;
  toggleWinampMode: () => void;
  setHasHydrated: (value: boolean) => void;
}

const STORAGE_KEY = "juke-prefs";

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      theme: "dark",
      winampMode: false,
      hasHydrated: false,

      setTheme: (theme) => set({ theme }),
      setWinampMode: (winampMode) => set({ winampMode }),
      toggleWinampMode: () =>
        set((state) => ({ winampMode: !state.winampMode })),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    }),
    {
      name: STORAGE_KEY,
      // Only persist the user-facing prefs, never the hydration flag.
      partialize: (state) => ({
        theme: state.theme,
        winampMode: state.winampMode,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

/** Convenience selector for gating persisted reads until hydration completes. */
export function usePrefsHydrated(): boolean {
  return usePrefsStore((state) => state.hasHydrated);
}
