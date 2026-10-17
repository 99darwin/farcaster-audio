import {
  CAST_LENGTH_DEFAULT,
  CAST_LENGTH_PRO,
  MAX_IMAGES_DEFAULT,
  MAX_IMAGES_PRO,
  COUNTER_COLOR_DEFAULT,
  COUNTER_COLOR_OVER,
  COUNTER_COLOR_WARNING,
  buildCastPayload,
  buildThreadPayload,
  castMaxLength,
  counterColorClass,
  maxImageCount,
  newAttachmentId,
  utf8ByteLength,
} from "@/lib/compose/composer-utils";
import type { ComposeTarget } from "@/lib/stores/composeStore";

const TARGET: ComposeTarget = {
  hash: "0xabc",
  author: {
    fid: 42,
    username: "alice",
    display_name: "Alice",
    pfp_url: null,
  },
};

describe("castMaxLength / maxImageCount", () => {
  it("returns the standard limits for a non-pro account", () => {
    expect(castMaxLength(false)).toBe(CAST_LENGTH_DEFAULT);
    expect(maxImageCount(false)).toBe(MAX_IMAGES_DEFAULT);
  });

  it("returns the pro limits for a pro account", () => {
    expect(castMaxLength(true)).toBe(CAST_LENGTH_PRO);
    expect(maxImageCount(true)).toBe(MAX_IMAGES_PRO);
  });
});

describe("buildCastPayload", () => {
  it("builds a bare cast payload with trimmed text and no extras", () => {
    expect(buildCastPayload("  hello  ", "cast", null, [])).toEqual({
      text: "hello",
    });
  });

  it("sets parent for a reply", () => {
    expect(buildCastPayload("hi", "reply", TARGET, [])).toEqual({
      text: "hi",
      parent: "0xabc",
    });
  });

  it("sets quote { fid, hash } for a quote", () => {
    expect(buildCastPayload("hi", "quote", TARGET, [])).toEqual({
      text: "hi",
      quote: { fid: 42, hash: "0xabc" },
    });
  });

  it("includes embeds only when at least one is present", () => {
    expect(buildCastPayload("hi", "cast", null, ["https://a.png"])).toEqual({
      text: "hi",
      embeds: ["https://a.png"],
    });
    expect(buildCastPayload("hi", "cast", null, [])).not.toHaveProperty(
      "embeds",
    );
  });

  it("ignores the target when the mode is a top-level cast", () => {
    const payload = buildCastPayload("hi", "cast", TARGET, []);
    expect(payload).not.toHaveProperty("parent");
    expect(payload).not.toHaveProperty("quote");
  });

  it("does not set parent/quote when target is missing", () => {
    expect(buildCastPayload("hi", "reply", null, [])).toEqual({ text: "hi" });
    expect(buildCastPayload("hi", "quote", undefined, [])).toEqual({
      text: "hi",
    });
  });

  it("serializes keys in a stable order (text, parent, quote, embeds)", () => {
    const payload = buildCastPayload("hi", "reply", TARGET, ["https://a.png"]);
    expect(Object.keys(payload)).toEqual(["text", "parent", "embeds"]);
  });
});

describe("buildThreadPayload", () => {
  it("builds an ordered casts list with trimmed text and no extras", () => {
    expect(
      buildThreadPayload(
        [
          { text: "  first  ", embeds: [] },
          { text: "second", embeds: [] },
        ],
        "cast",
        null,
      ),
    ).toEqual({
      casts: [{ text: "first" }, { text: "second" }],
    });
  });

  it("sets the top-level parent for a reply thread", () => {
    const payload = buildThreadPayload(
      [
        { text: "a", embeds: [] },
        { text: "b", embeds: [] },
      ],
      "reply",
      TARGET,
    );
    expect(payload.parent).toBe("0xabc");
    expect(payload.casts.every((c) => !("parent" in c))).toBe(true);
  });

  it("puts the quote on the FIRST segment only", () => {
    const payload = buildThreadPayload(
      [
        { text: "a", embeds: [] },
        { text: "b", embeds: [] },
      ],
      "quote",
      TARGET,
    );
    expect(payload.casts[0].quote).toEqual({ fid: 42, hash: "0xabc" });
    expect(payload.casts[1]).not.toHaveProperty("quote");
    expect(payload).not.toHaveProperty("parent");
  });

  it("includes per-cast embeds only when at least one is present", () => {
    const payload = buildThreadPayload(
      [
        { text: "a", embeds: ["https://a.png"] },
        { text: "b", embeds: [] },
      ],
      "cast",
      null,
    );
    expect(payload.casts[0].embeds).toEqual(["https://a.png"]);
    expect(payload.casts[1]).not.toHaveProperty("embeds");
  });

  it("ignores the target for a top-level cast thread", () => {
    const payload = buildThreadPayload(
      [
        { text: "a", embeds: [] },
        { text: "b", embeds: [] },
      ],
      "cast",
      TARGET,
    );
    expect(payload).not.toHaveProperty("parent");
    expect(payload.casts[0]).not.toHaveProperty("quote");
  });

  it("does not set parent/quote when target is missing", () => {
    expect(
      buildThreadPayload([{ text: "a", embeds: [] }], "reply", null),
    ).toEqual({ casts: [{ text: "a" }] });
    expect(
      buildThreadPayload([{ text: "a", embeds: [] }], "quote", undefined),
    ).toEqual({ casts: [{ text: "a" }] });
  });

  it("serializes keys in a stable order (text, quote, embeds; casts, parent)", () => {
    const payload = buildThreadPayload(
      [
        { text: "a", embeds: ["https://a.png"] },
        { text: "b", embeds: [] },
      ],
      "quote",
      TARGET,
    );
    expect(Object.keys(payload)).toEqual(["casts"]);
    expect(Object.keys(payload.casts[0])).toEqual(["text", "quote", "embeds"]);

    const reply = buildThreadPayload(
      [
        { text: "a", embeds: [] },
        { text: "b", embeds: [] },
      ],
      "reply",
      TARGET,
    );
    expect(Object.keys(reply)).toEqual(["casts", "parent"]);
  });
});

describe("counterColorClass", () => {
  it("is the default colour with plenty of room", () => {
    expect(counterColorClass(300)).toBe(COUNTER_COLOR_DEFAULT);
    expect(counterColorClass(21)).toBe(COUNTER_COLOR_DEFAULT);
  });

  it("warns at or under the threshold", () => {
    expect(counterColorClass(20)).toBe(COUNTER_COLOR_WARNING);
    expect(counterColorClass(0)).toBe(COUNTER_COLOR_WARNING);
  });

  it("turns over-limit red", () => {
    expect(counterColorClass(-1)).toBe(COUNTER_COLOR_OVER);
  });
});

describe("utf8ByteLength", () => {
  it("matches TextEncoder for ASCII, multibyte, and emoji input", () => {
    const samples = [
      "",
      "hello world",
      "héllo wörld",
      "日本語のキャスト",
      "🎵🎶🔥",
      "mixed ascii 🎧 and é",
    ];
    for (const sample of samples) {
      expect(utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).length);
    }
  });

  it("counts a lone surrogate as 3 bytes (U+FFFD replacement)", () => {
    expect(utf8ByteLength("\ud800")).toBe(3);
    expect(utf8ByteLength("\udfff")).toBe(3);
  });
});

describe("newAttachmentId", () => {
  it("returns a non-empty, unique string", () => {
    const a = newAttachmentId();
    const b = newAttachmentId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
