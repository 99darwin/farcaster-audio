import {
  extractHandle,
  extractTweetText,
  hasTweetContent,
  parseTweetOembed,
} from "../oembed";

// A representative Twitter oembed blockquote as the v2 read API returns it.
const SAMPLE_HTML =
  '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">' +
  "Ethereum is for everyone &amp; anyone.<br>Read more: " +
  '<a href="https://t.co/abc">t.co/abc</a> &lt;3</p>&mdash; ' +
  'Vitalik (@VitalikButerin) <a href="https://twitter.com/x/status/1">May 1</a>' +
  "</blockquote>";

describe("extractTweetText", () => {
  it("strips tags, unwraps anchors, decodes entities, converts <br>", () => {
    expect(extractTweetText(SAMPLE_HTML)).toBe(
      "Ethereum is for everyone & anyone.\nRead more: t.co/abc <3",
    );
  });

  it("returns undefined when there is no paragraph", () => {
    expect(extractTweetText("<blockquote>no p here</blockquote>")).toBeUndefined();
    expect(extractTweetText(undefined)).toBeUndefined();
    expect(extractTweetText("")).toBeUndefined();
  });

  it("does not leave any HTML tags in the output (no injection surface)", () => {
    const malicious =
      '<p>hello <img src=x onerror="alert(1)"> <script>alert(2)</script>world</p>';
    const out = extractTweetText(malicious);
    expect(out).toBeDefined();
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("decodes an entity to a literal char without creating markup", () => {
    // &lt;b&gt; decodes to the literal string "<b>" — a plain string, not a tag.
    const out = extractTweetText("<p>a &lt;b&gt; c</p>");
    expect(out).toBe("a <b> c");
  });

  it("collapses to undefined when the paragraph is only markup", () => {
    expect(extractTweetText("<p><br></p>")).toBeUndefined();
  });
});

describe("extractHandle", () => {
  it("derives the handle from a twitter author url", () => {
    expect(extractHandle("https://twitter.com/VitalikButerin")).toBe(
      "VitalikButerin",
    );
    expect(extractHandle("https://x.com/jack")).toBe("jack");
  });

  it("rejects non-handle path segments and bad urls", () => {
    expect(extractHandle("https://x.com/i/status/12345")).toBeUndefined();
    expect(extractHandle("https://x.com/")).toBeUndefined();
    expect(extractHandle("not a url")).toBeUndefined();
    expect(extractHandle(undefined)).toBeUndefined();
  });
});

describe("parseTweetOembed", () => {
  it("parses a full oembed record", () => {
    const parsed = parseTweetOembed({
      type: "rich",
      html: SAMPLE_HTML,
      author_name: "Vitalik Buterin",
      author_url: "https://twitter.com/VitalikButerin",
    });
    expect(parsed.author).toBe("Vitalik Buterin");
    expect(parsed.handle).toBe("VitalikButerin");
    expect(parsed.authorUrl).toBe("https://twitter.com/VitalikButerin");
    expect(parsed.text).toContain("Ethereum is for everyone");
    expect(hasTweetContent(parsed)).toBe(true);
  });

  it("drops a non-https author url", () => {
    const parsed = parseTweetOembed({
      author_name: "x",
      author_url: "http://twitter.com/x",
    });
    expect(parsed.authorUrl).toBeUndefined();
    // handle is still derivable from the (unsafe) url's path
    expect(parsed.handle).toBe("x");
  });

  it("returns empty for missing input", () => {
    expect(hasTweetContent(parseTweetOembed(undefined))).toBe(false);
    expect(hasTweetContent(parseTweetOembed({}))).toBe(false);
  });
});
