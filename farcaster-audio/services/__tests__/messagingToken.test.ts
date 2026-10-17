import { describe, expect, it } from "@jest/globals";
import { recoverMessageAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  assertMessagingTokenRequest,
  buildMessagingTokenRequest,
  canonicalizeAuthRequest,
  encodeEip191Signature,
  InvalidMessagingTokenRequestError,
  MESSAGING_TOKEN_TTL_MS,
  signMessagingTokenRequest,
} from "@/services/messagingToken";
import {
  decodeEip191,
  FIXED_NOW,
  TEST_CUSTODY,
  TEST_PHRASE,
} from "@/services/__fixtures__/signerLink";

const NOW_MS = FIXED_NOW.getTime();

describe("messagingToken", () => {
  it("builds a 90-day generateToken request in ms", () => {
    expect(buildMessagingTokenRequest(FIXED_NOW)).toEqual({
      method: "generateToken",
      params: { timestamp: NOW_MS, expiresAt: NOW_MS + MESSAGING_TOKEN_TTL_MS },
    });
  });

  it("canonicalizes with sorted keys and no whitespace", () => {
    expect(
      canonicalizeAuthRequest({
        params: { timestamp: 1, expiresAt: 2 },
        method: "generateToken",
      }),
    ).toBe('{"method":"generateToken","params":{"expiresAt":2,"timestamp":1}}');
  });

  it("signs the canonical bytes with custody (EIP-191)", async () => {
    const account = mnemonicToAccount(TEST_PHRASE);
    const body = await signMessagingTokenRequest(account, FIXED_NOW);
    await expect(
      recoverMessageAddress({
        message: canonicalizeAuthRequest(body.dc_auth_request),
        signature: decodeEip191(body.dc_auth_signature),
      }),
    ).resolves.toBe(TEST_CUSTODY);
    expect(body.dc_auth_signature).toMatch(/^eip191:[A-Za-z0-9+/]+={0,2}$/);
  });

  it.each([
    ["shape", { method: "generateToken" }],
    ["extra key", { method: "generateToken", params: { timestamp: NOW_MS, expiresAt: NOW_MS + 1 }, x: 1 }],
    ["method", { method: "sendDirectCast", params: { timestamp: NOW_MS, expiresAt: NOW_MS + 1 } }],
    ["params", { method: "generateToken", params: { timestamp: NOW_MS } }],
    ["non-integer", { method: "generateToken", params: { timestamp: NOW_MS + 0.5, expiresAt: NOW_MS + 1 } }],
    ["stale", { method: "generateToken", params: { timestamp: NOW_MS - 120_000, expiresAt: NOW_MS + 1 } }],
    ["inverted", { method: "generateToken", params: { timestamp: NOW_MS, expiresAt: NOW_MS } }],
    [
      "beyond 90d",
      { method: "generateToken", params: { timestamp: NOW_MS, expiresAt: NOW_MS + MESSAGING_TOKEN_TTL_MS + 120_000 } },
    ],
  ])("refuses a malformed request (%s)", (_label, request) => {
    expect(() => assertMessagingTokenRequest(request, FIXED_NOW)).toThrow(
      InvalidMessagingTokenRequestError,
    );
  });

  it("rejects a signature that is not 65 bytes", () => {
    expect(() => encodeEip191Signature("0x1234")).toThrow(
      InvalidMessagingTokenRequestError,
    );
  });
});
