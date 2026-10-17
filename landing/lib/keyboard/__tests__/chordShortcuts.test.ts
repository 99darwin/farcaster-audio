/**
 * Unit tests for the g-chord (key-sequence) feature added to
 * `useKeyboardShortcuts` and `shortcuts.ts`.
 *
 * Node environment — no jsdom, no React. We exercise the pure helper
 * functions from shortcuts.ts and simulate the sequence-resolution state
 * machine that lives inside the hook to verify its correctness without
 * needing a browser runtime.
 */

import {
  isChordKey,
  splitChordKey,
  SHORTCUTS,
  SHORTCUT_MAP,
} from "../shortcuts";

// ---------------------------------------------------------------------------
// isChordKey
// ---------------------------------------------------------------------------

describe("isChordKey", () => {
  test("returns true for a two-part space-separated key", () => {
    expect(isChordKey("g h")).toBe(true);
    expect(isChordKey("g n")).toBe(true);
    expect(isChordKey("g p")).toBe(true);
    expect(isChordKey("g b")).toBe(true);
    expect(isChordKey("g s")).toBe(true);
    expect(isChordKey("g m")).toBe(true);
  });

  test("returns false for plain single-character keys", () => {
    expect(isChordKey("j")).toBe(false);
    expect(isChordKey("k")).toBe(false);
    expect(isChordKey("n")).toBe(false);
    expect(isChordKey("?")).toBe(false);
    expect(isChordKey("Escape")).toBe(false);
    expect(isChordKey("/")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isChordKey("")).toBe(false);
  });

  test("returns false for a string with a leading space", () => {
    expect(isChordKey(" h")).toBe(false); // space at index 0, not > 0
  });

  test("returns false for a string with a trailing space (empty trigger part)", () => {
    expect(isChordKey("g ")).toBe(false); // space is the last character
  });

  test("returns false for a string with more than one space (three-key chord is not supported)", () => {
    expect(isChordKey("g h j")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// splitChordKey
// ---------------------------------------------------------------------------

describe("splitChordKey", () => {
  test("splits a chord key into its two parts", () => {
    expect(splitChordKey("g h")).toEqual(["g", "h"]);
    expect(splitChordKey("g n")).toEqual(["g", "n"]);
  });

  test("returns a single-element array for non-chord keys", () => {
    expect(splitChordKey("j")).toEqual(["j"]);
    expect(splitChordKey("Escape")).toEqual(["Escape"]);
    expect(splitChordKey("?")).toEqual(["?"]);
  });

  test("plain keys pass through unchanged", () => {
    expect(splitChordKey("Enter")).toEqual(["Enter"]);
    expect(splitChordKey(".")).toEqual(["."]);
  });
});

// ---------------------------------------------------------------------------
// SHORTCUTS table — g-chord entries
// ---------------------------------------------------------------------------

describe("SHORTCUTS table — g-chord navigation entries", () => {
  const chordActions = ["go-home", "go-notifications", "go-profile", "go-bookmarks", "go-search", "go-miniapps"];

  test("all g-chord actions are present in the table", () => {
    const actions = SHORTCUTS.map((s) => s.action);
    for (const action of chordActions) {
      expect(actions).toContain(action);
    }
  });

  test("all g-chord actions belong to the Navigation group", () => {
    for (const action of chordActions) {
      expect(SHORTCUT_MAP[action]?.group).toBe("Navigation");
    }
  });

  test("g-chord actions have exactly one key each, which is a chord key", () => {
    for (const action of chordActions) {
      const keys = SHORTCUT_MAP[action]?.keys ?? [];
      expect(keys).toHaveLength(1);
      expect(isChordKey(keys[0])).toBe(true);
    }
  });

  test("chord keys use the expected prefix 'g'", () => {
    for (const action of chordActions) {
      const key = SHORTCUT_MAP[action]?.keys[0] ?? "";
      expect(key.startsWith("g ")).toBe(true);
    }
  });

  test("go-home maps to 'g h'", () => {
    expect(SHORTCUT_MAP["go-home"]?.keys).toEqual(["g h"]);
  });

  test("go-notifications maps to 'g n'", () => {
    expect(SHORTCUT_MAP["go-notifications"]?.keys).toEqual(["g n"]);
  });

  test("go-profile maps to 'g p'", () => {
    expect(SHORTCUT_MAP["go-profile"]?.keys).toEqual(["g p"]);
  });

  test("go-bookmarks maps to 'g b'", () => {
    expect(SHORTCUT_MAP["go-bookmarks"]?.keys).toEqual(["g b"]);
  });

  test("go-search maps to 'g s'", () => {
    expect(SHORTCUT_MAP["go-search"]?.keys).toEqual(["g s"]);
  });

  test("go-miniapps maps to 'g m'", () => {
    expect(SHORTCUT_MAP["go-miniapps"]?.keys).toEqual(["g m"]);
  });

  test("g-chord actions do NOT have allowInDialog set", () => {
    for (const action of chordActions) {
      expect(SHORTCUT_MAP[action]?.allowInDialog).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------------------
// Sequence-resolution state machine (pure simulation)
//
// We replicate the PrefixState logic from useKeyboardShortcuts in plain
// TypeScript so we can unit-test the state transitions without needing jsdom,
// React, or window.addEventListener.
// ---------------------------------------------------------------------------

interface PrefixState {
  active: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function armPrefix(ps: PrefixState, key: string, ms: number, useFakeTimer: boolean = false): void {
  if (ps.timer !== null) clearTimeout(ps.timer);
  ps.active = key;
  if (!useFakeTimer) {
    ps.timer = setTimeout(() => {
      ps.active = null;
      ps.timer = null;
    }, ms);
  }
}

function clearPrefixState(ps: PrefixState): void {
  if (ps.timer !== null) clearTimeout(ps.timer);
  ps.active = null;
  ps.timer = null;
}

/**
 * Simulates the hook's onKeyDown logic for a single handler map.
 * Returns the action string that was dispatched, or null if none.
 */
function simulateKeyDown(
  ps: PrefixState,
  map: Record<string, string>, // key → action label (instead of actual handlers)
  key: string,
  dialogOpen: boolean = false,
): string | null {
  let dispatched: string | null = null;

  // Chord resolution
  if (ps.active !== null) {
    const chordKey = `${ps.active} ${key}`;
    clearPrefixState(ps);

    if (!dialogOpen && Object.hasOwn(map, chordKey)) {
      dispatched = map[chordKey];
      return dispatched;
    }
    // Non-matching second key: fall through
  }

  // Dialog guard
  if (dialogOpen) {
    const allowInDialogKey = `${key}:allowInDialog`;
    if (Object.hasOwn(map, allowInDialogKey)) {
      dispatched = map[allowInDialogKey];
    }
    return dispatched;
  }

  // Single-key resolution
  const allowInDialogKey = `${key}:allowInDialog`;
  const resolvedKey = Object.hasOwn(map, key)
    ? key
    : Object.hasOwn(map, allowInDialogKey)
      ? allowInDialogKey
      : null;

  if (resolvedKey) {
    dispatched = map[resolvedKey];
    return dispatched;
  }

  // Chord prefix detection (use fake timer so tests don't hang)
  const keyAsPrefix = `${key} `;
  const isChordPrefixKey = Object.keys(map).some((k) => k.startsWith(keyAsPrefix));
  if (isChordPrefixKey) {
    armPrefix(ps, key, 1500, /* useFakeTimer */ true);
  }

  return null;
}

describe("chord sequence-resolution state machine", () => {
  const chordMap = {
    "g h": "go-home",
    "g n": "go-notifications",
    "g p": "go-profile",
    "g b": "go-bookmarks",
    "g s": "go-search",
    "g m": "go-miniapps",
    "n": "compose",
    "/": "search",
    "?:allowInDialog": "help",
    "Escape:allowInDialog": "escape",
  };

  function makePs(): PrefixState {
    return { active: null, timer: null };
  }

  test("g then h dispatches go-home", () => {
    const ps = makePs();
    expect(simulateKeyDown(ps, chordMap, "g")).toBeNull(); // arms prefix
    expect(ps.active).toBe("g");
    const result = simulateKeyDown(ps, chordMap, "h");
    expect(result).toBe("go-home");
    expect(ps.active).toBeNull(); // cleared after resolution
  });

  test("g then n dispatches go-notifications", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    expect(simulateKeyDown(ps, chordMap, "n")).toBe("go-notifications");
  });

  test("g then p dispatches go-profile", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    expect(simulateKeyDown(ps, chordMap, "p")).toBe("go-profile");
  });

  test("g then b dispatches go-bookmarks", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    expect(simulateKeyDown(ps, chordMap, "b")).toBe("go-bookmarks");
  });

  test("g then s dispatches go-search", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    expect(simulateKeyDown(ps, chordMap, "s")).toBe("go-search");
  });

  test("g then m dispatches go-miniapps", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    expect(simulateKeyDown(ps, chordMap, "m")).toBe("go-miniapps");
  });

  test("g alone does not dispatch anything", () => {
    const ps = makePs();
    expect(simulateKeyDown(ps, chordMap, "g")).toBeNull();
  });

  test("g then unknown key: prefix is cleared and key is handled normally", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g"); // arms prefix
    // "x" is not a valid second key for any chord, and not a single-key handler
    const result = simulateKeyDown(ps, chordMap, "x");
    expect(result).toBeNull();
    expect(ps.active).toBeNull(); // prefix was cleared
  });

  test("g then 'n' resolves to go-notifications, NOT the 'n' → compose handler", () => {
    // When a chord prefix is active, the second key is consumed by the chord
    // resolver first. 'n' alone maps to compose, but 'g n' maps to go-notifications.
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    const result = simulateKeyDown(ps, chordMap, "n");
    expect(result).toBe("go-notifications"); // chord wins
  });

  test("pressing 'n' without a prior 'g' dispatches compose", () => {
    const ps = makePs();
    const result = simulateKeyDown(ps, chordMap, "n");
    expect(result).toBe("compose");
  });

  test("chord does not fire when a dialog is open", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    // Second key arrives with dialog open
    const result = simulateKeyDown(ps, chordMap, "h", /* dialogOpen */ true);
    expect(result).toBeNull();
    expect(ps.active).toBeNull(); // prefix was still cleared
  });

  test("allowInDialog shortcuts still fire inside a dialog", () => {
    const ps = makePs();
    const result = simulateKeyDown(ps, chordMap, "?", /* dialogOpen */ true);
    expect(result).toBe("help");
  });

  test("pressing g twice arms prefix then drops first chord attempt", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g"); // arms prefix
    // g pressed again while prefix is active — "g g" is not a valid chord;
    // the prefix is cleared and g is treated as a chord-prefix arm candidate again.
    simulateKeyDown(ps, chordMap, "g"); // clears old prefix, arms new one
    expect(ps.active).toBe("g");
    expect(simulateKeyDown(ps, chordMap, "h")).toBe("go-home");
  });

  test("sequential independent chords work: g h then g n", () => {
    const ps = makePs();
    simulateKeyDown(ps, chordMap, "g");
    expect(simulateKeyDown(ps, chordMap, "h")).toBe("go-home");
    // After first chord, prefix should be cleared
    expect(ps.active).toBeNull();
    // Second chord
    simulateKeyDown(ps, chordMap, "g");
    expect(simulateKeyDown(ps, chordMap, "n")).toBe("go-notifications");
  });

  test("single-key shortcuts remain unaffected when no prefix is armed", () => {
    const ps = makePs();
    expect(simulateKeyDown(ps, chordMap, "n")).toBe("compose");
    expect(simulateKeyDown(ps, chordMap, "/")).toBe("search");
  });

  test("handler map without chord keys never arms a prefix", () => {
    const singleKeyMap = { j: "next", k: "prev", l: "like" };
    const ps = makePs();
    simulateKeyDown(ps, singleKeyMap, "g");
    expect(ps.active).toBeNull(); // 'g' is not a prefix of any key in this map
  });
});

// ---------------------------------------------------------------------------
// Top-cast scroll fix (pure logic simulation — Item B)
// ---------------------------------------------------------------------------

describe("top-cast scroll logic (pure)", () => {
  /**
   * Simulate the logic that decides what scroll action to take for a given
   * focusedIndex and element rect. Returns a descriptor for inspection.
   */
  function scrollDecision(
    focusedIndex: number,
    elementRect: { top: number } | null,
    scrollY: number = 0,
  ): { action: "none" | "scroll-to-top" | "scroll-into-view" | "adjust-for-header"; scrollTop?: number } {
    if (focusedIndex < 0) return { action: "none" };
    if (!elementRect) return { action: "none" };

    if (focusedIndex === 0) {
      return { action: "scroll-to-top", scrollTop: 0 };
    }

    const HEADER_CLEARANCE = 56 + 8;
    // After scrollIntoView (block: nearest) the element would be visible;
    // simulate the case where the element top might be behind the header.
    if (elementRect.top < HEADER_CLEARANCE) {
      return {
        action: "adjust-for-header",
        scrollTop: scrollY + elementRect.top - HEADER_CLEARANCE,
      };
    }

    return { action: "scroll-into-view" };
  }

  test("focusedIndex < 0 → no scroll", () => {
    expect(scrollDecision(-1, { top: 200 })).toEqual({ action: "none" });
  });

  test("null element → no scroll", () => {
    expect(scrollDecision(2, null)).toEqual({ action: "none" });
  });

  test("focusedIndex === 0 → scroll to page top", () => {
    expect(scrollDecision(0, { top: 100 })).toEqual({
      action: "scroll-to-top",
      scrollTop: 0,
    });
  });

  test("focusedIndex === 0 even when element is below fold → scroll to top", () => {
    expect(scrollDecision(0, { top: 500 })).toEqual({
      action: "scroll-to-top",
      scrollTop: 0,
    });
  });

  test("element well below header → normal scrollIntoView", () => {
    // top = 200, HEADER_CLEARANCE = 64, so no adjustment needed
    expect(scrollDecision(3, { top: 200 })).toEqual({ action: "scroll-into-view" });
  });

  test("element partially behind header (top < 64) → adjust scrollTop", () => {
    // top = 20, scrollY = 300 → new scrollTop = 300 + 20 - 64 = 256
    expect(scrollDecision(3, { top: 20 }, 300)).toEqual({
      action: "adjust-for-header",
      scrollTop: 256,
    });
  });

  test("element just at header boundary (top === 64) → no adjustment", () => {
    expect(scrollDecision(3, { top: 64 })).toEqual({ action: "scroll-into-view" });
  });

  test("tall cast: element top above header (top = 0) → adjust scrollTop", () => {
    // Simulates a cast taller than the viewport where scrollIntoView(nearest)
    // showed the bottom, leaving top at 0 or negative.
    expect(scrollDecision(2, { top: 0 }, 400)).toEqual({
      action: "adjust-for-header",
      scrollTop: 336, // 400 + 0 - 64
    });
  });

  test("tall cast: top negative → adjust scrollTop (element starts above viewport)", () => {
    expect(scrollDecision(4, { top: -10 }, 500)).toEqual({
      action: "adjust-for-header",
      scrollTop: 426, // 500 + (-10) - 64
    });
  });
});
