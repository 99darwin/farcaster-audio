import { describe, expect, it } from "@jest/globals";
import { tokenizeCastText } from "../castTextTokens";

const urls = (text: string) =>
  tokenizeCastText(text).filter(
    (segment): segment is Extract<
      ReturnType<typeof tokenizeCastText>[number],
      { type: "url" }
    > => segment.type === "url",
  );

describe("tokenizeCastText", () => {
  it.each([
    ["https://example.com/a?x=1#now", "https://example.com/a?x=1#now"],
    ["example.com/path", "https://example.com/path"],
    ["www.example.technology/demo", "https://www.example.technology/demo"],
    ["sound.xyzabc/play", "https://sound.xyzabc/play"],
    ["127.0.0.1:3000/a", "https://127.0.0.1:3000/a"],
    ["localhost:8080/test", "https://localhost:8080/test"],
  ])("linkifies %s with a safe href", (value, href) => {
    expect(urls(`try ${value}`)).toEqual([{ type: "url", value, href }]);
  });

  it("keeps balanced URL parentheses and excludes prose punctuation", () => {
    const text =
      "See (example.com/a_(mix)/[set]?q={yes}#ok), then go.";
    expect(urls(text)).toEqual([
      {
        type: "url",
        value: "example.com/a_(mix)/[set]?q={yes}#ok",
        href: "https://example.com/a_(mix)/[set]?q={yes}#ok",
      },
    ]);
    expect(tokenizeCastText(text).map((s) => s.value).join("")).toBe(text);
  });

  it("leaves unmatched closing brackets and braces as prose", () => {
    const text = "See example.com/path] and example.com/other}.";
    expect(urls(text)).toEqual([
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
    ]);
    expect(tokenizeCastText(text).map((s) => s.value).join("")).toBe(text);
  });

  it("does not treat a short dotted numeric version as an IPv4 URL", () => {
    expect(tokenizeCastText("1.2.3")).toEqual([
      { type: "text", value: "1.2.3" },
    ]);
    expect(urls("127.0.0.1")).toEqual([
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
    "a@b.com",
    "@dwr.eth",
    "example.com\u0000.evil",
    "999.1.1.1/path",
    "https://example.com:abc/path",
    "release v1.2.3",
  ])("does not link unsafe or non-URL text: %s", (value) => {
    expect(urls(value)).toEqual([]);
  });

  it("keeps a mention clickable without treating it as a domain", () => {
    expect(tokenizeCastText("gm @dwr.eth")).toEqual([
      { type: "text", value: "gm " },
      {
        type: "mention",
        value: "@dwr.eth",
        username: "dwr.eth",
      },
    ]);
  });
});
