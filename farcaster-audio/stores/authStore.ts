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

interface AuthStore {
  user: UserProfile | null;
  jwt: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  // Actions
  setAuth: (response: LoginResponse) => Promise<void>;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  jwt: null,
  refreshToken: null,
  isAuthenticated: false,
  isLoading: true,

  setAuth: async (response: LoginResponse) => {
    await saveTokens(response.jwt, response.refresh_token);
    await saveUserProfile(response.user);
    set({
      user: response.user,
      jwt: response.jwt,
      refreshToken: response.refresh_token,
      isAuthenticated: true,
      isLoading: false,
    });
  },

  logout: async () => {
    await clearAll();
    set({
      user: null,
      jwt: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
    });
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
