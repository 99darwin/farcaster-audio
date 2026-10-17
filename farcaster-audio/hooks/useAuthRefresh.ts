import { useEffect } from "react";
import { AppState, AppStateStatus } from "react-native";
import { useAuthStore } from "@/stores/authStore";
import { refreshSession } from "@/services/authRefresh";
import { Config } from "@/constants/config";

const CHECK_INTERVAL_MS = 60_000;

function expiresWithinBuffer(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return Date.now() >= expiresAtMs - Config.TOKEN_REFRESH_BUFFER_SEC * 1000;
}

/**
 * Proactively refreshes the JWT before it expires. Delegates the actual
 * refresh to the shared singleton in `services/authRefresh` so this hook
 * and the 401 interceptor in `api.ts` cooperate on a single in-flight
 * request — avoiding double-spends of the one-time refresh token.
 *
 * Mount once at the root.
 */
export function useAuthRefresh() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const expiresAt = useAuthStore((s) => s.expiresAt);

  const maybeRefresh = (force = false) => {
    if (!useAuthStore.getState().isAuthenticated) return;
    if (!force && !expiresWithinBuffer(useAuthStore.getState().expiresAt)) {
      return;
    }
    // Singleton handles de-duping and error semantics. Swallow rejections
    // here — the singleton only logs the user out on real 401/403; anything
    // else is transient and will be retried on the next tick.
    refreshSession().catch(() => {});
  };

  // Cold-start + reactive: refresh as soon as we're authenticated with a
  // JWT already in the buffer window (e.g. after `hydrate()` restores a
  // near-expired session from SecureStore).
  useEffect(() => {
    if (!isAuthenticated) return;
    if (expiresWithinBuffer(expiresAt)) maybeRefresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, expiresAt]);

  // Periodic check while authenticated.
  useEffect(() => {
    if (!isAuthenticated) return;
    const id = setInterval(() => maybeRefresh(), CHECK_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // Foreground transitions — phones background apps for hours, so check the
  // moment we come back to active before any user-initiated request fires.
  useEffect(() => {
    if (!isAuthenticated) return;
    const handle = (next: AppStateStatus) => {
      if (next === "active") maybeRefresh();
    };
    const sub = AppState.addEventListener("change", handle);
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);
}
