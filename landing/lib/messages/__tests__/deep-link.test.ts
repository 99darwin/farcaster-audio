import { decodeConversationParam, directMessageHref, parseFidParam } from "@/lib/messages/deep-link";

describe("parseFidParam", () => {
  it("accepts positive integers", () => {
    expect(parseFidParam("3")).toBe(3);
    expect(parseFidParam(" 194 ")).toBe(194);
  });

  it("rejects missing, zero, negative, fractional and junk values", () => {
    for (const value of [null, undefined, "", "0", "-1", "1.5", "1e3", "abc", "12abc", "99999999999999999999"]) {
      expect(parseFidParam(value)).toBeNull();
    }
  });

  it("builds the deep link", () => {
    expect(directMessageHref(42)).toBe("/app/messages/new?fid=42");
  });
});

describe("decodeConversationParam", () => {
  it("decodes well-formed segments", () => {
    expect(decodeConversationParam("abc123")).toBe("abc123");
    expect(decodeConversationParam("1-2%3A3")).toBe("1-2:3");
  });

  it("returns null for malformed escapes instead of throwing a URIError", () => {
    for (const value of ["%", "%E0%A4%A", "abc%zz", "%C0"]) {
      expect(() => decodeConversationParam(value)).not.toThrow();
      expect(decodeConversationParam(value)).toBeNull();
    }
  });

  it("returns null for missing or blank segments", () => {
    for (const value of [null, undefined, "", "%20"]) {
      expect(decodeConversationParam(value)).toBeNull();
    }
  });
});
