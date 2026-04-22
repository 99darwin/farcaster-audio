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

// Plain desktop browsers outside a Farcaster host will never resolve
// `sdk.actions.signIn`. Use the SDK's explicit detection method, with a
// short timeout as a defensive fallback in case the host check itself
// stalls.
const MINIAPP_CHECK_TIMEOUT_MS = 3000;
const SIGNIN_TIMEOUT_MS = 60_000;

async function isInMiniappHost(): Promise<boolean> {
  try {
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), MINIAPP_CHECK_TIMEOUT_MS),
    );
    return await Promise.race([sdk.isInMiniApp(), timeout]);
  } catch {
    return false;
  }
}

/**
 * SIWF authentication flow for Farcaster miniapps.
 *
 * Flow:
 *   1. Fetch a server-generated nonce (one-time use, prevents replay).
 *   2. Prompt user via `sdk.actions.signIn` (Sign-In With Farcaster).
 *   3. POST signature + nonce to backend, receive JWT + FID.
 *
 * Returns a discriminated union so callers can react to specific failure
 * modes (user dismissal vs network error vs server verify failure).
 */
export async function authenticateMiniapp(): Promise<MiniappAuthResult> {
  // Bail out early in plain desktop browsers — otherwise signIn hangs
  // indefinitely with no miniapp host to respond.
  if (!(await isInMiniappHost())) {
    return { ok: false, reason: "not_in_miniapp" };
  }

  let nonce: string;
  try {
    const nonceResp = await fetch(`${API_BASE_URL}/v1/auth/miniapp-nonce`);
    if (!nonceResp.ok) return { ok: false, reason: "network" };
    const nonceBody = (await nonceResp.json()) as { nonce?: unknown };
    if (typeof nonceBody.nonce !== "string" || nonceBody.nonce.length === 0) {
      return { ok: false, reason: "invalid_response" };
    }
    nonce = nonceBody.nonce;
  } catch {
    return { ok: false, reason: "network" };
  }

  let signResult: { message: string; signature: string };
  try {
    // Safety net: if the host check passed but signIn still stalls
    // (ignored prompt, broken bridge), fall through after SIGNIN_TIMEOUT_MS
    // rather than leaving the UI stuck forever.
    const signinTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("signin_timeout")),
        SIGNIN_TIMEOUT_MS,
      ),
    );
    signResult = await Promise.race([
      sdk.actions.signIn({ nonce }),
      signinTimeout,
    ]);
  } catch (err) {
    // The miniapp SDK throws `SignIn.RejectedByUser` for dismissal; we
    // don't have a stable type here, so check the error name defensively.
    const name = (err as { name?: string })?.name ?? "";
    const message = (err as { message?: string })?.message ?? "";
    if (name.includes("Rejected")) {
      return { ok: false, reason: "user_cancelled" };
    }
    if (message === "signin_timeout") {
      return { ok: false, reason: "not_in_miniapp" };
    }
    return { ok: false, reason: "network" };
  }

  const verifyUrl = `${API_BASE_URL}/v1/auth/miniapp-verify`;
  let resp: Response;
  try {
    resp = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: signResult.message,
        signature: signResult.signature,
        nonce,
      }),
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
