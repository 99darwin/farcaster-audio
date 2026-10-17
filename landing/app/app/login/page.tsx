"use client";

/**
 * Sign-in screen for the Juke web app.
 *
 * "Connect Farcaster to post" — Protocol Auth on Hypersnap: this browser's
 * auth address signs in; the first time on a browser, the recovery phrase
 * approves it on-chain (see `FarcasterSignIn`). Already-authenticated users
 * are bounced to the app home — except a read-only user who followed the
 * re-link prompt (`?relink=1`), who lands straight on the link step.
 */

import { Suspense, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FarcasterSignIn } from "@/components/auth/FarcasterSignIn";
import { useAuth } from "@/lib/auth/AuthProvider";
import { isRelinkRequest } from "@/lib/auth/signerStatus";
import { useAuthStore } from "@/lib/stores/authStore";
import type { LoginResponse } from "@/lib/api/types";

export default function LoginPage() {
  // `useSearchParams` needs a Suspense boundary to keep the page prerenderable;
  // the fallback is the ordinary sign-in screen, so the static HTML keeps it.
  return (
    <Suspense fallback={<LoginScreen isRelinkRequested={false} />}>
      <SearchParamsLoginScreen />
    </Suspense>
  );
}

function SearchParamsLoginScreen() {
  const searchParams = useSearchParams();
  return <LoginScreen isRelinkRequested={isRelinkRequest(searchParams)} />;
}

function LoginScreen({ isRelinkRequested }: { isRelinkRequested: boolean }) {
  const { status, user, isReadOnly } = useAuth();
  const router = useRouter();

  const relinkFid =
    isRelinkRequested && isReadOnly && user ? user.fid : undefined;

  useEffect(() => {
    if (status === "authenticated" && relinkFid === undefined) {
      router.replace("/app");
    }
  }, [status, relinkFid, router]);

  const handleLogin = useCallback(
    (response: LoginResponse) => {
      useAuthStore.getState().setAuth(response);
      router.replace("/app");
    },
    [router],
  );

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center gap-8 px-6 py-12">
      <div className="flex flex-col gap-3 text-center">
        <h1 className="text-2xl font-semibold text-juke-text-on-dark">
          {relinkFid === undefined
            ? "Connect Farcaster to post"
            : "Re-link to post"}
        </h1>
        <p className="text-sm text-juke-text-on-dark-secondary">
          {relinkFid === undefined
            ? "Sign in with Farcaster to join live spaces, cast, react, and host. Your session stays on this device."
            : "Juke's posting key for your account isn't approved, so you're read-only. Approve it again to cast, react, and host."}
        </p>
      </div>

      {/* Remount when the relink target appears (auth bootstraps after mount). */}
      <FarcasterSignIn
        key={relinkFid ?? "sign-in"}
        relinkFid={relinkFid}
        onLogin={handleLogin}
      />
    </main>
  );
}
