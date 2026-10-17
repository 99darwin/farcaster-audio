"use client";

/**
 * GlobalShortcuts — app-level keyboard shortcut handler.
 *
 * Mounted once inside `ShellChrome` (providers.tsx). Handles:
 *   n      → open compose modal (preventDefault so "n" isn't typed into the autofocused textarea)
 *   /      → navigate to search (preventDefault so the browser find bar
 *             doesn't open)
 *   ?      → toggle the ShortcutHelpOverlay
 *   Escape → close the overlay (when it is the only open dialog; the Modal
 *             itself handles Escape for its own close)
 *
 * g-chord navigation (Twitter-style "go to …"):
 *   g h    → /app          (home)
 *   g n    → /app/notifications
 *   g p    → /app/profile/{fid}  (no-op when anonymous)
 *   g b    → /app/bookmarks
 *   g s    → /app/search
 *   g m    → /app/miniapps
 *
 * Feed-level shortcuts (j/k/l/r/t/b/Enter) are owned by `useFeedNavigation`
 * and live on the home page.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useKeyboardShortcuts } from "@/lib/keyboard/useKeyboardShortcuts";
import { useComposeStore } from "@/lib/stores/composeStore";
import { useAuthStore } from "@/lib/stores/authStore";
import { ShortcutHelpOverlay } from "./ShortcutHelpOverlay";

export function GlobalShortcuts() {
  const router = useRouter();
  const openCompose = useComposeStore((s) => s.openCompose);
  const user = useAuthStore((s) => s.user);
  const [helpOpen, setHelpOpen] = useState(false);

  /**
   * Ref kept in sync with `helpOpen` so `handleEscape` always reads the
   * current value without capturing a stale closure. This avoids
   * re-registering handlers on every open/close toggle.
   *
   * Assign during render (not in useEffect) for immediate availability —
   * this is the standard "latest ref" pattern.
   */
  const helpOpenRef = useRef(false);
  helpOpenRef.current = helpOpen;

  /**
   * Ref kept in sync with `user` so chord handlers always read the
   * latest auth state without capturing a stale closure.
   */
  const userRef = useRef(user);
  userRef.current = user;

  const handleCompose = useCallback((e: KeyboardEvent) => {
    // Prevent the triggering keystroke from being inserted into the textarea
    // that the compose modal autofocuses.
    e.preventDefault();
    openCompose({ mode: "cast" });
  }, [openCompose]);

  const handleSearch = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    router.push("/app/search");
  }, [router]);

  const handleHelp = useCallback((_e: KeyboardEvent) => {
    setHelpOpen((prev) => !prev);
  }, []);

  const handleEscape = useCallback((_e: KeyboardEvent) => {
    // Only close the help overlay when it is actually open. Without this
    // guard, pressing Escape while any other dialog (e.g. compose modal) is
    // active would unconditionally call setHelpOpen(false), competing with
    // that dialog's own Escape handler. Reading from ref avoids a stale
    // closure and keeps this callback stable (no deps).
    if (helpOpenRef.current) setHelpOpen(false);
  }, []); // stable — reads from ref, not from the helpOpen state closure

  // g-chord handlers — use refs to avoid stale closures without extra deps.
  const handleGoHome = useCallback((_e: KeyboardEvent) => {
    router.push("/app");
  }, [router]);

  const handleGoNotifications = useCallback((_e: KeyboardEvent) => {
    router.push("/app/notifications");
  }, [router]);

  const handleGoProfile = useCallback((_e: KeyboardEvent) => {
    // No-op when anonymous: the profile route requires a FID.
    const fid = userRef.current?.fid;
    if (fid != null) {
      router.push(`/app/profile/${fid}`);
    }
  }, [router]); // stable — reads fid from ref

  const handleGoBookmarks = useCallback((_e: KeyboardEvent) => {
    router.push("/app/bookmarks");
  }, [router]);

  const handleGoMiniApps = useCallback((_e: KeyboardEvent) => {
    router.push("/app/miniapps");
  }, [router]);

  useKeyboardShortcuts({
    n: handleCompose,
    "/": handleSearch,
    // ? is allowInDialog so it can close itself; register under the
    // allowInDialog-suffixed key so the hook fires even when the overlay
    // (which is a dialog) is open.
    "?:allowInDialog": handleHelp,
    "Escape:allowInDialog": handleEscape,
    // g-chord navigation
    "g h": handleGoHome,
    "g n": handleGoNotifications,
    "g p": handleGoProfile,
    "g b": handleGoBookmarks,
    "g s": handleSearch, // same destination as '/' — reuse the handler
    "g m": handleGoMiniApps,
  });

  return <ShortcutHelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />;
}
