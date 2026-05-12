"use client";

import { useEffect, useMemo } from "react";

export default function EmbedAuthCallbackPage() {
  const payload = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const signerUuid = params.get("signer_uuid");
    const fid = params.get("fid");
    const nonce = params.get("nonce");
    if (!signerUuid || !fid || !nonce) return null;
    const isAuthenticated = params.get("is_authenticated") !== "false";
    if (!isAuthenticated) return null;
    return {
      is_authenticated: true,
      signer_uuid: signerUuid,
      fid,
      nonce,
    };
  }, []);

  useEffect(() => {
    if (!payload) {
      window.close();
      return;
    }
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
    window.close();
  }, [payload]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0f0f23] px-5 text-white">
      <div className="max-w-sm text-center">
        <img
          src="/logomark.png"
          alt=""
          width={44}
          height={44}
          className="mx-auto mb-5 h-11 w-11"
        />
        <h1 className="text-2xl font-black">
          {payload ? "Finishing sign in" : "Sign in cancelled"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-white/50">
          {payload
            ? "You can return to the Juke space."
            : "Close this window and keep listening anonymously."}
        </p>
      </div>
    </main>
  );
}
