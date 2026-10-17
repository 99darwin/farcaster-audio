import { tokenizeCast, type CastSegment } from "../tokenize-cast";

/** Reconstructing the input from segment values must be lossless. */
function roundtrip(text: string): string {
  return tokenizeCast(text)
    .map((s) => s.value)
    .join("");
}

/** Convenience: pluck the segment kinds in order. */
function kinds(text: string): CastSegment["type"][] {
  return tokenizeCast(text).map((s) => s.type);
}

describe("tokenizeCast", () => {
  it("returns a single text segment for plain text", () => {
    expect(tokenizeCast("just some words")).toEqual([
      { type: "text", value: "just some words" },
    ]);
  });

  it("detects an @-mention and exposes the bare username", () => {
    const segs = tokenizeCast("hey @dwr how are you");
    expect(segs).toEqual([
      { type: "text", value: "hey " },
      { type: "mention", value: "@dwr", username: "dwr" },
      { type: "text", value: " how are you" },
    ]);
  });

  it("keeps dotted (ENS-style) handles intact", () => {
    const segs = tokenizeCast("gm @dwr.eth");
    expect(segs[1]).toEqual({
      type: "mention",
      value: "@dwr.eth",
      username: "dwr.eth",
    });
  });

  it("does not treat an email local part as a mention", () => {
    expect(kinds("mail me at a@b.com")).toEqual(["text"]);
  });

  it("detects a /channel reference and exposes the id", () => {
    const segs = tokenizeCast("posted in /base today");
    expect(segs).toEqual([
      { type: "text", value: "posted in " },
      { type: "channel", value: "/base", channelId: "base" },
      { type: "text", value: " today" },
    ]);
  });

  it("recognizes a channel at the start of the text", () => {
    expect(tokenizeCast("/founders is great")[0]).toEqual({
      type: "channel",
      value: "/founders",
      channelId: "founders",
    });
  });

  it("does not treat a mid-word slash as a channel", () => {
    expect(kinds("this and/or that")).toEqual(["text"]);
  });

  it("detects a bare URL and does not split it into a channel", () => {
    const segs = tokenizeCast("see https://example.com/foo/bar end");
    expect(segs).toEqual([
      { type: "text", value: "see " },
      {
        type: "url",
        value: "https://example.com/foo/bar",
        href: "https://example.com/foo/bar",
      },
      { type: "text", value: " end" },
    ]);
  });

  it("handles a mixture of all entity kinds", () => {
    const text = "gm @alice check /degen at https://x.com yo";
    expect(kinds(text)).toEqual([
      "text",
      "mention",
      "text",
      "channel",
      "text",
      "url",
      "text",
    ]);
  });

  it("is lossless — concatenated values reproduce the input", () => {
    const samples = [
      "hey @dwr in /base see https://a.co/x",
      "no entities here",
      "@lead /channel https://end.com",
      "and/or a@b.com plain",
    ];
    for (const s of samples) expect(roundtrip(s)).toBe(s);
  });

  it.each([
    ["example.com/path", "https://example.com/path"],
    ["www.example.technology/demo", "https://www.example.technology/demo"],
    ["sound.xyzabc/play", "https://sound.xyzabc/play"],
    ["127.0.0.1:3000/a", "https://127.0.0.1:3000/a"],
    ["localhost:8080/test", "https://localhost:8080/test"],
  ])("normalizes the bare host %s to HTTPS", (value, href) => {
    expect(tokenizeCast(value)).toEqual([{ type: "url", value, href }]);
  });

  it("keeps balanced URL parentheses and excludes prose punctuation", () => {
    const text =
      "See (example.com/a_(mix)/[set]?q={yes}#ok), then go.";
    expect(tokenizeCast(text)).toContainEqual({
      type: "url",
      value: "example.com/a_(mix)/[set]?q={yes}#ok",
      href: "https://example.com/a_(mix)/[set]?q={yes}#ok",
    });
    expect(roundtrip(text)).toBe(text);
  });

  it("leaves unmatched closing brackets and braces as prose", () => {
    const text = "See example.com/path] and example.com/other}.";
    expect(tokenizeCast(text).filter((segment) => segment.type === "url")).toEqual(
      [
        {
          type: "url",
          value: "example.com/path",
          href: "https://example.com/path",
        },
        {
          type: "url",
          value: "example.com/other",
          href: "https://example.com/other",
        },
      ],
    );
    expect(roundtrip(text)).toBe(text);
  });

  it("does not treat a short dotted numeric version as an IPv4 URL", () => {
    expect(tokenizeCast("1.2.3")).toEqual([
      { type: "text", value: "1.2.3" },
    ]);
    expect(tokenizeCast("127.0.0.1")).toEqual([
      {
        type: "url",
        value: "127.0.0.1",
        href: "https://127.0.0.1",
      },
    ]);
  });

  it.each([
    "javascript:example.com",
    "data://example.com",
    "data:text/html,example.com",
    "ftp://example.com/file",
    "https://user:pass@example.com/private",
    "example.com\u0000.evil",
    "999.1.1.1/path",
    "https://example.com:abc/path",
    "release v1.2.3",
  ])("does not link unsafe URL-shaped text: %s", (value) => {
    expect(tokenizeCast(value).some((segment) => segment.type === "url")).toBe(
      false,
    );
  });
});
