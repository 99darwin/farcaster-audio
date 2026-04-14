import { useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/authStore";
import * as api from "@/services/api";
import { clearAll } from "@/services/storage";

export function useAuth() {
  const {
    user,
    isAuthenticated,
    isLoading,
    setAuth,
    logout: storeLogout,
    hydrate,
  } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const login = useCallback(
    async (signerUuid: string, fid: number) => {
      try {
        const response = await api.login({ signer_uuid: signerUuid, fid });
        await setAuth(response);
        return response;
      } catch (error) {
        console.error("Login failed:", error);
        throw error;
      }
    },
    [setAuth],
  );

  const logout = useCallback(async () => {
    try {
      await clearAll();
      await storeLogout();
    } catch (error) {
      console.error("Logout error:", error);
      // Still clear local state even if remote logout fails
      await storeLogout();
    }
  }, [storeLogout]);

  const refreshIfNeeded = useCallback(async () => {
    // Token refresh is handled by the API client interceptor
    // This is a manual trigger if needed
    const tokens = await import("@/services/storage").then((s) =>
      s.getTokens(),
    );
    if (!tokens) return false;
    try {
      const response = await api.refreshAuth({
        refresh_token: tokens.refreshToken,
      });
      await setAuth(response);
      return true;
    } catch {
      return false;
    }
  }, [setAuth]);

  return {
    user,
    isAuthenticated,
    isLoading,
    login,
    logout,
    refreshIfNeeded,
  };
}
