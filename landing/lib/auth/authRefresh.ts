/**
 * Single-flight silent refresh for the Juke web app.
 *
 * Ported faithfully from mobile `services/authRefresh.ts`. The single-flight
 * guard + `sessionGen` snapshot are SECURITY CONTROLS, not optimisations:
 *   - Single-flight: concurrent 401s (and the cold-load bootstrap) collapse to
 *     ONE `/refresh` call so we never double-spend the rotating one-time
 *     refresh token.
 *   - `sessionGen`: if the user logs out (or a newer login lands) while our
 *     request is in flight, we discard the response rather than resurrecting a
 *     dead session.
 *
 * The refresh credential is the HttpOnly `juke_refresh` cookie — the body is
 * empty and `credentials: "include"` carries the cookie. On a conclusive auth
 * failure (401/403) we log out; transient errors (offline, 5xx) throw so the
 * caller can retry on the next tick without killing the session.
 */

import { API_BASE_URL } from "@/lib/api/client";
import { useAuthStore } from "@/lib/stores/authStore";
import { getJwt } from "@/lib/auth/session";
import type { LoginResponse } from "@/lib/api/types";

let inFlight: Promise<LoginResponse | null> | null = null;

export function refreshSession(): Promise<LoginResponse | null> {
  if (inFlight) return inFlight;
  inFlight = runRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runRefresh(): Promise<LoginResponse | null> {
  const startGen = useAuthStore.getState().sessionGen;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Attach the current JWT if we have one (harmless; the cookie is what the
  // backend actually validates for refresh).
  const jwt = getJwt();
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      headers,
      body: "{}",
      credentials: "include",
    });
  } catch (err) {
    // Transient network error — leave the session intact so the next tick or
    // the 401 interceptor can retry.
    throw err;
  }

  // Conclusive auth failure: the cookie is gone/expired/revoked. Tear down.
  if (response.status === 401 || response.status === 403) {
    if (useAuthStore.getState().sessionGen === startGen) {
      useAuthStore.getState().logout();
    }
    return null;
  }

  if (!response.ok) {
    // Transient server error — don't kill the session.
    throw new Error(`refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as LoginResponse;

  // The user logged out (or a newer session landed) while we were in flight —
  // don't resurrect a dead session.
  if (useAuthStore.getState().sessionGen !== startGen) return null;

  useAuthStore.getState().applyRefresh(data);
  return data;
}
