import { extractToken, insertCompletion } from "../token-autocomplete";

// ---------------------------------------------------------------------------
// extractToken — @ mentions
// ---------------------------------------------------------------------------

describe("extractToken — @", () => {
  it("returns null for empty text", () => {
    expect(extractToken("", 0, "@")).toBeNull();
  });

  it("extracts a mention at start of text", () => {
    const text = "@alice";
    expect(extractToken(text, text.length, "@")).toEqual({
      query: "alice",
      start: 0,
    });
  });

  it("extracts a mention after a space", () => {
    const text = "hello @al";
    expect(extractToken(text, text.length, "@")).toEqual({
      query: "al",
      start: 6,
    });
  });

  it("returns null for @ inside a word (email guard)", () => {
    // The @ is NOT preceded by whitespace → must return null
    const text = "nick@example.com";
    expect(extractToken(text, text.length, "@")).toBeNull();
  });

  it("returns null when cursor is mid-word with a space gap", () => {
    // Cursor is at 'hello @alice|  world' but there's a space before alice
    // Actually the space aborts walking back — 'alice' doesn't contain a trigger
    const text = "hello @alice world";
    // Cursor at end — now in 'world' with a space before it; no @ trigger
    expect(extractToken(text, text.length, "@")).toBeNull();
  });

  it("extracts an empty query when cursor is immediately after @", () => {
    const text = "@";
    expect(extractToken(text, 1, "@")).toEqual({ query: "", start: 0 });
  });

  it("returns null for whitespace in query", () => {
    const text = "@ alice";
    // cursor at 7, walking back hits space before 'alice' → null
    expect(extractToken(text, text.length, "@")).toBeNull();
  });

  it("handles underscores and dots in query", () => {
    const text = "@nick.eth_handle";
    expect(extractToken(text, text.length, "@")).toEqual({
      query: "nick.eth_handle",
      start: 0,
    });
  });

  it("partial cursor in the middle of a mention", () => {
    const text = "@alice bob";
    // cursor at 3 → query is "al"
    expect(extractToken(text, 3, "@")).toEqual({ query: "al", start: 0 });
  });
});

// ---------------------------------------------------------------------------
// extractToken — / channels
// ---------------------------------------------------------------------------

describe("extractToken — /", () => {
  it("extracts channel at start of text", () => {
    const text = "/dev";
    expect(extractToken(text, text.length, "/")).toEqual({
      query: "dev",
      start: 0,
    });
  });

  it("extracts channel after space", () => {
    const text = "posting in /farcaster";
    expect(extractToken(text, text.length, "/")).toEqual({
      query: "farcaster",
      start: 11,
    });
  });

  it("returns null for / in URL (no preceding whitespace)", () => {
    const text = "https://example.com/path";
    expect(extractToken(text, text.length, "/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractToken — : emoji
// ---------------------------------------------------------------------------

describe("extractToken — :", () => {
  it("extracts emoji shortcode at start of text", () => {
    const text = ":fire";
    expect(extractToken(text, text.length, ":")).toEqual({
      query: "fire",
      start: 0,
    });
  });

  it("extracts emoji shortcode mid-sentence", () => {
    const text = "great :fire";
    expect(extractToken(text, text.length, ":")).toEqual({
      query: "fire",
      start: 6,
    });
  });

  it("returns null for : inside a URL (no preceding whitespace)", () => {
    const text = "https://example.com";
    expect(extractToken(text, text.length, ":")).toBeNull();
  });

  it("allows case-insensitive charset", () => {
    const text = ":FIRE";
    expect(extractToken(text, text.length, ":")).toEqual({
      query: "FIRE",
      start: 0,
    });
  });

  it("allows + and - in emoji query", () => {
    const text = ":thumbs+up";
    expect(extractToken(text, text.length, ":")).toEqual({
      query: "thumbs+up",
      start: 0,
    });
  });

  it("returns null for spaces in query", () => {
    const text = ": fire";
    expect(extractToken(text, text.length, ":")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertCompletion
// ---------------------------------------------------------------------------

describe("insertCompletion", () => {
  // Callers are responsible for including the trigger prefix in `inserted`
  // for mention/channel; emoji completions use the raw glyph (no colon).

  it("replaces the token at the start of text (mention)", () => {
    const text = "@al";
    // Caller passes "@alice" — the trigger prefix is part of the replacement.
    const result = insertCompletion(text, 0, text.length, "@alice");
    expect(result.text).toBe("@alice ");
    expect(result.cursor).toBe(7);
  });

  it("replaces the token mid-sentence, preserves trailing text (mention)", () => {
    const text = "hello @al world";
    const tokenStart = 6;
    const cursor = 9; // after "@al"
    const result = insertCompletion(text, tokenStart, cursor, "@alice");
    // "hello " + "@alice " + " world" — the appended space + the existing space
    // before "world" are both preserved, matching natural editor behaviour.
    expect(result.text).toBe("hello @alice  world");
    // Cursor lands after "@alice "
    expect(result.cursor).toBe(13);
  });

  it("works for channel trigger", () => {
    const text = "/dev";
    const result = insertCompletion(text, 0, text.length, "/developers");
    expect(result.text).toBe("/developers ");
    expect(result.cursor).toBe(12);
  });

  it("appends trailing space after completion", () => {
    const result = insertCompletion("@a", 0, 2, "@alice");
    expect(result.text.endsWith(" ")).toBe(true);
  });

  // ── Emoji regression — colon must NOT survive ───────────────────────────
  // Bug: the old implementation prepended the trigger char to `inserted`,
  // producing ":🔥 " instead of "🔥 " for emoji completions.

  it("emoji: selecting 🔥 from :fire yields '🔥 ' with no colon", () => {
    // Simulate: user typed ":fire", cursor at end, tokenStart = 0.
    const text = ":fire";
    const result = insertCompletion(text, 0, text.length, "🔥");
    expect(result.text).toBe("🔥 ");
    expect(result.cursor).toBe(3); // "🔥 " is 2 code units + 1 space = 3 chars in JS
  });

  it("emoji: selecting mid-sentence leaves no colon in output", () => {
    const text = "great :fire";
    // tokenStart = 6 (the colon), cursor = 11 (after "fire")
    const result = insertCompletion(text, 6, text.length, "🔥");
    expect(result.text).toBe("great 🔥 ");
    expect(result.text).not.toContain(":");
  });

  it("emoji: selecting from :thumbs_up mid-text preserves surrounding text", () => {
    const text = ":thumbs_up done";
    // tokenStart = 0, cursor = 10 (after ":thumbs_up"), trailing " done"
    const result = insertCompletion(text, 0, 10, "👍");
    expect(result.text).toBe("👍  done");
    expect(result.text.startsWith("👍")).toBe(true);
  });
});
