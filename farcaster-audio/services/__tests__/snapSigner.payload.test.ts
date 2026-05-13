/**
 * Lock-in tests for the v2 JFS payload shape produced by `signSnapSubmit`.
 *
 * The current Farcaster Snap v2 spec (docs.farcaster.xyz/snap/upgrading)
 * requires `audience`, `user`, and `surface` in the signed payload and
 * states that "v2 snap servers will reject requests that omit these fields."
 * These tests guard against regressing the shape back to the pre-spec-update
 * body that produced 400s in the field.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// --- SecureStore mock (same pattern as snapSigner.cache.test.ts) ---
const secureStore: Record<string, string> = {};
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(async (key: string) =>
    Object.prototype.hasOwnProperty.call(secureStore, key)
      ? secureStore[key]
      : null,
  ),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secureStore[key] = value;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete secureStore[key];
  }),
}));

jest.mock("@/services/api", () => ({
  getSnapSignerStatus: jest.fn(),
  registerSnapSigner: jest.fn(),
  invalidateSnapSigner: jest.fn(),
}));

jest.mock("@/utils/cryptoPolyfill", () => ({}));

jest.mock("@noble/ed25519", () => {
  const fakePub = new Uint8Array(32).fill(7);
  return {
    hashes: {},
    getPublicKey: jest.fn(() => fakePub),
    sign: jest.fn(() => new Uint8Array(64).fill(9)),
    utils: { randomSecretKey: jest.fn(() => new Uint8Array(32).fill(1)) },
  };
});

jest.mock("@noble/hashes/sha2.js", () => ({ sha512: jest.fn() }));

import { signSnapSubmit, type SnapSurface } from "@/services/snapSigner";

const FID = 4242;
const KEY_STORAGE = `snap_signer_key_${FID}`;

/** Decode base64url → UTF-8 string, then JSON.parse. */
function decodeB64UrlJson(b64url: string): Record<string, unknown> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("signSnapSubmit v2 payload shape", () => {
  beforeEach(() => {
    for (const key of Object.keys(secureStore)) delete secureStore[key];
    secureStore[KEY_STORAGE] = "11".repeat(32);
    jest.clearAllMocks();
  });

  it("includes user.fid, audience, and surface; omits nonce", async () => {
    const surface: SnapSurface = {
      type: "cast",
      cast: { hash: "0xabc", author: { fid: FID } },
    };

    const jfs = await signSnapSubmit(
      FID,
      { vote: "yes" },
      { audience: "https://snap.example", surface },
    );

    const payload = decodeB64UrlJson(jfs.payload);

    expect(payload.user).toEqual({ fid: FID });
    expect(payload.audience).toBe("https://snap.example");
    expect(payload.surface).toEqual(surface);
    expect(payload.inputs).toEqual({ vote: "yes" });
    expect(typeof payload.timestamp).toBe("number");
    // Transitional field kept per spec; verifies we didn't drop it.
    expect(payload.fid).toBe(FID);
    // Removed in current spec — guard against regression.
    expect(payload.nonce).toBeUndefined();
    expect(payload.button_index).toBeUndefined();
  });

  it("emits surface={type:'standalone'} when no cast context is provided", async () => {
    const jfs = await signSnapSubmit(
      FID,
      {},
      { audience: "https://snap.example", surface: { type: "standalone" } },
    );

    const payload = decodeB64UrlJson(jfs.payload);
    expect(payload.surface).toEqual({ type: "standalone" });
  });

  it("encodes a JFS header with type=app_key and the ed25519 pubkey", async () => {
    const jfs = await signSnapSubmit(
      FID,
      {},
      { audience: "https://snap.example", surface: { type: "standalone" } },
    );

    const header = decodeB64UrlJson(jfs.header);
    expect(header.type).toBe("app_key");
    expect(header.fid).toBe(FID);
    expect(header.key).toBe(`0x${"07".repeat(32)}`);
  });
});
