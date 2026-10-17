/**
 * Protocol Auth (`hqa1`) tokens for the Hypersnap fork of Farcaster.
 *
 * A token is an EIP-4361 (SIWE) message signed by either the FID's custody
 * address or a KeyRegistry auth address (keyType 2), encoded as
 * `hqa1.<base64url(message)>.<base64url(signature)>`. The message format
 * mirrors `@farcasterorg/quick-auth` (`token.ts`): pinned statement,
 * `farcaster://fid/<fid>` resource, chain-id 10, at most 1h of validity.
 *
 * Verification needs no auth server — the Juke backend checks the signature
 * against on-chain state (`POST /v1/auth/protocol`, see the frozen auth
 * contract). This module is pure: it builds and encodes, it never stores keys.
 */

import { bytesToHex, hexToBytes, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";

export const PROTOCOL_TOKEN_PREFIX = "hqa1.";
export const FID_RESOURCE_PREFIX = "farcaster://fid/";
/** Optimism — the chain the Farcaster IdRegistry/KeyRegistry live on. */
export const PROTOCOL_AUTH_CHAIN_ID = 10;
/** Tokens may live at most one hour (contract section 1/2). */
export const MAX_PROTOCOL_TOKEN_TTL_SECONDS = 60 * 60;
/** Default lifetime for a login token — it is exchanged immediately. */
export const DEFAULT_PROTOCOL_TOKEN_TTL_SECONDS = 5 * 60;

/** SIWE `domain` the backend expects (contract: `juke.audio`). */
export const PROTOCOL_AUTH_DOMAIN =
  process.env.NEXT_PUBLIC_PROTOCOL_AUTH_DOMAIN || "juke.audio";
/** SIWE `uri` paired with {@link PROTOCOL_AUTH_DOMAIN}. */
export const PROTOCOL_AUTH_URI =
  process.env.NEXT_PUBLIC_PROTOCOL_AUTH_URI || "https://juke.audio";

/** Anything that can EIP-191 sign a string — a viem `LocalAccount` fits. */
export interface MessageSigner {
  readonly address: Hex;
  signMessage: (args: { message: string }) => Promise<Hex>;
}

export interface ProtocolTokenParams {
  readonly signer: MessageSigner;
  readonly fid: number;
  readonly nonce: string;
  readonly domain?: string;
  readonly uri?: string;
  readonly issuedAt?: Date;
  /** Requested lifetime; clamped to {@link MAX_PROTOCOL_TOKEN_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
  /** Hard upper bound for the expiry (e.g. the prepare nonce's `expires_at`). */
  readonly notAfter?: Date;
}

/** The pinned statement — keeps a token distinct from a SIWF message. */
export function protocolStatement(fid: number): string {
  return `Authenticate as Farcaster FID ${fid}.`;
}

/** Resolve the token expiry: `issuedAt + ttl`, clamped to 1h and `notAfter`. */
export function resolveTokenExpiry(params: {
  issuedAt: Date;
  ttlSeconds?: number;
  notAfter?: Date;
}): Date {
  const requested = params.ttlSeconds ?? DEFAULT_PROTOCOL_TOKEN_TTL_SECONDS;
  const ttl = Math.min(Math.max(requested, 1), MAX_PROTOCOL_TOKEN_TTL_SECONDS);
  const fromTtl = params.issuedAt.getTime() + ttl * 1000;
  const bound = params.notAfter?.getTime() ?? Number.POSITIVE_INFINITY;
  return new Date(Math.min(fromTtl, bound));
}

/** Build the EIP-4361 message a signer signs to produce a token. */
export function createProtocolMessage(params: {
  address: Hex;
  fid: number;
  nonce: string;
  domain: string;
  uri: string;
  issuedAt: Date;
  expirationTime: Date;
}): string {
  if (!Number.isSafeInteger(params.fid) || params.fid <= 0) {
    throw new RangeError("fid must be a positive integer");
  }
  if (params.expirationTime.getTime() <= params.issuedAt.getTime()) {
    throw new RangeError("token expiry must be after issuedAt");
  }
  return createSiweMessage({
    domain: params.domain,
    address: params.address,
    statement: protocolStatement(params.fid),
    uri: params.uri,
    version: "1",
    chainId: PROTOCOL_AUTH_CHAIN_ID,
    nonce: params.nonce,
    issuedAt: params.issuedAt,
    expirationTime: params.expirationTime,
    resources: [`${FID_RESOURCE_PREFIX}${params.fid}`],
  });
}

/** `hqa1.<base64url(message)>.<base64url(signature)>`, unpadded. */
export function encodeProtocolToken(message: string, signature: Hex): string {
  const encodedMessage = base64UrlEncode(new TextEncoder().encode(message));
  const encodedSignature = base64UrlEncode(hexToBytes(signature));
  return `${PROTOCOL_TOKEN_PREFIX}${encodedMessage}.${encodedSignature}`;
}

/** Inverse of {@link encodeProtocolToken}. Throws on a malformed token. */
export function decodeProtocolToken(token: string): {
  message: string;
  signature: Hex;
} {
  if (!token.startsWith(PROTOCOL_TOKEN_PREFIX)) {
    throw new Error("not a protocol auth token");
  }
  const parts = token.slice(PROTOCOL_TOKEN_PREFIX.length).split(".");
  const [message, signature] = parts;
  if (parts.length !== 2 || !message || !signature) {
    throw new Error("malformed protocol auth token");
  }
  return {
    message: new TextDecoder().decode(base64UrlDecode(message)),
    signature: bytesToHex(base64UrlDecode(signature)),
  };
}

/** Build, sign and encode a protocol auth token. */
export async function signProtocolToken(
  params: ProtocolTokenParams,
): Promise<string> {
  const issuedAt = params.issuedAt ?? new Date();
  const message = createProtocolMessage({
    address: params.signer.address,
    fid: params.fid,
    nonce: params.nonce,
    domain: params.domain ?? PROTOCOL_AUTH_DOMAIN,
    uri: params.uri ?? PROTOCOL_AUTH_URI,
    issuedAt,
    expirationTime: resolveTokenExpiry({
      issuedAt,
      ttlSeconds: params.ttlSeconds,
      notAfter: params.notAfter,
    }),
  });
  const signature = await params.signer.signMessage({ message });
  return encodeProtocolToken(message, signature);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
