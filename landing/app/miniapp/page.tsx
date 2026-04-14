"use client";

import { useEffect } from "react";
import sdk from "@farcaster/miniapp-sdk";

const APP_STORE_URL =
  "https://apps.apple.com/app/juke-audio/id6746423951";

export default function MiniAppHome() {
  useEffect(() => {
    sdk.actions.ready();
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6">
      <img
        src="/logomark.png"
        alt=""
        width={64}
        height={64}
        className="mb-4 h-16 w-16 brightness-0 invert"
      />
      <h1 className="mb-2 text-2xl font-bold tracking-[0.15em]">JUKE</h1>
      <p className="mb-8 text-center text-sm text-white/60">
        Voice notes for Farcaster. Record, share, and listen.
      </p>
      <a
        href={APP_STORE_URL}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-[#D85A30] px-8 py-3.5 text-base font-bold text-white transition-colors hover:bg-[#c24e28]"
      >
        Get Juke
      </a>
    </div>
  );
}
