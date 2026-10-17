/**
 * Validators for Farcaster identifiers that arrive from untrusted content
 * (snap buttons, mini apps, deep links) and are interpolated into routes.
 * Anything that fails is dropped rather than navigated to.
 */

const CAST_HASH_PATTERN = /^0x[0-9a-f]+$/i;
const FID_PATTERN = /^[1-9]\d*$/;

export function isValidCastHash(value: unknown): value is string {
  return typeof value === "string" && CAST_HASH_PATTERN.test(value);
}

/** Positive safe integer fid from a number or a decimal string, else null. */
export function parseFid(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !FID_PATTERN.test(value)) return null;
  const fid = Number(value);
  return Number.isSafeInteger(fid) ? fid : null;
}
