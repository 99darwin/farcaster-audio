/**
 * Keyboard shortcuts — pure helpers and the canonical SHORTCUTS descriptor table.
 *
 * This module has NO imports from Next.js, React, or browser globals so it can
 * be exercised in a plain Node test environment.
 */

// ---------------------------------------------------------------------------
// Typing-target guard
// ---------------------------------------------------------------------------

/** Tag names that count as typing targets (lower-cased for comparison). */
const TYPING_TAGS = new Set(["input", "textarea", "select"]);

/**
 * Returns true when `el` is an element the user is actively typing into —
 * i.e., a text field, a `contenteditable`, or the <select> control.  Shortcut
 * handlers should bail out when this is true so they don't steal keystrokes.
 */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as Element).tagName !== "string") return false;
  const tag = (el as Element).tagName.toLowerCase();
  if (TYPING_TAGS.has(tag)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shortcut binding & matching
// ---------------------------------------------------------------------------

export interface ShortcutBinding {
  /** One or more keys that activate this shortcut (case-insensitive). */
  keys: string[];
  /**
   * When true the shortcut fires even inside dialogs (e.g. Escape / ?).
   * Default: false.
   */
  allowInDialog?: boolean;
}

/**
 * Returns true when `e` matches the given `binding`.
 * Callers are responsible for the higher-level guards (modifier keys, typing
 * target, isComposing) — this function only checks the key name.
 */
export function matchShortcut(
  e: Pick<KeyboardEvent, "key">,
  binding: ShortcutBinding,
): boolean {
  return binding.keys.some((k) => k.toLowerCase() === e.key.toLowerCase());
}

// ---------------------------------------------------------------------------
// Chord (key-sequence) helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `key` is a two-key chord descriptor (e.g. `"g h"`).
 * A chord key contains exactly one space separating the prefix from the
 * trigger character.
 */
export function isChordKey(key: string): boolean {
  const idx = key.indexOf(" ");
  // Requires exactly one space, not at the first or last character position,
  // so both the prefix and the trigger parts are non-empty.
  return idx > 0 && idx === key.lastIndexOf(" ") && idx < key.length - 1;
}

/**
 * Splits a chord key string (e.g. `"g h"`) into its parts (`["g", "h"]`).
 * Returns a single-element array for plain (non-chord) keys so callers can
 * always map over the result.
 */
export function splitChordKey(key: string): string[] {
  return isChordKey(key) ? key.split(" ") : [key];
}

// ---------------------------------------------------------------------------
// SHORTCUTS descriptor table
// ---------------------------------------------------------------------------

export type ShortcutGroup = "Navigation" | "Actions" | "Compose";

export interface ShortcutDescriptor {
  /** Unique action identifier. */
  action: string;
  /** Keys that trigger the shortcut (displayed with <kbd> tags). */
  keys: string[];
  /** Human-readable description shown in the help overlay. */
  description: string;
  /** Grouping for the help overlay. */
  group: ShortcutGroup;
  /** Fires even when a dialog is open. Default: false. */
  allowInDialog?: boolean;
}

/**
 * Canonical shortcut table. This drives BOTH the runtime dispatch (via
 * `useKeyboardShortcuts`) and the `ShortcutHelpOverlay` rendering, ensuring
 * the two stay in sync.
 */
export const SHORTCUTS: ShortcutDescriptor[] = [
  // Navigation
  {
    action: "next",
    keys: ["j"],
    description: "Next cast",
    group: "Navigation",
  },
  {
    action: "prev",
    keys: ["k"],
    description: "Previous cast",
    group: "Navigation",
  },
  {
    action: "open",
    keys: ["Enter"],
    description: "Open thread",
    group: "Navigation",
  },
  // g-chord navigation (Twitter-style "go to …")
  {
    action: "go-home",
    keys: ["g h"],
    description: "Go to home",
    group: "Navigation",
  },
  {
    action: "go-notifications",
    keys: ["g n"],
    description: "Go to notifications",
    group: "Navigation",
  },
  {
    action: "go-profile",
    keys: ["g p"],
    description: "Go to profile",
    group: "Navigation",
  },
  {
    action: "go-bookmarks",
    keys: ["g b"],
    description: "Go to bookmarks",
    group: "Navigation",
  },
  {
    action: "go-search",
    keys: ["g s"],
    description: "Go to search",
    group: "Navigation",
  },
  {
    action: "go-miniapps",
    keys: ["g m"],
    description: "Go to Mini Apps",
    group: "Navigation",
  },
  // Actions
  {
    action: "like",
    keys: ["l"],
    description: "Like focused cast",
    group: "Actions",
  },
  {
    action: "reply",
    keys: ["r"],
    description: "Reply to focused cast",
    group: "Actions",
  },
  {
    action: "refresh",
    keys: ["."],
    description: "Refresh feed",
    group: "Actions",
  },
  {
    action: "recast",
    keys: ["t"],
    description: "Recast focused cast",
    group: "Actions",
  },
  {
    action: "bookmark",
    keys: ["b"],
    description: "Bookmark focused cast",
    group: "Actions",
  },
  // Compose
  {
    action: "compose",
    keys: ["n"],
    description: "New cast",
    group: "Compose",
  },
  {
    // Display-only — actual handling lives in CastComposer's onKeyDown,
    // not in useKeyboardShortcuts, because it fires inside a typing target.
    action: "send-cast",
    keys: ["⌘↩"],
    description: "Send cast",
    group: "Compose",
  },
  {
    action: "search",
    keys: ["/"],
    description: "Search",
    group: "Compose",
  },
  {
    action: "help",
    keys: ["?"],
    description: "Show / hide keyboard shortcuts",
    group: "Compose",
    allowInDialog: true,
  },
  {
    action: "escape",
    keys: ["Escape"],
    description: "Close overlay / dialog",
    group: "Compose",
    allowInDialog: true,
  },
];

/** Lookup map: action → descriptor (built once at module load). */
export const SHORTCUT_MAP: Readonly<Record<string, ShortcutDescriptor>> =
  Object.fromEntries(SHORTCUTS.map((s) => [s.action, s]));
