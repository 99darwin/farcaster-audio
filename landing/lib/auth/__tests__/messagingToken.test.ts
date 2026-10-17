import { bytesToHex, recoverMessageAddress } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  InvalidMessagingTokenRequestError,
  MESSAGING_TOKEN_TTL_MS,
  assertMessagingTokenRequest,
  buildMessagingTokenRequest,
  canonicalizeAuthRequest,
  encodeEip191Signature,
} from "@/lib/auth/messagingToken";
import {
  CustodyMismatchError,
  FarcasterUserNotFoundError,
  InvalidRecoveryPhraseError,
  fetchCustodyAddress,
  signMessagingToken,
  signSignerLink,
} from "@/lib/auth/protocolLogin";
import { OTHER_MNEMONIC, TEST_FID, TEST_MNEMONIC, buildPrepare } from "./fixtures";

const NOW = new Date("2026-10-16T10:00:00.000Z");
const T = NOW.getTime();
const E = T + MESSAGING_TOKEN_TTL_MS;
const CUSTODY = mnemonicToAccount(TEST_MNEMONIC);

function decodeSignature(encoded: string): `0x${string}` {
  expect(encoded.startsWith("eip191:")).toBe(true);
  const bytes = Uint8Array.from(Buffer.from(encoded.slice("eip191:".length), "base64"));
  expect(bytes).toHaveLength(65);
  return bytesToHex(bytes);
}

describe("canonicalizeAuthRequest", () => {
  it("sorts keys recursively with no whitespace", () => {
    expect(canonicalizeAuthRequest(buildMessagingTokenRequest(NOW))).toBe(
      `{"method":"generateToken","params":{"expiresAt":${E},"timestamp":${T}}}`,
    );
  });

  it("is independent of insertion order", () => {
    expect(canonicalizeAuthRequest({ params: { timestamp: 1, expiresAt: 2 }, method: "m" })).toBe(
      '{"method":"m","params":{"expiresAt":2,"timestamp":1}}',
    );
  });
});

describe("buildMessagingTokenRequest", () => {
  it("asks for a 90-day token in Unix ms", () => {
    expect(buildMessagingTokenRequest(NOW)).toEqual({
      method: "generateToken",
      params: { timestamp: T, expiresAt: T + 90 * 24 * 60 * 60 * 1000 },
    });
  });
});

describe("assertMessagingTokenRequest", () => {
  const valid = buildMessagingTokenRequest(NOW);

  it("accepts the built request", () => {
    expect(() => assertMessagingTokenRequest(valid, NOW)).not.toThrow();
  });

  it.each([
    ["wrong method", { ...valid, method: "signMessage" }],
    ["extra top-level key", { ...valid, extra: 1 }],
    ["extra param", { ...valid, params: { ...valid.params, fid: 1 } }],
    ["missing param", { method: "generateToken", params: { timestamp: T } }],
    ["float timestamp", { ...valid, params: { timestamp: T + 0.5, expiresAt: E } }],
    ["string expiry", { ...valid, params: { timestamp: T, expiresAt: String(E) } }],
    ["stale timestamp", { ...valid, params: { timestamp: T - 3_600_000, expiresAt: E } }],
    ["expiry before timestamp", { ...valid, params: { timestamp: T, expiresAt: T - 1 } }],
    ["expiry beyond 90d", { ...valid, params: { timestamp: T, expiresAt: E + 3_600_000 } }],
    ["not an object", "generateToken"],
    ["params array", { method: "generateToken", params: [T, E] }],
  ])("rejects %s", (_label, request) => {
    expect(() => assertMessagingTokenRequest(request, NOW)).toThrow(
      InvalidMessagingTokenRequestError,
    );
  });
});

describe("encodeEip191Signature", () => {
  it("rejects anything but 65 bytes", () => {
    expect(() => encodeEip191Signature("0x1234")).toThrow(InvalidMessagingTokenRequestError);
  });
});

describe("signMessagingToken", () => {
  it("signs the canonical request with custody", async () => {
    const signed = await signMessagingToken({
      phrase: `  ${TEST_MNEMONIC.toUpperCase()} `,
      fid: TEST_FID,
      custodyAddress: CUSTODY.address.toLowerCase(),
      now: NOW,
    });

    expect(signed.dc_auth_request).toEqual(buildMessagingTokenRequest(NOW));
    const recovered = await recoverMessageAddress({
      message: canonicalizeAuthRequest(signed.dc_auth_request),
      signature: decodeSignature(signed.dc_auth_signature),
    });
    expect(recovered).toBe(CUSTODY.address);
  });

  it("refuses a phrase for another custody address, without echoing it", async () => {
    const attempt = signMessagingToken({
      phrase: OTHER_MNEMONIC,
      fid: TEST_FID,
      custodyAddress: CUSTODY.address,
      now: NOW,
    });
    await expect(attempt).rejects.toBeInstanceOf(CustodyMismatchError);
    const error = await attempt.catch((err: Error) => err);
    for (const word of new Set(OTHER_MNEMONIC.split(" "))) {
      expect(`${(error as Error).message} ${(error as Error).stack}`).not.toMatch(
        new RegExp(`\\b${word}\\b`),
      );
    }
  });

  it("keeps an invalid phrase out of the error", async () => {
    const phrase = "correct horse battery staple zebra quartz";
    const error = await signMessagingToken({
      phrase,
      fid: TEST_FID,
      custodyAddress: CUSTODY.address,
    }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(InvalidRecoveryPhraseError);
    expect(JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack }))
      .not.toMatch(/horse|battery|staple|zebra|quartz/);
  });
});

describe("signSignerLink messaging token", () => {
  it("also signs the generateToken request with custody", async () => {
    const authAddress = privateKeyToAccount(generatePrivateKey()).address;
    const prepare = buildPrepare({ authAddress, nowSeconds: Math.floor(T / 1000) });
    const signed = await signSignerLink({
      fid: TEST_FID,
      authAddress,
      recoveryPhrase: TEST_MNEMONIC,
      prepare,
      now: NOW,
    });
    const { dc_auth_request: request, dc_auth_signature: signature } = signed.messagingToken;
    expect(request).toEqual(buildMessagingTokenRequest(NOW));
    await expect(
      recoverMessageAddress({
        message: canonicalizeAuthRequest(request),
        signature: decodeSignature(signature),
      }),
    ).resolves.toBe(CUSTODY.address);
  });
});

describe("fetchCustodyAddress", () => {
  function respond(status: number, body: unknown) {
    return jest.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it("reads custody from the Hypersnap bulk user read", async () => {
    const fetchImpl = respond(200, { users: [{ fid: TEST_FID, custody_address: CUSTODY.address }] });
    await expect(
      fetchCustodyAddress(TEST_FID, { hypersnapUrl: "https://hs.test", fetchImpl }),
    ).resolves.toBe(CUSTODY.address);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://hs.test/v2/farcaster/user/bulk?fids=${TEST_FID}`,
      expect.anything(),
    );
  });

  it("rejects a missing or malformed custody address", async () => {
    await expect(
      fetchCustodyAddress(TEST_FID, { fetchImpl: respond(200, { users: [] }) }),
    ).rejects.toBeInstanceOf(FarcasterUserNotFoundError);
    await expect(
      fetchCustodyAddress(TEST_FID, { fetchImpl: respond(200, { users: [{ custody_address: "0x12" }] }) }),
    ).rejects.toBeInstanceOf(FarcasterUserNotFoundError);
  });
});
