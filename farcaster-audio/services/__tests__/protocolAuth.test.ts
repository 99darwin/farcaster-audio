import { describe, expect, it } from "@jest/globals";
import { recoverMessageAddress } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import {
  base64UrlEncode,
  createProtocolAuthMessage,
  encodeProtocolAuthToken,
  ProtocolAuthError,
  resolveTokenExpiry,
  signProtocolAuthToken,
} from "@/services/protocolAuth";
import {
  decodeHqa1,
  FIXED_NOW,
  TEST_AUTH_ACCOUNT,
  TEST_FID,
} from "@/services/__fixtures__/signerLink";

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("base64UrlEncode", () => {
  it.each([
    [""],
    ["f"],
    ["fo"],
    ["foo"],
    ["foob"],
    ["fooba"],
    ["foobar"],
    ["ÿþý?>"],
  ])("matches Node's base64url for %j", (input) => {
    const bytes = new TextEncoder().encode(input);
    expect(base64UrlEncode(bytes)).toBe(
      Buffer.from(bytes).toString("base64url"),
    );
  });

  it("never emits padding or non-url characters", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64UrlEncode(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("encodeProtocolAuthToken", () => {
  const signature = `0x${"11".repeat(65)}` as const;

  it("encodes hqa1.<b64url message>.<b64url signature>", () => {
    const token = encodeProtocolAuthToken({
      message: "hello\nworld",
      signature,
    });
    expect(token.startsWith("hqa1.")).toBe(true);
    expect(token.split(".")).toHaveLength(3);
    const decoded = decodeHqa1(token);
    expect(decoded.message).toBe("hello\nworld");
    expect(decoded.signature).toBe(signature);
  });

  it("rejects signatures that aren't 65 bytes", () => {
    expect(() =>
      encodeProtocolAuthToken({
        message: "m",
        signature: `0x${"11".repeat(64)}`,
      }),
    ).toThrow(ProtocolAuthError);
  });

  it("rejects an empty message", () => {
    expect(() => encodeProtocolAuthToken({ message: "", signature })).toThrow(
      ProtocolAuthError,
    );
  });
});

describe("createProtocolAuthMessage", () => {
  it("builds the quick-auth SIWE message", () => {
    const message = createProtocolAuthMessage({
      address: TEST_AUTH_ACCOUNT.address,
      fid: TEST_FID,
      nonce: "abcdef12345678",
      issuedAt: FIXED_NOW,
      expirationTime: new Date(FIXED_NOW.getTime() + 5 * 60 * 1000),
    });
    const parsed = parseSiweMessage(message);
    expect(parsed.domain).toBe("juke.audio");
    expect(parsed.uri).toBe("https://juke.audio");
    expect(parsed.chainId).toBe(10);
    expect(parsed.statement).toBe(`Authenticate as Farcaster FID ${TEST_FID}.`);
    expect(parsed.resources).toEqual([`farcaster://fid/${TEST_FID}`]);
    expect(parsed.nonce).toBe("abcdef12345678");
    expect(parsed.address).toBe(TEST_AUTH_ACCOUNT.address);
  });

  it("is byte-identical to viem's createSiweMessage for alphanumeric nonces", () => {
    const expirationTime = new Date(FIXED_NOW.getTime() + 5 * 60 * 1000);
    const message = createProtocolAuthMessage({
      address: TEST_AUTH_ACCOUNT.address,
      fid: TEST_FID,
      nonce: "abcdef12345678",
      issuedAt: FIXED_NOW,
      expirationTime,
    });
    expect(message).toBe(
      createSiweMessage({
        domain: "juke.audio",
        uri: "https://juke.audio",
        address: TEST_AUTH_ACCOUNT.address,
        statement: `Authenticate as Farcaster FID ${TEST_FID}.`,
        version: "1",
        chainId: 10,
        nonce: "abcdef12345678",
        issuedAt: FIXED_NOW,
        expirationTime,
        resources: [`farcaster://fid/${TEST_FID}`],
      }),
    );
  });

  it("accepts base64url server nonces containing - and _", () => {
    const nonce = "Ab3-xYz_9kLmN0pQ-rS_tU";
    const message = createProtocolAuthMessage({
      address: TEST_AUTH_ACCOUNT.address,
      fid: TEST_FID,
      nonce,
      issuedAt: FIXED_NOW,
      expirationTime: new Date(FIXED_NOW.getTime() + 5 * 60 * 1000),
    });
    expect(message.split("\n")).toContain(`Nonce: ${nonce}`);
  });

  it.each([
    ["short", "abc"],
    ["newline injection", "abcdef12\nChain ID: 1"],
    ["whitespace", "abcd efgh1234"],
  ])("rejects a %s nonce", (_label, nonce) => {
    expect(() =>
      createProtocolAuthMessage({
        address: TEST_AUTH_ACCOUNT.address,
        fid: TEST_FID,
        nonce,
        issuedAt: FIXED_NOW,
        expirationTime: new Date(FIXED_NOW.getTime() + 1000),
      }),
    ).toThrow("Invalid Protocol Auth nonce");
  });

  it("rejects a domain or uri that would break the message lines", () => {
    const base = {
      address: TEST_AUTH_ACCOUNT.address,
      fid: TEST_FID,
      nonce: "abcdef12345678",
      issuedAt: FIXED_NOW,
      expirationTime: new Date(FIXED_NOW.getTime() + 1000),
    };
    expect(() =>
      createProtocolAuthMessage({ ...base, domain: "juke.audio\nURI: x" }),
    ).toThrow("Invalid Protocol Auth domain");
    expect(() =>
      createProtocolAuthMessage({ ...base, uri: "https://juke.audio x" }),
    ).toThrow("Invalid Protocol Auth URI");
  });

  it("rejects a lifetime longer than 1h", () => {
    expect(() =>
      createProtocolAuthMessage({
        address: TEST_AUTH_ACCOUNT.address,
        fid: TEST_FID,
        nonce: "abcdef12345678",
        issuedAt: FIXED_NOW,
        expirationTime: new Date(FIXED_NOW.getTime() + ONE_HOUR_MS + 1000),
      }),
    ).toThrow("exceeds 1h");
  });

  it("rejects an already-expired challenge and bad FIDs", () => {
    const base = {
      address: TEST_AUTH_ACCOUNT.address,
      nonce: "abcdef12345678",
      issuedAt: FIXED_NOW,
    };
    expect(() =>
      createProtocolAuthMessage({
        ...base,
        fid: TEST_FID,
        expirationTime: FIXED_NOW,
      }),
    ).toThrow("expired");
    expect(() =>
      createProtocolAuthMessage({
        ...base,
        fid: 0,
        expirationTime: new Date(FIXED_NOW.getTime() + 1000),
      }),
    ).toThrow("Invalid FID");
  });
});

describe("resolveTokenExpiry", () => {
  it("clamps to the 1h maximum and the server challenge expiry", () => {
    expect(
      resolveTokenExpiry({ now: FIXED_NOW, ttlSeconds: 10 * 3600 }).getTime(),
    ).toBe(FIXED_NOW.getTime() + ONE_HOUR_MS);
    const challengeExpiresAt = FIXED_NOW.getTime() / 1000 + 120;
    expect(
      resolveTokenExpiry({
        now: FIXED_NOW,
        ttlSeconds: 3600,
        challengeExpiresAt,
      }).getTime(),
    ).toBe(challengeExpiresAt * 1000);
  });
});

describe("signProtocolAuthToken", () => {
  it("produces a token whose signature recovers to the signer", async () => {
    const token = await signProtocolAuthToken({
      signer: TEST_AUTH_ACCOUNT,
      fid: TEST_FID,
      nonce: "abcdef12345678",
      now: FIXED_NOW,
    });
    const { message, signature } = decodeHqa1(token);
    await expect(recoverMessageAddress({ message, signature })).resolves.toBe(
      TEST_AUTH_ACCOUNT.address,
    );
    const parsed = parseSiweMessage(message);
    // Default everyday-login TTL is 5 minutes.
    expect(parsed.expirationTime?.getTime()).toBe(
      FIXED_NOW.getTime() + 5 * 60 * 1000,
    );
  });

  it("signs with a base64url nonce from /v1/auth/siwf/nonce", async () => {
    const nonce = "Zq-8_Wn3xYb-Kc_4TfR2aA";
    const token = await signProtocolAuthToken({
      signer: TEST_AUTH_ACCOUNT,
      fid: TEST_FID,
      nonce,
      now: FIXED_NOW,
    });
    const { message, signature } = decodeHqa1(token);
    expect(message).toContain(`\nNonce: ${nonce}\n`);
    await expect(recoverMessageAddress({ message, signature })).resolves.toBe(
      TEST_AUTH_ACCOUNT.address,
    );
  });
});
