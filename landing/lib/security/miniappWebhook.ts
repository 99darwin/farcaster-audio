/**
 * Helpers for the Farcaster Mini App webhook proxy (`app/api/webhook`).
 *
 * The proxy does NOT verify the JSON Farcaster Signature itself: it forwards
 * the client's envelope byte-for-byte to the backend, which checks the
 * Ed25519 signature and that the signing key is an active app key of the
 * claimed FID. The proxy only rejects obviously malformed or oversized input
 * so junk never reaches the backend.
 */

/** Real envelopes are a few hundred bytes. */
export const MAX_MINIAPP_WEBHOOK_BYTES = 16 * 1024;
const MAX_HEADER_CHARS = 1024;
const MAX_PAYLOAD_CHARS = 8 * 1024;
const MAX_SIGNATURE_CHARS = 256;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export interface JfsEnvelope {
  header: string;
  payload: string;
  signature: string;
}

function isBase64UrlString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    BASE64URL_PATTERN.test(value)
  );
}

/** The `{header, payload, signature}` envelope, or null when malformed. */
export function parseJfsEnvelope(raw: unknown): JfsEnvelope | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const { header, payload, signature } = raw as Record<string, unknown>;
  if (!isBase64UrlString(header, MAX_HEADER_CHARS)) return null;
  if (!isBase64UrlString(payload, MAX_PAYLOAD_CHARS)) return null;
  if (!isBase64UrlString(signature, MAX_SIGNATURE_CHARS)) return null;
  return { header, payload, signature };
}

const HTTP_OK = 200;
const HTTP_BAD_GATEWAY = 502;
/** Backend verdicts the Farcaster client should see as-is. */
const PASSTHROUGH_CLIENT_ERRORS = new Set([400, 401, 413, 429]);

/**
 * Status to answer the Farcaster client with, given the backend's.
 * Verification failures pass through; backend faults become 502 so the
 * client retries rather than treating the event as delivered.
 */
export function proxyStatusFor(backendStatus: number): number {
  if (backendStatus >= 200 && backendStatus < 300) return HTTP_OK;
  if (PASSTHROUGH_CLIENT_ERRORS.has(backendStatus)) return backendStatus;
  return HTTP_BAD_GATEWAY;
}
