import { useCallback, useEffect } from "react";
import { selectIsReadOnly, useAuthStore } from "@/stores/authStore";
import * as api from "@/services/api";

export function useAuth() {
  const {
    user,
    isAuthenticated,
    isLoading,
    logout: storeLogout,
    hydrate,
  } = useAuthStore();
  const isReadOnly = useAuthStore(selectIsReadOnly);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const logout = useCallback(async () => {
    // Snapshot the refresh token before the local clear wipes it. Best-effort
    // server-side revocation runs first so we still hold the credential we
    // need to authenticate the revocation. `serverLogout` swallows network
    // errors, so a flaky connection never blocks the local logout.
    const refreshToken = useAuthStore.getState().refreshToken;
    await api.serverLogout(refreshToken);
    await storeLogout();
  }, [storeLogout]);

  return {
    user,
    isAuthenticated,
    isLoading,
    /** Signed in but the app signer isn't approved: no writes, show re-link. */
    isReadOnly,
    logout,
  };
}
