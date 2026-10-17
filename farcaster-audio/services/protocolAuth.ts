/**
 * Hypersnap "Protocol Auth" tokens (`hqa1.<b64url SIWE>.<b64url sig>`).
 *
 * Mirrors `@farcasterorg/quick-auth`'s `createMessage` / `encodeToken` so the
 * backend verifier sees the exact canonical EIP-4361 bytes it expects:
 * statement `Authenticate as Farcaster FID <fid>.`, a single
 * `farcaster://fid/<fid>` resource, chain-id 10, lifetime of at most 1h.
 *
 * The signer is any viem account exposing `address` + `signMessage`: the
 * device auth address for everyday logins, or (only during the one-time link)
 * the custody account derived from the recovery phrase.
 */

import { getAddress, hexToBytes, stringToBytes, type Hex } from "viem";

export const PROTOCOL_AUTH_TOKEN_PREFIX = "hqa1.";
export const PROTOCOL_AUTH_DOMAIN = "juke.audio";
export const PROTOCOL_AUTH_URI = "https://juke.audio";
/** Optimism — the chain KeyRegistry / IdRegistry live on. */
export const PROTOCOL_AUTH_CHAIN_ID = 10;
const FID_RESOURCE_PREFIX = "farcaster://fid/";
const SIWE_VERSION = "1";
/**
 * Server nonces are opaque base64url (`secrets.token_urlsafe`), so `-` and `_`
 * are legal here even though EIP-4361 only *recommends* alphanumerics. viem's
 * `createSiweMessage` rejects them, which is why the message is built by hand.
 * The charset still excludes whitespace so a nonce can't inject message lines.
 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
/** Server-supplied domain / uri must stay on their own line. */
const WHITESPACE_PATTERN = /\s/;
/** Hard ceiling from the contract; servers reject anything longer. */
export const PROTOCOL_AUTH_MAX_TTL_SECONDS = 60 * 60;
/** Everyday login tokens are used immediately, so keep them short. */
export const PROTOCOL_AUTH_LOGIN_TTL_SECONDS = 5 * 60;
const SIGNATURE_BYTE_LENGTH = 65;
const MS_PER_SECOND = 1000;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** RFC 4648 §5 base64url without padding. Pure JS: Hermes has no Buffer. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64URL_ALPHABET[(n >> 18) & 63] +
      BASE64URL_ALPHABET[(n >> 12) & 63] +
      BASE64URL_ALPHABET[(n >> 6) & 63] +
      BASE64URL_ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out +=
      BASE64URL_ALPHABET[(n >> 18) & 63] + BASE64URL_ALPHABET[(n >> 12) & 63];
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      BASE64URL_ALPHABET[(n >> 18) & 63] +
      BASE64URL_ALPHABET[(n >> 12) & 63] +
      BASE64URL_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

export class ProtocolAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolAuthError";
  }
}

/** `hqa1.<base64url(utf8 message)>.<base64url(65-byte signature)>` */
export function encodeProtocolAuthToken(params: {
  message: string;
  signature: Hex;
}): string {
  if (!params.message) {
    throw new ProtocolAuthError("Protocol Auth message is empty");
  }
  const signatureBytes = hexToBytes(params.signature);
  if (signatureBytes.length !== SIGNATURE_BYTE_LENGTH) {
    throw new ProtocolAuthError(
      `Protocol Auth signature must be ${SIGNATURE_BYTE_LENGTH} bytes`,
    );
  }
  return (
    PROTOCOL_AUTH_TOKEN_PREFIX +
    base64UrlEncode(stringToBytes(params.message)) +
    "." +
    base64UrlEncode(signatureBytes)
  );
}

export interface ProtocolAuthMessageParams {
  address: Hex;
  fid: number;
  nonce: string;
  domain?: string;
  uri?: string;
  issuedAt?: Date;
  expirationTime: Date;
}

