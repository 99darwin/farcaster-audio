/**
 * signSiwfMessage validity window (M4-clients): a mini app must not be able
 * to obtain a long-lived SIWF signature, nor one with a nonsensical
 * notBefore.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const secureStore: Record<string, string> = {};
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: jest.fn(async (key: string) => secureStore[key] ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secureStore[key] = value;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete secureStore[key];
  }),
}));
jest.mock("@/services/api", () => ({}));

import {
  SIWF_MAX_VALIDITY_MS,
  resolveSiwfValidityWindow,
  signSiwfMessage,
} from "@/services/authAddress";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const FID = 4242;
// Throwaway test key; never used anywhere real.
const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}`;

function isoAfter(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

describe("resolveSiwfValidityWindow", () => {
  it("defaults to a short window when no expiration is requested", () => {
    const { expirationTime, notBefore } = resolveSiwfValidityWindow({}, NOW);
    expect(notBefore).toBeUndefined();
    expect(expirationTime.getTime() - NOW.getTime()).toBe(5 * 60 * 1000);
  });

  it("caps a far-future expiration at the maximum window", () => {
    const { expirationTime } = resolveSiwfValidityWindow(
      { expirationTime: "2099-01-01T00:00:00.000Z" },
      NOW,
    );
    expect(expirationTime.getTime()).toBe(NOW.getTime() + SIWF_MAX_VALIDITY_MS);
  });

  it("keeps a shorter requested expiration as-is", () => {
    const requested = isoAfter(60_000);
    const { expirationTime } = resolveSiwfValidityWindow(
      { expirationTime: requested },
      NOW,
    );
    expect(expirationTime.toISOString()).toBe(requested);
  });

  const invalidWindows: Array<
    [string, { notBefore?: string; expirationTime?: string }]
  > = [
    ["an unparseable expiration", { expirationTime: "not-a-date" }],
    ["an expiration in the past", { expirationTime: isoAfter(-1_000) }],
    ["an unparseable notBefore", { notBefore: "soon" }],
    [
      "a notBefore beyond the maximum window",
      { notBefore: isoAfter(SIWF_MAX_VALIDITY_MS + 1_000) },
    ],
    [
      "a notBefore after the expiration",
      { notBefore: isoAfter(120_000), expirationTime: isoAfter(60_000) },
    ],
  ];
  it.each(invalidWindows)("rejects %s", (_label, input) => {
    expect(() => resolveSiwfValidityWindow(input, NOW)).toThrow();
  });

  it("accepts a notBefore inside the window", () => {
    const { notBefore } = resolveSiwfValidityWindow(
      { notBefore: isoAfter(30_000) },
      NOW,
    );
    expect(notBefore?.toISOString()).toBe(isoAfter(30_000));
  });
});

describe("signSiwfMessage", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    secureStore[`auth_address_key_${FID}`] = TEST_PRIVATE_KEY;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("signs with the capped expiration, not the requested one", async () => {
    const { message } = await signSiwfMessage(FID, {
      nonce: "abcdef1234",
      domain: "example.com",
      expirationTime: "2099-01-01T00:00:00.000Z",
    });
    expect(message).toContain(
      `Expiration Time: ${isoAfter(SIWF_MAX_VALIDITY_MS)}`,
    );
    expect(message).not.toContain("2099");
  });

  it("refuses to sign a message whose notBefore follows its expiration", async () => {
    await expect(
      signSiwfMessage(FID, {
        nonce: "abcdef1234",
        domain: "example.com",
        notBefore: isoAfter(120_000),
        expirationTime: isoAfter(60_000),
      }),
    ).rejects.toThrow("notBefore must precede expirationTime");
  });
});
