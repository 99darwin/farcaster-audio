import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import {
  MAX_PROTOCOL_TOKEN_TTL_SECONDS,
  PROTOCOL_AUTH_CHAIN_ID,
  PROTOCOL_TOKEN_PREFIX,
  createProtocolMessage,
  decodeProtocolToken,
  encodeProtocolToken,
  protocolStatement,
  resolveTokenExpiry,
  signProtocolToken,
} from "@/lib/auth/protocolToken";

const ISSUED_AT = new Date("2026-10-16T10:00:00.000Z");

describe("resolveTokenExpiry", () => {
  it("defaults to five minutes", () => {
    const expiry = resolveTokenExpiry({ issuedAt: ISSUED_AT });
    expect(expiry.getTime() - ISSUED_AT.getTime()).toBe(5 * 60 * 1000);
  });

  it("clamps the lifetime to one hour", () => {
    const expiry = resolveTokenExpiry({ issuedAt: ISSUED_AT, ttlSeconds: 86_400 });
    expect(expiry.getTime() - ISSUED_AT.getTime()).toBe(
      MAX_PROTOCOL_TOKEN_TTL_SECONDS * 1000,
    );
  });

  it("never outlives notAfter", () => {
    const notAfter = new Date(ISSUED_AT.getTime() + 90_000);
    const expiry = resolveTokenExpiry({
      issuedAt: ISSUED_AT,
      ttlSeconds: MAX_PROTOCOL_TOKEN_TTL_SECONDS,
      notAfter,
    });
    expect(expiry).toEqual(notAfter);
  });
});

describe("createProtocolMessage", () => {
  const address = privateKeyToAccount(generatePrivateKey()).address;

  it("pins the statement, resource and chain id", () => {
    const message = createProtocolMessage({
      address,
      fid: 99,
      nonce: "abcdef12",
      domain: "juke.audio",
      uri: "https://juke.audio",
      issuedAt: ISSUED_AT,
      expirationTime: new Date(ISSUED_AT.getTime() + 60_000),
    });
    const parsed = parseSiweMessage(message);
    expect(parsed.statement).toBe(protocolStatement(99));
    expect(parsed.statement).toBe("Authenticate as Farcaster FID 99.");
    expect(parsed.resources).toEqual(["farcaster://fid/99"]);
    expect(parsed.chainId).toBe(PROTOCOL_AUTH_CHAIN_ID);
    expect(parsed.version).toBe("1");
    expect(parsed.domain).toBe("juke.audio");
    expect(parsed.nonce).toBe("abcdef12");
  });

  it("rejects a non-positive fid and an inverted window", () => {
    const base = {
      address,
      nonce: "abcdef12",
      domain: "juke.audio",
      uri: "https://juke.audio",
      issuedAt: ISSUED_AT,
    };
    expect(() =>
      createProtocolMessage({
        ...base,
        fid: 0,
        expirationTime: new Date(ISSUED_AT.getTime() + 1000),
      }),
    ).toThrow(RangeError);
    expect(() =>
      createProtocolMessage({ ...base, fid: 1, expirationTime: ISSUED_AT }),
    ).toThrow(RangeError);
  });
});

describe("token encoding", () => {
  it("round-trips message and signature without padding", () => {
    const signature = `0x${"1b".repeat(65)}` as const;
    const token = encodeProtocolToken("héllo\nworld?>>", signature);
    expect(token.startsWith(PROTOCOL_TOKEN_PREFIX)).toBe(true);
    expect(token).not.toMatch(/[=+/]/);
    expect(decodeProtocolToken(token)).toEqual({
      message: "héllo\nworld?>>",
      signature,
    });
  });

  it("rejects foreign or malformed tokens", () => {
    expect(() => decodeProtocolToken("qa1.a.b")).toThrow();
    expect(() => decodeProtocolToken("hqa1.onlyone")).toThrow();
    expect(() => decodeProtocolToken("hqa1.a.b.c")).toThrow();
  });
});

describe("signProtocolToken", () => {
  it("produces a token whose signature recovers to the signer", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await signProtocolToken({
      signer: account,
      fid: 1234,
      nonce: "nonce1234",
      issuedAt: ISSUED_AT,
    });
    const { message, signature } = decodeProtocolToken(token);
    expect(await verifyMessage({ address: account.address, message, signature })).toBe(
      true,
    );
    const parsed = parseSiweMessage(message);
    expect(parsed.address).toBe(account.address);
    expect(parsed.resources).toEqual(["farcaster://fid/1234"]);
    expect(parsed.domain).toBe("juke.audio");
    expect(parsed.uri).toBe("https://juke.audio");
  });
});
