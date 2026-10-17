"use client";

import { useCallback, useEffect, useState } from "react";
import { FarcasterSignIn } from "@/components/auth/FarcasterSignIn";
import type { LoginResponse } from "@/lib/api/types";
import {
  EMBED_AUTH_OPTIONS,
  hasSameOriginOpener,
  isFramed,
  postLoginResponseToOpener,
} from "@/lib/embed-sign-in-popup";

type WindowState = "checking" | "ready" | "framed" | "no-opener" | "done";

const UNAVAILABLE_MESSAGES: Record<"framed" | "no-opener", string> = {
  framed: "Open juke.audio directly to sign in.",
  "no-opener":
    "This window signs you in to a Juke embed. Start from the embed's “Sign in to participate” button.",
};

/**
 * Renders the web sign-in (auth address, or a one-time recovery-phrase link)
 * only as a top-level window opened by a same-origin Juke embed, then posts
 * the session back and closes.
 */
export function EmbedSignInWindow() {
  const [state, setState] = useState<WindowState>("checking");

  useEffect(() => {
    if (isFramed()) setState("framed");
    else if (!hasSameOriginOpener()) setState("no-opener");
    else setState("ready");
  }, []);

  const handleLogin = useCallback((response: LoginResponse) => {
    if (!postLoginResponseToOpener(response)) {
      setState("no-opener");
      return;
    }
    setState("done");
    window.close();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-8 bg-[#0f0f23] px-6 py-12 text-white">
      <div className="flex flex-col gap-3 text-center">
        <h1 className="text-2xl font-semibold">Sign in to participate</h1>
        <p className="text-sm text-white/60">
          You&apos;re on juke.audio. Your session goes back to the space you
          came from.
        </p>
      </div>

      {state === "ready" && (
        <FarcasterSignIn
          onLogin={handleLogin}
          label="Sign in with Farcaster"
          authOptions={EMBED_AUTH_OPTIONS}
        />
      )}
      {(state === "framed" || state === "no-opener") && (
        <p className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-center text-sm text-white/70">
          {UNAVAILABLE_MESSAGES[state]}
        </p>
      )}
      {state === "done" && (
        <p className="text-center text-sm text-white/70">
          Signed in. You can close this window.
        </p>
      )}
    </main>
  );
}
