import {
  extractHighlightTerms,
  highlightSegments,
  hitSnippetSegments,
  matchesQuery,
  queryTerms,
  rangeSegments,
  rangeSnippetSegments,
  searchHitTerms,
  snippetAround,
} from "@/lib/messages/highlight";

describe("extractHighlightTerms", () => {
  it("pulls marked phrases out of snippets", () => {
    expect(extractHighlightTerms(["we got <em>pizza</em> and <mark>beer</mark>"])).toEqual(["pizza", "beer"]);
  });

  it("passes plain terms through and dedupes", () => {
    expect(extractHighlightTerms(["pizza", " pizza ", "<b>pizza</b>", ""])).toEqual(["pizza"]);
  });
});

describe("queryTerms", () => {
  it("splits on whitespace", () => {
    expect(queryTerms("  pizza   party ")).toEqual(["pizza", "party"]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("highlightSegments", () => {
  it("marks every case-insensitive occurrence", () => {
    expect(highlightSegments("Pizza and pizza", ["pizza"])).toEqual([
      { text: "Pizza", match: true },
      { text: " and ", match: false },
      { text: "pizza", match: true },
    ]);
  });

  it("prefers the longest term and escapes regex characters", () => {
    expect(highlightSegments("a pizza party (yes)", ["pizza", "pizza party", "(yes)"])).toEqual([
      { text: "a ", match: false },
      { text: "pizza party", match: true },
      { text: " ", match: false },
      { text: "(yes)", match: true },
    ]);
  });

  it("returns the whole text when nothing applies", () => {
    expect(highlightSegments("hello", [])).toEqual([{ text: "hello", match: false }]);
    expect(highlightSegments("hello", ["zzz"])).toEqual([{ text: "hello", match: false }]);
  });
});

describe("matchesQuery", () => {
  it("requires every word", () => {
    expect(matchesQuery("Pizza party tonight", "party pizza")).toBe(true);
    expect(matchesQuery("Pizza party tonight", "pizza beer")).toBe(false);
  });
});

describe("snippetAround", () => {
  it("keeps short text intact", () => {
    expect(snippetAround("short   text", ["text"])).toBe("short text");
  });

  it("windows long text around the first match", () => {
    const text = `${"a ".repeat(100)}needle${" b".repeat(100)}`;
    const snippet = snippetAround(text, ["needle"], 10);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
  });
});

describe("fc_highlight + server ranges", () => {
  it("parses upstream fc_highlight markup", () => {
    expect(extractHighlightTerms(["a <fc_highlight>pizza</fc_highlight> night"])).toEqual(["pizza"]);
  });

  it("prefers matched_terms over snippets", () => {
    expect(searchHitTerms({ matched_terms: ["Pizza"], highlights: ["<em>x</em>"] })).toEqual(["Pizza"]);
    expect(searchHitTerms({ matched_terms: [], highlights: ["<em>x</em>"] })).toEqual(["x"]);
    expect(searchHitTerms({ highlights: ["<fc_highlight>y</fc_highlight>"] })).toEqual(["y"]);
  });

  it("splits text by UTF-16 ranges", () => {
    expect(rangeSegments("I love pizza", [{ start: 7, end: 12 }])).toEqual([
      { text: "I love ", match: false },
      { text: "pizza", match: true },
    ]);
    // "🍕" is two UTF-16 code units.
    expect(rangeSegments("🍕 pizza", [{ start: 3, end: 8 }])).toEqual([
      { text: "🍕 ", match: false },
      { text: "pizza", match: true },
    ]);
  });

  it("clamps out-of-range, empty and overlapping ranges", () => {
    expect(
      rangeSegments("abcdef", [
        { start: 1, end: 3 },
        { start: 2, end: 4 },
        { start: 5, end: 5 },
        { start: 5, end: 99 },
      ]),
    ).toEqual([
      { text: "a", match: false },
      { text: "bc", match: true },
      { text: "d", match: true },
      { text: "e", match: false },
      { text: "f", match: true },
    ]);
    expect(rangeSegments("abc", [])).toEqual([{ text: "abc", match: false }]);
    expect(rangeSegments("", [{ start: 0, end: 2 }])).toEqual([{ text: "", match: false }]);
  });

  it("windows a long message around the first range", () => {
    const text = `${"x".repeat(100)} pizza ${"y".repeat(100)}`;
    const segments = rangeSnippetSegments(text, [{ start: 101, end: 106 }], 10);
    expect(segments[0]).toEqual({ text: "…", match: false });
    expect(segments.find((segment) => segment.match)).toEqual({ text: "pizza", match: true });
    expect(segments.at(-1)).toEqual({ text: "…", match: false });
    expect(segments.map((segment) => segment.text).join("")).toBe(`…${text.slice(91, 111)}…`);
  });

  it("keeps offsets valid across flattened newlines", () => {
    expect(rangeSnippetSegments("a\nb pizza", [{ start: 4, end: 9 }])).toEqual([
      { text: "a b ", match: false },
      { text: "pizza", match: true },
    ]);
  });
});

describe("hitSnippetSegments", () => {
  const message = { text: "Pizza at mine, bring pizza" };

  it("uses highlight_ranges when the server sends them", () => {
    const segments = hitSnippetSegments(
      { message, highlights: [], highlight_ranges: [{ start: 21, end: 26 }] },
      ["pizza"],
    );
    expect(segments.filter((segment) => segment.match)).toEqual([{ text: "pizza", match: true }]);
  });

  it("falls back to matched_terms, then the query terms", () => {
    const fromTerms = hitSnippetSegments({ message, highlights: [], matched_terms: ["mine"] }, ["pizza"]);
    expect(fromTerms.filter((segment) => segment.match).map((segment) => segment.text)).toEqual(["mine"]);
    const fromQuery = hitSnippetSegments({ message, highlights: [] }, ["bring"]);
    expect(fromQuery.filter((segment) => segment.match).map((segment) => segment.text)).toEqual(["bring"]);
  });
});