/** The canonical EIP-4361 message a Protocol Auth token signs. */
export function createProtocolAuthMessage(
  params: ProtocolAuthMessageParams,
): string {
  if (!Number.isSafeInteger(params.fid) || params.fid <= 0) {
    throw new ProtocolAuthError("Invalid FID");
  }
  const issuedAt = params.issuedAt ?? new Date();
  const ttlMs = params.expirationTime.getTime() - issuedAt.getTime();
  if (ttlMs <= 0) {
    throw new ProtocolAuthError("Protocol Auth challenge has expired");
  }
  if (ttlMs > PROTOCOL_AUTH_MAX_TTL_SECONDS * MS_PER_SECOND) {
    throw new ProtocolAuthError("Protocol Auth lifetime exceeds 1h");
  }
  const domain = params.domain ?? PROTOCOL_AUTH_DOMAIN;
  const uri = params.uri ?? PROTOCOL_AUTH_URI;
  if (!domain || WHITESPACE_PATTERN.test(domain)) {
    throw new ProtocolAuthError("Invalid Protocol Auth domain");
  }
  if (!uri || WHITESPACE_PATTERN.test(uri)) {
    throw new ProtocolAuthError("Invalid Protocol Auth URI");
  }
  if (!NONCE_PATTERN.test(params.nonce)) {
    throw new ProtocolAuthError("Invalid Protocol Auth nonce");
  }
  // EIP-4361 field order, byte-for-byte what viem / quick-auth emit.
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    getAddress(params.address),
    "",
    `Authenticate as Farcaster FID ${params.fid}.`,
    "",
    `URI: ${uri}`,
    `Version: ${SIWE_VERSION}`,
    `Chain ID: ${PROTOCOL_AUTH_CHAIN_ID}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${params.expirationTime.toISOString()}`,
    "Resources:",
    `- ${FID_RESOURCE_PREFIX}${params.fid}`,
  ].join("\n");
}

/** The minimal account surface a token signer needs (viem LocalAccount). */
export interface MessageSigner {
  address: Hex;
  signMessage: (args: { message: string }) => Promise<Hex>;
}

/**
 * Expiration for a token: `ttlSeconds` from now, clamped to the server's
 * challenge expiry (when given) and to the 1h contract maximum.
 */
export function resolveTokenExpiry(params: {
  now: Date;
  ttlSeconds: number;
  challengeExpiresAt?: number;
}): Date {
  const ttlSeconds = Math.min(params.ttlSeconds, PROTOCOL_AUTH_MAX_TTL_SECONDS);
  let expiresMs = params.now.getTime() + ttlSeconds * MS_PER_SECOND;
  if (params.challengeExpiresAt !== undefined) {
    expiresMs = Math.min(expiresMs, params.challengeExpiresAt * MS_PER_SECOND);
  }
  return new Date(expiresMs);
}

/**
 * Build, sign and encode a Protocol Auth token in one step. Always signs for
 * PROTOCOL_AUTH_DOMAIN / PROTOCOL_AUTH_URI so no caller can route a key's
 * signature to another origin.
 */
export async function signProtocolAuthToken(params: {
  signer: MessageSigner;
  fid: number;
  nonce: string;
  ttlSeconds?: number;
  challengeExpiresAt?: number;
  now?: Date;
}): Promise<string> {
  const issuedAt = params.now ?? new Date();
  const expirationTime = resolveTokenExpiry({
    now: issuedAt,
    ttlSeconds: params.ttlSeconds ?? PROTOCOL_AUTH_LOGIN_TTL_SECONDS,
    challengeExpiresAt: params.challengeExpiresAt,
  });
  const message = createProtocolAuthMessage({
    address: params.signer.address,
    fid: params.fid,
    nonce: params.nonce,
    issuedAt,
    expirationTime,
  });
  const signature = await params.signer.signMessage({ message });
  return encodeProtocolAuthToken({ message, signature });
}
