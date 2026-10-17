/**
 * Direct Casts `generateToken` auth request, signed by custody so the
 * backend can mint the Farcaster messaging bearer (messaging-design §3).
 *
 * The backend verifies an EIP-191 signature over the canonical JSON of the
 * request (recursively sorted keys, no whitespace), so the bytes signed here
 * must match {@link canonicalizeAuthRequest} exactly. Nothing is signed
 * unless the request passes {@link assertMessagingTokenRequest}. Mirrors
 * `landing/lib/auth/messagingToken.ts`.
 */

import { hexToBytes, type Hex, type LocalAccount } from "viem";
import type {
  DirectCastAuthRequest,
  EnableMessagingRequest,
} from "@/types/messages";

const MESSAGING_TOKEN_METHOD = "generateToken";
/** Lifetime the token asks for — also the most custody will ever sign. */
export const MESSAGING_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
/** Slack for the gap between building the request and validating it. */
const MESSAGING_TOKEN_CLOCK_SKEW_MS = 60 * 1_000;
const SIGNATURE_PREFIX = "eip191:";
const SIGNATURE_BYTE_LENGTH = 65;

/** The request was malformed, so custody refused to sign it. */
export class InvalidMessagingTokenRequestError extends Error {
  constructor(reason: string) {
    super(
      `The messaging access request was malformed (${reason}), so nothing was signed.`,
    );
    this.name = "InvalidMessagingTokenRequestError";
  }
}

export function buildMessagingTokenRequest(
  now: Date = new Date(),
): DirectCastAuthRequest {
  const timestamp = now.getTime();
  return {
    method: MESSAGING_TOKEN_METHOD,
    params: { timestamp, expiresAt: timestamp + MESSAGING_TOKEN_TTL_MS },
  };
}

/** JSON with recursively sorted object keys and no whitespace. */
export function canonicalizeAuthRequest(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeysDeep(record[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

/**
 * Pin the request to exactly `{ method: "generateToken", params: {
 * timestamp, expiresAt } }` with integer millisecond values and at most a
 * 90-day window.
 */
export function assertMessagingTokenRequest(
  request: unknown,
  now: Date = new Date(),
): asserts request is DirectCastAuthRequest {
  if (!isPlainObject(request) || !hasExactKeys(request, ["method", "params"])) {
    throw new InvalidMessagingTokenRequestError("shape");
  }
  if (request.method !== MESSAGING_TOKEN_METHOD) {
    throw new InvalidMessagingTokenRequestError("method");
  }
  const { params } = request;
  if (
    !isPlainObject(params) ||
    !hasExactKeys(params, ["expiresAt", "timestamp"])
  ) {
    throw new InvalidMessagingTokenRequestError("params");
  }
  const { timestamp, expiresAt } = params;
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiresAt)) {
    throw new InvalidMessagingTokenRequestError("non-integer time");
  }
  const nowMs = now.getTime();
  const start = timestamp as number;
  const end = expiresAt as number;
  if (Math.abs(start - nowMs) > MESSAGING_TOKEN_CLOCK_SKEW_MS) {
    throw new InvalidMessagingTokenRequestError("timestamp");
  }
  if (end <= start) {
    throw new InvalidMessagingTokenRequestError("expiry before timestamp");
  }
  if (end - nowMs > MESSAGING_TOKEN_TTL_MS + MESSAGING_TOKEN_CLOCK_SKEW_MS) {
    throw new InvalidMessagingTokenRequestError("expiry beyond 90 days");
  }
}

/** `eip191:` + standard base64 (padded) of the raw 65-byte signature. */
export function encodeEip191Signature(signature: Hex): string {
  const bytes = hexToBytes(signature);
  if (bytes.length !== SIGNATURE_BYTE_LENGTH) {
    throw new InvalidMessagingTokenRequestError("signature length");
  }
  return `${SIGNATURE_PREFIX}${btoa(String.fromCharCode(...bytes))}`;
}

/** Validate, then EIP-191 sign the canonical request with custody. */
export async function signMessagingTokenRequest(
  custody: Pick<LocalAccount, "signMessage">,
  now: Date = new Date(),
): Promise<EnableMessagingRequest> {
  const request = buildMessagingTokenRequest(now);
  assertMessagingTokenRequest(request, now);
  const signature = await custody.signMessage({
    message: canonicalizeAuthRequest(request),
  });
  return {
    dc_auth_request: request,
    dc_auth_signature: encodeEip191Signature(signature),
  };
}
