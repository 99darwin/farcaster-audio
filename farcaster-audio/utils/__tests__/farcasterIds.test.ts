import { describe, expect, it } from "@jest/globals";
import { isValidCastHash, parseFid } from "@/utils/farcasterIds";

describe("isValidCastHash", () => {
  it.each(["0xabc123", "0xABCDEF0123456789"])("accepts %s", (hash) => {
    expect(isValidCastHash(hash)).toBe(true);
  });

  it.each<unknown>([
    "",
    "0x",
    "abc123",
    "0xabc/../../settings",
    "0xabc?x=1",
    "0xzz",
    123,
    null,
    undefined,
  ])("rejects %p", (hash) => {
    expect(isValidCastHash(hash)).toBe(false);
  });
});

describe("parseFid", () => {
  it("accepts positive integers and decimal strings", () => {
    expect(parseFid(3)).toBe(3);
    expect(parseFid("12345")).toBe(12345);
  });

  it.each<unknown>([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    "007",
    "-3",
    "1e3",
    "12abc",
    "../settings",
    "99999999999999999999",
    "",
    null,
    undefined,
    {},
  ])("rejects %p", (value) => {
    expect(parseFid(value)).toBeNull();
  });
});
