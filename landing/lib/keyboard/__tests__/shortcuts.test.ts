/**
 * Unit tests for landing/lib/keyboard/shortcuts.ts
 *
 * Node environment — no jsdom. We construct minimal fake objects rather than
 * relying on real DOM APIs.
 */

import {
  isTypingTarget,
  matchShortcut,
  SHORTCUTS,
  SHORTCUT_MAP,
  type ShortcutBinding,
} from "../shortcuts";

// ---------------------------------------------------------------------------
// Helpers — minimal fake element / event objects
// ---------------------------------------------------------------------------

function fakeElement(
  tagName: string,
  extras: Partial<{ isContentEditable: boolean }> = {},
): EventTarget {
  return {
    tagName,
    isContentEditable: extras.isContentEditable ?? false,
  } as unknown as EventTarget;
}

function fakeEvent(key: string): Pick<KeyboardEvent, "key"> {
  return { key };
}

// ---------------------------------------------------------------------------
// isTypingTarget
// ---------------------------------------------------------------------------

describe("isTypingTarget", () => {
  test("returns false for null", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  test("returns false for a non-element object with no tagName", () => {
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });

  test("returns true for INPUT", () => {
    expect(isTypingTarget(fakeElement("INPUT"))).toBe(true);
  });

  test("returns true for input (lower-case tagName)", () => {
    expect(isTypingTarget(fakeElement("input"))).toBe(true);
  });

  test("returns true for TEXTAREA", () => {
    expect(isTypingTarget(fakeElement("TEXTAREA"))).toBe(true);
  });

  test("returns true for SELECT", () => {
    expect(isTypingTarget(fakeElement("SELECT"))).toBe(true);
  });

  test("returns false for DIV that is not contentEditable", () => {
    expect(isTypingTarget(fakeElement("DIV", { isContentEditable: false }))).toBe(false);
  });

  test("returns true for DIV with isContentEditable = true", () => {
    expect(isTypingTarget(fakeElement("DIV", { isContentEditable: true }))).toBe(true);
  });

  test("returns false for BUTTON", () => {
    expect(isTypingTarget(fakeElement("BUTTON"))).toBe(false);
  });

  test("returns false for A", () => {
    expect(isTypingTarget(fakeElement("A"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchShortcut
// ---------------------------------------------------------------------------

describe("matchShortcut", () => {
  const binding: ShortcutBinding = { keys: ["j", "J"] };

  test("matches when the key equals one of the binding keys (same case)", () => {
    expect(matchShortcut(fakeEvent("j"), binding)).toBe(true);
  });

  test("is case-insensitive — 'J' matches binding key 'j'", () => {
    expect(matchShortcut(fakeEvent("J"), { keys: ["j"] })).toBe(true);
  });

  test("returns false when the key is not in the binding", () => {
    expect(matchShortcut(fakeEvent("k"), binding)).toBe(false);
  });

  test("matches special keys like 'Escape'", () => {
    const escBinding: ShortcutBinding = { keys: ["Escape"] };
    expect(matchShortcut(fakeEvent("Escape"), escBinding)).toBe(true);
  });

  test("matches '?' shortcut", () => {
    const helpBinding: ShortcutBinding = { keys: ["?"] };
    expect(matchShortcut(fakeEvent("?"), helpBinding)).toBe(true);
  });

  test("matches '/' shortcut", () => {
    const searchBinding: ShortcutBinding = { keys: ["/"] };
    expect(matchShortcut(fakeEvent("/"), searchBinding)).toBe(true);
  });

  test("multi-key binding — n or c", () => {
    const composeBinding: ShortcutBinding = { keys: ["n", "c"] };
    expect(matchShortcut(fakeEvent("n"), composeBinding)).toBe(true);
    expect(matchShortcut(fakeEvent("c"), composeBinding)).toBe(true);
    expect(matchShortcut(fakeEvent("x"), composeBinding)).toBe(false);
  });

  test("returns false for empty keys array", () => {
    expect(matchShortcut(fakeEvent("j"), { keys: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SHORTCUTS table integrity
// ---------------------------------------------------------------------------

describe("SHORTCUTS table", () => {
  test("contains at least 10 entries", () => {
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(10);
  });

  test("every entry has a non-empty action, keys array, description, and group", () => {
    for (const s of SHORTCUTS) {
      expect(s.action).toBeTruthy();
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.description).toBeTruthy();
      expect(["Navigation", "Actions", "Compose"]).toContain(s.group);
    }
  });

  test("action identifiers are unique", () => {
    const actions = SHORTCUTS.map((s) => s.action);
    const unique = new Set(actions);
    expect(unique.size).toBe(actions.length);
  });

  test("navigation shortcuts include j/k/Enter", () => {
    const navActions = SHORTCUTS.filter((s) => s.group === "Navigation").map(
      (s) => s.action,
    );
    expect(navActions).toContain("next");
    expect(navActions).toContain("prev");
    expect(navActions).toContain("open");
  });

  test("action shortcuts include l/r/t/b", () => {
    const actionActions = SHORTCUTS.filter((s) => s.group === "Actions").map(
      (s) => s.action,
    );
    expect(actionActions).toContain("like");
    expect(actionActions).toContain("reply");
    expect(actionActions).toContain("recast");
    expect(actionActions).toContain("bookmark");
  });

  test("compose shortcuts include compose / search / help / escape", () => {
    const composeActions = SHORTCUTS.filter((s) => s.group === "Compose").map(
      (s) => s.action,
    );
    expect(composeActions).toContain("compose");
    expect(composeActions).toContain("search");
    expect(composeActions).toContain("help");
    expect(composeActions).toContain("escape");
  });

  test("help and escape shortcuts have allowInDialog = true", () => {
    expect(SHORTCUT_MAP["help"]?.allowInDialog).toBe(true);
    expect(SHORTCUT_MAP["escape"]?.allowInDialog).toBe(true);
  });

  test("navigation shortcuts do NOT have allowInDialog", () => {
    expect(SHORTCUT_MAP["next"]?.allowInDialog).toBeFalsy();
    expect(SHORTCUT_MAP["prev"]?.allowInDialog).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// SHORTCUT_MAP
// ---------------------------------------------------------------------------

describe("SHORTCUT_MAP", () => {
  test("keys in SHORTCUT_MAP match SHORTCUTS actions", () => {
    const fromTable = new Set(SHORTCUTS.map((s) => s.action));
    const fromMap = new Set(Object.keys(SHORTCUT_MAP));
    expect(fromMap).toEqual(fromTable);
  });

  test("compose action maps to key n only", () => {
    expect(SHORTCUT_MAP["compose"]?.keys).toEqual(["n"]);
  });
});
