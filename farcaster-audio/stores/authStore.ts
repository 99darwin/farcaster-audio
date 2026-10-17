import { create } from "zustand";
import type { UserProfile } from "@/types/user";
import type { LoginResponse } from "@/types/api";
import {
  saveTokens,
  getTokens,
  clearAll,
  saveUserProfile,
  getUserProfile,
} from "@/services/storage";
import { clearAllComposerDrafts } from "@/services/composerDrafts";

interface AuthStore {
  user: UserProfile | null;
  jwt: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * Monotonic counter bumped on every login/logout. The shared refresh
   * singleton snapshots this before its network call and discards the
   * response if the value changed mid-flight, preventing a stale refresh
   * from resurrecting a session the user just ended.
   */
  sessionGen: number;

  setAuth: (response: LoginResponse) => Promise<void>;
  applyRefresh: (response: LoginResponse) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * The backend rejected a write with `signer_not_linked`: flip the local
   * user to read-only so the re-link prompt shows without a re-login.
   */
  markSignerNotLinked: () => Promise<void>;
  hydrate: () => Promise<void>;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  jwt: null,
  refreshToken: null,
  expiresAt: null,
  isAuthenticated: false,
  isLoading: true,
  sessionGen: 0,

  setAuth: async (response: LoginResponse) => {
    await saveTokens(response.jwt, response.refresh_token, response.expires_at);
    await saveUserProfile(response.user);
    set({
      user: response.user,
      jwt: response.jwt,
      refreshToken: response.refresh_token,
      expiresAt: response.expires_at,
      isAuthenticated: true,
      isLoading: false,
      sessionGen: get().sessionGen + 1,
    });
  },

  applyRefresh: async (response: LoginResponse) => {
    await saveTokens(response.jwt, response.refresh_token, response.expires_at);
    await saveUserProfile(response.user);
    set({
      user: response.user,
      jwt: response.jwt,
      refreshToken: response.refresh_token,
      expiresAt: response.expires_at,
      isAuthenticated: true,
    });
  },

  logout: async () => {
    await clearAll();
    // Unsent Direct Cast drafts are private to the signed-in account.
    await clearAllComposerDrafts();
    set({
      user: null,
      jwt: null,
      refreshToken: null,
      expiresAt: null,
      isAuthenticated: false,
      isLoading: false,
      sessionGen: get().sessionGen + 1,
    });
  },

  markSignerNotLinked: async () => {
    const user = get().user;
    if (!user || user.signer_status === "revoked") return;
    const updated: UserProfile = { ...user, signer_status: "revoked" };
    set({ user: updated });
    await saveUserProfile(updated);
  },

  hydrate: async () => {
    try {
      const tokens = await getTokens();
      const profile = await getUserProfile();
      if (tokens && profile) {
        set({
          user: profile,
          jwt: tokens.jwt,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          isAuthenticated: true,
          isLoading: false,
        });
      } else {
        set({ isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  setLoading: (loading: boolean) => set({ isLoading: loading }),
}));

/**
 * Read-only mode (auth contract §3): signed in, but the Juke app signer isn't
 * `approved` in KeyRegistry. Profiles saved before the Hypersnap cutover have
 * no `signer_status` and count as unlinked, so legacy sessions land on the
 * re-link prompt rather than failing writes.
 */
export function selectIsReadOnly(state: Pick<AuthStore, "isAuthenticated" | "user">): boolean {
  return state.isAuthenticated && state.user?.signer_status !== "approved";
}
