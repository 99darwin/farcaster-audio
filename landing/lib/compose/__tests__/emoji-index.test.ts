import { EMOJIS } from "../emoji-data";
import { searchEmoji } from "../emoji-index";

describe("searchEmoji", () => {
  it("returns [] for query shorter than 2 characters", () => {
    expect(searchEmoji(EMOJIS, "")).toHaveLength(0);
    expect(searchEmoji(EMOJIS, "f")).toHaveLength(0);
  });

  it("returns exact name match first", () => {
    // 'fire' is an exact name for 🔥
    const results = searchEmoji(EMOJIS, "fire");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].emoji).toBe("🔥");
  });

  it("returns name-prefix matches before keyword-prefix matches", () => {
    // 'sm' should pull 'smile' / 'smiling …' before keyword matches
    const results = searchEmoji(EMOJIS, "sm");
    expect(results.length).toBeGreaterThan(0);
    // All returned names should start with 'sm' OR have keywords starting with 'sm'
    // At minimum, the first result should be a name-prefix match
    const first = results[0].name.toLowerCase();
    expect(first.startsWith("sm")).toBe(true);
  });

  it("respects the limit parameter", () => {
    expect(searchEmoji(EMOJIS, "face", 3)).toHaveLength(3);
    expect(searchEmoji(EMOJIS, "face", 5)).toHaveLength(5);
  });

  it("default limit is 8", () => {
    const results = searchEmoji(EMOJIS, "fa");
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it("returns [] for a query with no matches", () => {
    expect(searchEmoji(EMOJIS, "zzzzqqqq")).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    const lower = searchEmoji(EMOJIS, "fire");
    const upper = searchEmoji(EMOJIS, "FIRE");
    expect(lower.map((r) => r.emoji)).toEqual(upper.map((r) => r.emoji));
  });

  it("returns EmojiResult objects with emoji and name fields", () => {
    const results = searchEmoji(EMOJIS, "heart");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.emoji).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(r.emoji.length).toBeGreaterThan(0);
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  it("works with an empty dataset", () => {
    expect(searchEmoji([], "fire")).toHaveLength(0);
  });

  it("keyword substring match returns results", () => {
    // 'laugh' is a keyword on several emojis
    const results = searchEmoji(EMOJIS, "laugh");
    expect(results.length).toBeGreaterThan(0);
  });
});
