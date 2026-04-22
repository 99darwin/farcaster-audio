import sdk from "@farcaster/miniapp-sdk";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";

if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  !process.env.NEXT_PUBLIC_API_BASE_URL
) {
  // Preview deploys must not throw, but a missing API base URL in dev is
  // almost always a mistake — surface it early so developers notice.
  // eslint-disable-next-line no-console
  console.warn(
    "[miniapp-auth] NEXT_PUBLIC_API_BASE_URL is unset; falling back to https://your-api-host.example.com",
  );
}

// Conservative token cache: refresh 60 seconds before `exp` to avoid
// race conditions near expiry. If exp can't be parsed, we default to
// 10 minutes (MIN_LIFETIME_MS), which matches the recommendation in the
// security review.
const MIN_LIFETIME_MS = 10 * 60 * 1000;
const EXPIRY_SAFETY_MS = 60 * 1000;

interface CachedAuth {
  token: string;
  fid: number;
  expiresAt: number;
}

let cached: CachedAuth | null = null;

export type MiniappAuthError =
  | "user_cancelled"
  | "network"
  | "verify_failed"
  | "invalid_response"
  | "not_in_miniapp";

export type MiniappAuthResult =
  | { ok: true; token: string; fid: number }
  | { ok: false; reason: MiniappAuthError };

// Plain desktop browsers outside a Farcaster host will never respond to
// the miniapp signIn bridge. Use the SDK's explicit detection method,
// with a short timeout as a defensive fallback in case the host check
// itself stalls.
const MINIAPP_CHECK_TIMEOUT_MS = 3000;
// If Quick Auth still hasn't resolved after this long, the host bridge
// is wedged (unverified manifest, host viewer gaps, etc.) — treat as
// not_in_miniapp so the UI falls back to app CTAs instead of hanging.
const QUICKAUTH_TIMEOUT_MS = 15_000;

async function isInMiniappHost(): Promise<boolean> {
  try {
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), MINIAPP_CHECK_TIMEOUT_MS),
    );
    const result = await Promise.race([sdk.isInMiniApp(), timeout]);
    // Diagnostic — temporary until we validate the desktop browser flow
    // end-to-end on Quick Auth. Remove once the UX is confirmed stable.
    // eslint-disable-next-line no-console
    console.info("[miniapp-auth] isInMiniApp ->", result);
    return result;
  } catch {
    return false;
  }
}

/**
 * Quick Auth flow for Farcaster miniapps.
 *
 * Flow:
 *   1. `sdk.quickAuth.getToken()` — the SDK handles nonce generation and
 *      SIWF exchange with `auth.farcaster.xyz`, returning a JWT.
 *   2. POST the Quick Auth JWT to our backend, which verifies it via
 *      Farcaster's JWKS and returns our own session JWT.
 *
 * Returns a discriminated union so callers can react to specific failure
 * modes (user dismissal vs network error vs server verify failure).
 */
export async function authenticateMiniapp(): Promise<MiniappAuthResult> {
  // Bail out early in plain desktop browsers — otherwise the Quick Auth
  // SDK call hangs indefinitely with no host to respond.
  if (!(await isInMiniappHost())) {
    return { ok: false, reason: "not_in_miniapp" };
  }

  let quickAuthToken: string;
  try {
    // Safety net: if Quick Auth stalls (host viewer gap, unverified
    // manifest, etc.), fall through after QUICKAUTH_TIMEOUT_MS rather
    // than leaving the UI stuck forever.
    const authTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("quickauth_timeout")),
        QUICKAUTH_TIMEOUT_MS,
      ),
    );
    const result = await Promise.race([
      sdk.quickAuth.getToken(),
      authTimeout,
    ]);
    quickAuthToken = result.token;
  } catch (err) {
    // The miniapp SDK throws `SignIn.RejectedByUser` for dismissal;
    // defensively check by name since the type isn't re-exported here.
    const name = (err as { name?: string })?.name ?? "";
    const message = (err as { message?: string })?.message ?? "";
    if (name.includes("Rejected")) {
      return { ok: false, reason: "user_cancelled" };
    }
    if (message === "quickauth_timeout") {
      return { ok: false, reason: "not_in_miniapp" };
    }
    return { ok: false, reason: "network" };
  }

  const verifyUrl = `${API_BASE_URL}/v1/auth/miniapp-quickauth`;
  let resp: Response;
  try {
    resp = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: quickAuthToken }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  // Defense in depth: confirm the response actually came from the same
  // origin we posted to. Rules out a transparent proxy rewriting `resp.url`.
  try {
    const respOrigin = new URL(resp.url).origin;
    const expectedOrigin = new URL(verifyUrl).origin;
    if (respOrigin !== expectedOrigin) {
      return { ok: false, reason: "invalid_response" };
    }
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  if (!resp.ok) {
    // 4xx means the backend refused to verify the signature; surface as
    // a distinct error so the UI can show a fatal message instead of
    // retrying silently.
    return { ok: false, reason: "verify_failed" };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "invalid_response" };
  }
  const { token, fid } = body as { token?: unknown; fid?: unknown };
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "invalid_response" };
  }
  if (typeof fid !== "number" || !Number.isFinite(fid)) {
    return { ok: false, reason: "invalid_response" };
  }

  const expiresAt = parseJwtExpiry(token) ?? Date.now() + MIN_LIFETIME_MS;
  cached = { token, fid, expiresAt };

  return { ok: true, token, fid };
}

/**
 * Returns a cached auth result if the JWT is still comfortably valid,
 * otherwise runs the full SIWF flow. Call sites should prefer this over
 * `authenticateMiniapp()` unless they specifically want to force re-auth.
 */
export async function getCachedMiniappAuth(): Promise<MiniappAuthResult> {
  if (cached && Date.now() + EXPIRY_SAFETY_MS < cached.expiresAt) {
    return { ok: true, token: cached.token, fid: cached.fid };
  }
  return authenticateMiniapp();
}

/**
 * Clear the cached token. Call after a 401 from the backend or on sign-out.
 */
export function clearCachedMiniappAuth(): void {
  cached = null;
}

function parseJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    // Base64url decode the payload segment.
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "===".slice(0, (4 - (payload.length % 4)) % 4);
    const json = typeof atob === "function" ? atob(padded) : "";
    if (!json) return null;
    const claims = JSON.parse(json) as { exp?: unknown };
    if (typeof claims.exp !== "number") return null;
    return claims.exp * 1000;
  } catch {
    return null;
  }
}
