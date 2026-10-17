import axios from "axios";
import { Config } from "@/constants/config";
import { getTokens } from "@/services/storage";
import { useAuthStore } from "@/stores/authStore";
import type { LoginResponse } from "@/types/api";

const REFRESH_TIMEOUT_MS = 15_000;

let inFlight: Promise<LoginResponse | null> | null = null;

/**
 * Shared refresh entry point. Both the proactive `useAuthRefresh` hook and the
 * 401 interceptor in `api.ts` route through this singleton so they never
 * double-spend the one-time refresh token. Returns the new `LoginResponse` on
 * success, `null` if the session was invalidated mid-flight (the caller should
 * stop using the old tokens). Throws on transient errors that don't kill the
 * session — callers should swallow and let the next tick try again.
 */
export function refreshSession(): Promise<LoginResponse | null> {
  if (inFlight) return inFlight;
  inFlight = runRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runRefresh(): Promise<LoginResponse | null> {
  const tokens = await getTokens();
  if (!tokens?.refreshToken) {
    await useAuthStore.getState().logout();
    return null;
  }
  const startGen = useAuthStore.getState().sessionGen;
  try {
    const { data } = await axios.post<LoginResponse>(
      `${Config.API_BASE_URL}/v1/auth/refresh`,
      { refresh_token: tokens.refreshToken },
      {
        headers: { Authorization: `Bearer ${tokens.jwt}` },
        timeout: REFRESH_TIMEOUT_MS,
      },
    );
    // The user logged out (or a newer refresh already landed) while our
    // request was in flight — don't resurrect a dead session.
    if (useAuthStore.getState().sessionGen !== startGen) return null;
    await useAuthStore.getState().applyRefresh(data);
    return data;
  } catch (err) {
    if (useAuthStore.getState().sessionGen !== startGen) return null;
    // Only force logout on conclusive auth failures. Transient network errors
    // (offline, DNS, 5xx, timeout) leave the existing tokens intact so the
    // next AppState/interval tick — or the 401 interceptor — can retry.
    if (
      axios.isAxiosError(err) &&
      err.response &&
      (err.response.status === 401 || err.response.status === 403)
    ) {
      await useAuthStore.getState().logout();
    }
    throw err;
  }
}
