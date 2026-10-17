/**
 * Unit tests for the pure URL extraction helpers in landing/lib/api/og.ts.
 * No network calls — apiFetch is not invoked here.
 */

import { cleanUrl, extractUrls, extractFirstUrl } from "../og";

describe("cleanUrl", () => {
  it("strips trailing period", () => {
    expect(cleanUrl("https://example.com.")).toBe("https://example.com");
  });

  it("strips trailing comma", () => {
    expect(cleanUrl("https://example.com,")).toBe("https://example.com");
  });

  it("strips trailing exclamation mark", () => {
    expect(cleanUrl("https://example.com!")).toBe("https://example.com");
  });

  it("strips trailing closing paren", () => {
    expect(cleanUrl("https://example.com)")).toBe("https://example.com");
  });

  it("strips multiple trailing punctuation chars", () => {
    expect(cleanUrl("https://example.com.,!")).toBe("https://example.com");
  });

  it("does not strip internal punctuation", () => {
    expect(cleanUrl("https://example.com/path/to/page")).toBe(
      "https://example.com/path/to/page",
    );
  });

  it("does not strip query strings", () => {
    expect(cleanUrl("https://example.com/search?q=hello")).toBe(
      "https://example.com/search?q=hello",
    );
  });

  it("preserves URLs with no trailing punctuation", () => {
    expect(cleanUrl("https://example.com")).toBe("https://example.com");
  });
});

describe("extractUrls", () => {
  it("returns empty array for text with no URLs", () => {
    expect(extractUrls("hello world")).toEqual([]);
  });

  it("extracts a single URL", () => {
    expect(extractUrls("check out https://example.com")).toEqual([
      "https://example.com",
    ]);
  });

  it("extracts multiple URLs", () => {
    const text = "see https://a.com and https://b.org for details";
    expect(extractUrls(text)).toEqual(["https://a.com", "https://b.org"]);
  });

  it("strips trailing punctuation from extracted URLs", () => {
    expect(extractUrls("link: https://example.com.")).toEqual([
      "https://example.com",
    ]);
  });

  it("handles http:// URLs", () => {
    expect(extractUrls("http://example.com")).toEqual(["http://example.com"]);
  });

  it("returns empty array for empty string", () => {
    expect(extractUrls("")).toEqual([]);
  });

  it("handles URLs with paths and query strings", () => {
    const text = "visit https://juke.audio/app?ref=test now";
    expect(extractUrls(text)).toEqual(["https://juke.audio/app?ref=test"]);
  });
});

describe("extractFirstUrl", () => {
  it("returns null for text with no URLs", () => {
    expect(extractFirstUrl("no links here")).toBeNull();
  });

  it("returns the first URL when multiple exist", () => {
    const text = "https://first.com and https://second.com";
    expect(extractFirstUrl(text)).toBe("https://first.com");
  });

  it("returns null for empty string", () => {
    expect(extractFirstUrl("")).toBeNull();
  });

  it("strips trailing punctuation from returned URL", () => {
    expect(extractFirstUrl("see https://example.com.")).toBe(
      "https://example.com",
    );
  });

  it("returns the URL even when it is the entire input", () => {
    expect(extractFirstUrl("https://juke.audio")).toBe("https://juke.audio");
  });
});
