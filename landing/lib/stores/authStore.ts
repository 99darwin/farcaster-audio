/**
 * React-facing auth store for the Juke web app.
 *
 * Mirrors the mobile `stores/authStore.ts` but adapted for the browser:
 *   - The raw JWT lives in `lib/auth/session.ts` (module memory), NOT here.
 *   - The durable credential is the HttpOnly `juke_refresh` cookie, so there
 *     is no refresh token to persist.
 *
 * This store holds only what React needs to render: the user and auth status.
 * `sessionGen` is the security-critical piece — a monotonic counter bumped on
 * every login/logout that the shared refresh singleton snapshots before its
 * network call, discarding a stale refresh that would otherwise resurrect a
 * session the user just ended.
 */

import { create } from "zustand";
import type { LoginResponse, UserResponse } from "@/lib/api/types";
import { setSession, clearSession, getUser } from "@/lib/auth/session";
import { clearAllPersistedDrafts } from "@/lib/messages/draft-storage";

interface AuthStore {
  user: UserResponse | null;
  isAuthenticated: boolean;
  /**
   * Monotonic counter bumped on login/logout. `authRefresh.ts` snapshots this
   * before its network call and discards the response if it changed mid-flight.
   */
  sessionGen: number;

  /** New interactive login (Protocol Auth). Bumps sessionGen. */
  setAuth: (response: LoginResponse) => void;
  /** Silent refresh landed. Does NOT bump sessionGen. */
  applyRefresh: (response: LoginResponse) => void;
  /** Clear session + bump sessionGen so in-flight refreshes are discarded. */
  logout: () => void;
  /** Re-derive React state from the in-memory session (post cold-load). */
  hydrate: () => void;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  isAuthenticated: false,
  sessionGen: 0,

  setAuth: (response) => {
    setSession(response);
    set({
      user: response.user,
      isAuthenticated: true,
      sessionGen: get().sessionGen + 1,
    });
  },

  applyRefresh: (response) => {
    setSession(response);
    set({ user: response.user, isAuthenticated: true });
  },

  logout: () => {
    clearSession();
    // Unsent Direct Cast drafts must not outlive the session on this device.
    clearAllPersistedDrafts();
    set({
      user: null,
      isAuthenticated: false,
      sessionGen: get().sessionGen + 1,
    });
  },

  hydrate: () => {
    const user = getUser();
    set({ user, isAuthenticated: user !== null });
  },
}));
