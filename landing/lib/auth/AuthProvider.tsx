"use client";

/**
 * Auth context for the Juke web app (`juke.audio/app`).
 *
 * Binds the in-memory session (`session.ts`), the Protocol Auth sign-in flow
 * (`webSignIn.ts`, driven by `FarcasterSignIn` on `/app/login`),
 * the single-flight refresh (`authRefresh.ts`), and the React-facing
 * `authStore` into the stable `useAuth()` surface the rest of the `/app` shell
 * consumes. The exported names/shapes (`useAuth`, `AuthProvider`, `AuthStatus`,
 * `AuthContextValue`) are a contract other workstreams import — do not change
 * them.
 *
 * On mount we attempt a silent cookie refresh (cold-load bootstrap): if the
 * HttpOnly `juke_refresh` cookie is valid the user is signed straight in
 * without any signing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { UserResponse } from "@/lib/api/types";
import { useAuthStore } from "@/lib/stores/authStore";
import { refreshSession } from "@/lib/auth/authRefresh";
import { API_BASE_URL } from "@/lib/api/client";
import { RELINK_PATH, isSignerReadOnly } from "@/lib/auth/signerStatus";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  user: UserResponse | null;
  status: AuthStatus;
  /**
   * Signed in, but the app signer isn't `approved` (contract section 3):
   * write actions will be rejected, so gate them and offer {@link relink}.
   */
  isReadOnly: boolean;
  /** Sends the user to the sign-in screen (`FarcasterSignIn` lives there). */
  signIn: () => Promise<void>;
  /** Sends a read-only user to the sign-in screen's re-link step. */
  relink: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  status: "anonymous",
  isReadOnly: false,
  signIn: async () => {},
  relink: async () => {},
  signOut: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logoutStore = useAuthStore((s) => s.logout);
  const router = useRouter();

  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const didBootstrap = useRef(false);

  // Cold-load bootstrap: trade the HttpOnly refresh cookie for a session.
  useEffect(() => {
    if (didBootstrap.current) return;
    didBootstrap.current = true;

    let active = true;
    (async () => {
      try {
        await refreshSession();
      } catch {
        // Transient failure — remain anonymous; a later action can retry.
      } finally {
        if (active) setIsBootstrapping(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  // Sign-in is driven by `FarcasterSignIn` on the sign-in screen; route there.
  const signIn = useCallback(async () => {
    router.push("/app/login");
  }, [router]);

  const relink = useCallback(async () => {
    router.push(RELINK_PATH);
  }, [router]);

  const signOut = useCallback(async () => {
    // Best-effort server-side revocation; never let a flaky network block the
    // local logout. The endpoint is idempotent.
    try {
      await fetch(`${API_BASE_URL}/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Swallow — local logout always proceeds.
    }
    logoutStore();
  }, [logoutStore]);

  const status: AuthStatus = isBootstrapping
    ? "loading"
    : isAuthenticated
      ? "authenticated"
      : "anonymous";

  const isReadOnly = status === "authenticated" && isSignerReadOnly(user);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, isReadOnly, signIn, relink, signOut }),
    [user, status, isReadOnly, signIn, relink, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
