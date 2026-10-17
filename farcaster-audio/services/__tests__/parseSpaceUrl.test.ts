/**
 * Tests for `parseFarcasterSpaceUrl`.
 *
 * The regex inside the parser is the security gate for the in-Juke
 * cast-embed flow: any URL that matches gets fed to
 * `linkFarcasterRoom` + `router.push(...)`. Anything that doesn't
 * match falls back to the generic link-out behaviour. Coverage here
 * focuses on the boundary cases.
 */

import { describe, it, expect } from "@jest/globals";
import { parseFarcasterSpaceUrl } from "../parseSpaceUrl";

const V4_UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const V4_UUID_UPPER = "9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D";
// Farcaster v7-style id (lowercase) — actual examples from
// client.farcaster.xyz traces.
const V7_LOWER = "019e7436-9abf-6395-ff65-c6eb7b3a8d89";

describe("parseFarcasterSpaceUrl", () => {
  it("extracts a lowercased v4 UUID", () => {
    expect(parseFarcasterSpaceUrl(`https://farcaster.xyz/~/spaces/${V4_UUID}`)).toEqual({
      id: V4_UUID,
    });
  });

  it("lowercases an uppercase UUID", () => {
    const out = parseFarcasterSpaceUrl(
      `https://farcaster.xyz/~/spaces/${V4_UUID_UPPER}`,
    );
    expect(out).toEqual({ id: V4_UUID });
  });

  it("extracts a lowercase v7-style UUID", () => {
    expect(parseFarcasterSpaceUrl(`https://farcaster.xyz/~/spaces/${V7_LOWER}`)).toEqual({
      id: V7_LOWER,
    });
  });

  it("accepts a trailing slash", () => {
    expect(parseFarcasterSpaceUrl(`https://farcaster.xyz/~/spaces/${V7_LOWER}/`)).toEqual({
      id: V7_LOWER,
    });
  });

  it("accepts a www. prefix", () => {
    expect(
      parseFarcasterSpaceUrl(`https://www.farcaster.xyz/~/spaces/${V7_LOWER}`),
    ).toEqual({ id: V7_LOWER });
  });

  it("accepts http:// (some clients link without TLS)", () => {
    expect(parseFarcasterSpaceUrl(`http://farcaster.xyz/~/spaces/${V7_LOWER}`)).toEqual({
      id: V7_LOWER,
    });
  });

  it("returns null for non-uuid path segment", () => {
    expect(
      parseFarcasterSpaceUrl("https://farcaster.xyz/~/spaces/not-a-uuid"),
    ).toBeNull();
  });

  it("returns null for malformed UUID (wrong segment lengths)", () => {
    expect(
      parseFarcasterSpaceUrl(
        "https://farcaster.xyz/~/spaces/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6", // last segment short
      ),
    ).toBeNull();
  });

  it("returns null for a different host (warpcast.com)", () => {
    expect(
      parseFarcasterSpaceUrl(`https://warpcast.com/~/spaces/${V7_LOWER}`),
    ).toBeNull();
  });

  it("returns null for a path with extra trailing segments", () => {
    expect(
      parseFarcasterSpaceUrl(
        `https://farcaster.xyz/~/spaces/${V7_LOWER}/listeners`,
      ),
    ).toBeNull();
  });

  it("returns null for a subdomain takeover attempt", () => {
    expect(
      parseFarcasterSpaceUrl(
        `https://farcaster.xyz.attacker.com/~/spaces/${V7_LOWER}`,
      ),
    ).toBeNull();
  });

  it("returns null for empty / undefined input", () => {
    expect(parseFarcasterSpaceUrl(undefined)).toBeNull();
    expect(parseFarcasterSpaceUrl("")).toBeNull();
  });

  it("returns null for a non-spaces farcaster path", () => {
    expect(
      parseFarcasterSpaceUrl(`https://farcaster.xyz/~/channel/${V7_LOWER}`),
    ).toBeNull();
  });
});
