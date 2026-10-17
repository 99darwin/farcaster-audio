/**
 * In-memory session store for the Juke web app (`juke.audio/app`).
 *
 * SECURITY: the access JWT lives in module memory ONLY — never in
 * localStorage/sessionStorage/cookies readable by JS. XSS can still read
 * memory, but it can't exfiltrate a durable credential, and the token is
 * short-lived. The durable credential is the HttpOnly `juke_refresh` cookie
 * (Domain=.juke.audio) which JS cannot read; silent refresh (see
 * `authRefresh.ts`) trades that cookie for a fresh JWT on cold load and 401.
 *
 * This module is the single source of truth for the raw JWT. `authStore.ts`
 * mirrors the user/auth-status for React; this file holds the secret.
 */

import type { LoginResponse, UserResponse } from "@/lib/api/types";

interface Session {
  jwt: string;
  /** Epoch milliseconds for the JWT `exp`. */
  expiresAt: number;
  user: UserResponse;
}

// Fallback lifetime when neither `expires_at` nor the JWT `exp` can be parsed.
const FALLBACK_LIFETIME_MS = 10 * 60 * 1000;

let session: Session | null = null;

/** Persist a fresh session in memory (from /login or /refresh). */
export function setSession(response: LoginResponse): void {
  session = {
    jwt: response.jwt,
    expiresAt: resolveExpiry(response),
    user: response.user,
  };
}

/** Drop the in-memory session (logout, or a conclusive refresh failure). */
export function clearSession(): void {
  session = null;
}

/** The current access JWT, or null when anonymous. */
export function getJwt(): string | null {
  return session?.jwt ?? null;
}

/** The current user, or null when anonymous. */
export function getUser(): UserResponse | null {
  return session?.user ?? null;
}

/** Epoch ms for the current JWT `exp`, or null when anonymous. */
export function getExpiresAt(): number | null {
  return session?.expiresAt ?? null;
}

function resolveExpiry(response: LoginResponse): number {
  const fromIso = Date.parse(response.expires_at);
  if (Number.isFinite(fromIso)) return fromIso;
  const fromJwt = parseJwtExpiry(response.jwt);
  if (fromJwt !== null) return fromJwt;
  return Date.now() + FALLBACK_LIFETIME_MS;
}

/**
 * Decode the `exp` claim (seconds → ms) from a JWT without verifying its
 * signature. Ported from the miniapp-auth in-memory cache pattern. Verification
 * is the backend's job; this is only used to schedule proactive refresh.
 */
export function parseJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "===".slice(0, (4 - (payload.length % 4)) % 4);
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf-8");
    if (!json) return null;
    const claims = JSON.parse(json) as { exp?: unknown };
    if (typeof claims.exp !== "number") return null;
    return claims.exp * 1000;
  } catch {
    return null;
  }
}
