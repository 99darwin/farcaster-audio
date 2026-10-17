/**
 * Tests for the Farcaster-native bearer service.
 *
 * Coverage:
 *   - no deep-link parser is exported (the sync-complete ingestion path is gone)
 *   - the legacy v1 key (only ever written by that untrusted path) is purged
 *   - isExpiringSoon thresholds
 *   - getFarcasterBearer clears expired blobs (upgrade-path corruption safety)
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// --- SecureStore mock ---
const secureStore: Record<string, string> = {};

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlockThisDeviceOnly",
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(async (key: string) => {
    return Object.prototype.hasOwnProperty.call(secureStore, key)
      ? secureStore[key]
      : null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secureStore[key] = value;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete secureStore[key];
  }),
}));

import * as farcasterBearerModule from "@/services/farcasterBearer";
import {
  __TEST_LEGACY_STORAGE_KEY__,
  __TEST_STORAGE_KEY__,
  clearFarcasterBearer,
  getFarcasterBearer,
  hasFarcasterBearer,
  isExpiringSoon,
  setFarcasterBearer,
  type FarcasterBearer,
} from "@/services/farcasterBearer";

function resetStore() {
  for (const key of Object.keys(secureStore)) delete secureStore[key];
}

const FID = 12345;
const SECRET = "test-secret-opaque-token";
// 40-hex-char EVM address (validated by isValidBearer).
const CUSTODY = "0x1234567890abcdef1234567890abcdef12345678";
const INVALID_CUSTODY = "not-an-address";

describe("deep-link ingestion", () => {
  it("exposes no URL-fragment parser that could plant a bearer", () => {
    expect(
      (farcasterBearerModule as Record<string, unknown>).parseBearerFragment,
    ).toBeUndefined();
  });
});

describe("isExpiringSoon", () => {
  const baseBearer: FarcasterBearer = {
    secret: SECRET,
    expiresAt: 0,
    custodyAddress: CUSTODY,
    fid: FID,
  };

  it("returns false for a freshly-minted bearer (7d out)", () => {
    const bearer: FarcasterBearer = {
      ...baseBearer,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
    expect(isExpiringSoon(bearer)).toBe(false);
  });

  it("returns true when 1h from expiry with default 24h threshold", () => {
    const bearer: FarcasterBearer = {
      ...baseBearer,
      expiresAt: Date.now() + 1 * 60 * 60 * 1000,
    };
    expect(isExpiringSoon(bearer)).toBe(true);
  });

  it("returns true for already-expired bearer", () => {
    const bearer: FarcasterBearer = {
      ...baseBearer,
      expiresAt: Date.now() - 1000,
    };
    expect(isExpiringSoon(bearer)).toBe(true);
  });

  it("respects custom withinHours threshold", () => {
    const bearer: FarcasterBearer = {
      ...baseBearer,
      expiresAt: Date.now() + 10 * 60 * 60 * 1000, // 10h out
    };
    expect(isExpiringSoon(bearer, 1)).toBe(false);
    expect(isExpiringSoon(bearer, 24)).toBe(true);
  });
});

describe("storage round-trip", () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it("set + get returns the stored bearer", async () => {
    const bearer: FarcasterBearer = {
      secret: SECRET,
      expiresAt: Date.now() + 60_000,
      custodyAddress: CUSTODY,
      fid: FID,
    };
    await setFarcasterBearer(bearer);
    const got = await getFarcasterBearer();
    expect(got).toEqual(bearer);
  });

  it("hasFarcasterBearer reflects presence", async () => {
    expect(await hasFarcasterBearer()).toBe(false);
    await setFarcasterBearer({
      secret: SECRET,
      expiresAt: Date.now() + 60_000,
      custodyAddress: CUSTODY,
      fid: FID,
    });
    expect(await hasFarcasterBearer()).toBe(true);
  });

  it("clearFarcasterBearer removes the stored bearer", async () => {
    await setFarcasterBearer({
      secret: SECRET,
      expiresAt: Date.now() + 60_000,
      custodyAddress: CUSTODY,
      fid: FID,
    });
    await clearFarcasterBearer();
    expect(await getFarcasterBearer()).toBeNull();
  });

  it("getFarcasterBearer returns null and clears storage on expired bearer", async () => {
    const expired: FarcasterBearer = {
      secret: SECRET,
      expiresAt: Date.now() - 1000,
      custodyAddress: CUSTODY,
      fid: FID,
    };
    // Bypass setFarcasterBearer (which would still write — expired isn't a
    // shape violation) and inject directly to simulate clock skew on hydrate.
    secureStore[__TEST_STORAGE_KEY__] = JSON.stringify(expired);

    const got = await getFarcasterBearer();

    expect(got).toBeNull();
    expect(secureStore[__TEST_STORAGE_KEY__]).toBeUndefined();
  });

  it("getFarcasterBearer clears malformed JSON and returns null", async () => {
    secureStore[__TEST_STORAGE_KEY__] = "{not-valid-json";
    const got = await getFarcasterBearer();
    expect(got).toBeNull();
    expect(secureStore[__TEST_STORAGE_KEY__]).toBeUndefined();
  });

  it("getFarcasterBearer clears wrong-shape payload and returns null", async () => {
    secureStore[__TEST_STORAGE_KEY__] = JSON.stringify({
      secret: SECRET,
      // missing expiresAt, custodyAddress, fid
    });
    const got = await getFarcasterBearer();
    expect(got).toBeNull();
    expect(secureStore[__TEST_STORAGE_KEY__]).toBeUndefined();
  });

  it("purges a legacy v1 bearer and never returns it", async () => {
    secureStore[__TEST_LEGACY_STORAGE_KEY__] = JSON.stringify({
      secret: SECRET,
      expiresAt: Date.now() + 60_000,
      custodyAddress: CUSTODY,
      fid: FID,
    });
    expect(await getFarcasterBearer()).toBeNull();
    expect(secureStore[__TEST_LEGACY_STORAGE_KEY__]).toBeUndefined();
  });

  it("clearFarcasterBearer also removes the legacy v1 key", async () => {
    secureStore[__TEST_LEGACY_STORAGE_KEY__] = "planted";
    await clearFarcasterBearer();
    expect(secureStore[__TEST_LEGACY_STORAGE_KEY__]).toBeUndefined();
  });

  it("setFarcasterBearer rejects an empty secret", async () => {
    await expect(
      setFarcasterBearer({
        secret: "",
        expiresAt: Date.now() + 1000,
        custodyAddress: CUSTODY,
        fid: FID,
      }),
    ).rejects.toThrow(/invalid bearer shape/i);
  });

  it("setFarcasterBearer rejects an invalid custody address", async () => {
    await expect(
      setFarcasterBearer({
        secret: SECRET,
        expiresAt: Date.now() + 1000,
        custodyAddress: INVALID_CUSTODY,
        fid: FID,
      }),
    ).rejects.toThrow(/invalid bearer shape/i);
  });
});
