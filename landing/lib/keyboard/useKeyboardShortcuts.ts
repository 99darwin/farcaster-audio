"use client";

import { useEffect, useRef } from "react";
import { isTypingTarget } from "./shortcuts";

export interface UseKeyboardShortcutsOptions {
  /** When false the listener is not attached. Defaults to true. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Chord (key-sequence) prefix state
// ---------------------------------------------------------------------------

/**
 * Per-hook-instance state for tracking an armed chord prefix (e.g. the first
 * "g" in the "g h" chord). Stored in a ref so it persists across renders
 * without triggering re-renders, and is cleared on hook unmount.
 */
interface PrefixState {
  /** The pending prefix key, or null when no chord is armed. */
  active: string | null;
  /** The disarm timer handle, or null when inactive. */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Arms the prefix and schedules an automatic disarm after `ms`. */
function armPrefix(ps: PrefixState, key: string, ms: number): void {
  if (ps.timer !== null) clearTimeout(ps.timer);
  ps.active = key;
  ps.timer = setTimeout(() => {
    ps.active = null;
    ps.timer = null;
  }, ms);
}

/** Clears any armed prefix immediately (called on chord resolution or unmount). */
function clearPrefix(ps: PrefixState): void {
  if (ps.timer !== null) clearTimeout(ps.timer);
  ps.active = null;
  ps.timer = null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Attaches a single `keydown` listener on `window` that routes events to the
 * matching handler in `handlers`. Handlers are kept in a ref so callers can
 * pass fresh closures each render without re-adding the listener.
 *
 * Guard order (bail out if any condition is true):
 *   1. `e.defaultPrevented`
 *   2. Any modifier key (meta / ctrl / alt) is held — preserves browser/OS
 *      shortcuts.
 *   3. `isTypingTarget(e.target)` — don't steal keystrokes from text fields.
 *   4. `e.isComposing` — IME composition in progress.
 *   5. A dialog is open AND the shortcut action has not opted in via
 *      `allowInDialog` — the SHORTCUTS table controls this; callers declare it
 *      by including a `_allowInDialog` key in the handler map.
 *
 * ### Single-key handlers
 * Register with the bare key string (e.g. `"j"`, `"Escape"`, `"?"`).
 * To allow a key through an open dialog, suffix the map key with
 * `":allowInDialog"` (e.g. `"Escape:allowInDialog"`).
 *
 * ### Chord (two-key sequence) handlers
 * Register with a space-separated string (e.g. `"g h"`, `"g n"`).  When the
 * first key is pressed and this map contains at least one chord that starts
 * with it, the hook arms a 1.5 s prefix window.  The next qualifying keydown
 * resolves the chord: if the combined key (`"g h"`) is in the map the handler
 * fires (with `preventDefault` on the second key only); otherwise the prefix
 * is disarmed and normal single-key handling proceeds for the second key.
 *
 * Chord shortcuts do NOT fire when a dialog is open (they carry no
 * `:allowInDialog` suffix support).
 *
 * @param handlers  Map of shortcut key strings to handler functions.
 * @param opts      Optional configuration.
 */
export function useKeyboardShortcuts(
  handlers: Record<string, (e: KeyboardEvent) => void>,
  opts: UseKeyboardShortcutsOptions = {},
): void {
  const { enabled = true } = opts;
  const handlersRef = useRef(handlers);
  const prefixRef = useRef<PrefixState>({ active: null, timer: null });

  // Keep the handlers ref current on every render without triggering the effect.
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;

    const ps = prefixRef.current;

    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.isComposing) return;

      const dialogOpen = !!document.querySelector('[role="dialog"]');
      const map = handlersRef.current;

      // -----------------------------------------------------------------
      // Chord resolution — if a prefix was armed by a previous keydown
      // -----------------------------------------------------------------
      if (ps.active !== null) {
        const chordKey = `${ps.active} ${e.key}`;
        clearPrefix(ps);

        // Chord shortcuts are never allowed inside dialogs.
        if (!dialogOpen && Object.hasOwn(map, chordKey)) {
          e.preventDefault(); // swallow the second key of a resolved chord
          map[chordKey](e);
          return;
        }

        // Non-matching second key: fall through to normal single-key handling.
      }

      // -----------------------------------------------------------------
      // Dialog guard — only allowInDialog handlers fire
      // -----------------------------------------------------------------
      const allowInDialogKey = `${e.key}:allowInDialog`;

      if (dialogOpen) {
        const key = Object.hasOwn(map, allowInDialogKey) ? allowInDialogKey : null;
        if (key) {
          map[key](e);
        }
        return;
      }

      // -----------------------------------------------------------------
      // Single-key resolution
      // -----------------------------------------------------------------
      // Use Object.hasOwn to avoid prototype property collisions (e.g. e.key
      // === "__proto__" or "constructor") — only match explicitly registered keys.
      const resolvedKey = Object.hasOwn(map, e.key)
        ? e.key
        : Object.hasOwn(map, allowInDialogKey)
          ? allowInDialogKey
          : null;

      if (resolvedKey) {
        map[resolvedKey](e);
        return;
      }

      // -----------------------------------------------------------------
      // Chord prefix detection — arm if this key starts any registered chord
      // -----------------------------------------------------------------
      // Note: this runs only when no single-key handler consumed the event,
      // so 'g' alone (if registered as a single-key handler) would take
      // priority and never arm a chord prefix.
      const keyAsPrefix = `${e.key} `;
      const isChordPrefixKey = Object.keys(map).some((k) =>
        k.startsWith(keyAsPrefix),
      );
      if (isChordPrefixKey) {
        // Do NOT preventDefault — the prefix key itself should not be swallowed.
        armPrefix(ps, e.key, 1500);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPrefix(ps);
    };
  }, [enabled]);
}
