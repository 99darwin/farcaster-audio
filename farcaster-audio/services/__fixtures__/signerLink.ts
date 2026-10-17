/**
 * Shared fixtures for the signer-link tests. The phrase is the public
 * Hardhat/Anvil test mnemonic and the auth key is the public Anvil account
 * #1 key, so neither controls anything of value.
 */

import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { Eip712Payload, SignerPrepareResponse } from "@/types/api";

export const TEST_PHRASE =
  "test test test test test test test test test test test junk";
/** Another valid BIP-39 phrase that does NOT control TEST_CUSTODY. */
export const OTHER_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const TEST_CUSTODY = mnemonicToAccount(TEST_PHRASE).address;
export const TEST_AUTH_ACCOUNT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
export const TEST_FID = 1234;
export const TEST_SIGNER_PUBLIC_KEY = `0x${"ab".repeat(32)}` as const;
export const KEY_GATEWAY = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B";
/** 2026-10-16T12:00:00Z — all fixture expiries are relative to this. */
export const FIXED_NOW = new Date("2026-10-16T12:00:00.000Z");
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

const ADD_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Add: [
    { name: "owner", type: "address" },
    { name: "keyType", type: "uint32" },
    { name: "key", type: "bytes" },
    { name: "metadataType", type: "uint8" },
    { name: "metadata", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/** Prepare window used by the fixtures; deadlines sit just inside it. */
export const FIXTURE_PREPARE_TTL_SECONDS = 600;
const FIXTURE_DEADLINE_MARGIN_SECONDS = 60;

export function makeAddPayload(
  keyType: number,
  key: string,
  nowSeconds: number = FIXED_NOW_SECONDS,
): Eip712Payload {
  return {
    domain: {
      name: "Farcaster KeyGateway",
      version: "1",
      chainId: 10,
      verifyingContract: KEY_GATEWAY,
    },
    types: ADD_TYPES,
    primaryType: "Add",
    message: {
      owner: TEST_CUSTODY,
      keyType,
      key,
      metadataType: 1,
      metadata: "0x",
      nonce: 0,
      deadline:
        nowSeconds + FIXTURE_PREPARE_TTL_SECONDS - FIXTURE_DEADLINE_MARGIN_SECONDS,
    },
  };
}

export function makePrepare(
  overrides: Partial<SignerPrepareResponse> = {},
  options: { authAddress?: string; nowSeconds?: number } = {},
): SignerPrepareResponse {
  const nowSeconds = options.nowSeconds ?? FIXED_NOW_SECONDS;
  const authAddress = options.authAddress ?? TEST_AUTH_ACCOUNT.address;
  const authKey = `0x${"0".repeat(24)}${authAddress.slice(2).toLowerCase()}`;
  return {
    prepare_id: "prep_1",
    custody_address: TEST_CUSTODY,
    signer_public_key: TEST_SIGNER_PUBLIC_KEY,
    typed_data: {
      signer: makeAddPayload(1, TEST_SIGNER_PUBLIC_KEY, nowSeconds),
      auth_address: makeAddPayload(2, authKey, nowSeconds),
    },
    protocol_auth: {
      domain: "juke.audio",
      uri: "https://juke.audio",
      nonce: "abcdef12345678",
      expires_at: nowSeconds + FIXTURE_PREPARE_TTL_SECONDS,
    },
    expires_at: nowSeconds + FIXTURE_PREPARE_TTL_SECONDS,
    ...overrides,
  };
}

/** Decode an hqa1 token back into its SIWE message and hex signature. */
export function decodeHqa1(token: string): {
  message: string;
  signature: `0x${string}`;
} {
  const [prefix, messagePart, signaturePart] = token.split(".");
  if (prefix !== "hqa1" || !messagePart || !signaturePart) {
    throw new Error("not an hqa1 token");
  }
  const message = Buffer.from(messagePart, "base64url").toString("utf8");
  const signature =
    `0x${Buffer.from(signaturePart, "base64url").toString("hex")}` as const;
  return { message, signature };
}

/** Decode `eip191:<base64>` back to the 0x-hex signature viem recovers. */
export function decodeEip191(signature: string): `0x${string}` {
  const prefix = "eip191:";
  if (!signature.startsWith(prefix)) throw new Error("not an eip191 signature");
  const binary = atob(signature.slice(prefix.length));
  const hex = Array.from(binary, (c) => c.charCodeAt(0).toString(16).padStart(2, "0"));
  return `0x${hex.join("")}`;
}
