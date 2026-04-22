"use client";

import { useEffect } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { SpaceListener } from "@/components/space-listener";
import type { SpaceDetailResponse } from "@/lib/spaces";

interface SpaceClientProps {
  spaceId: string;
  initialData: SpaceDetailResponse;
}

/**
 * Client wrapper for the server-rendered space page.
 *
 * Its only job is to call `sdk.actions.ready()` once on mount (miniapp
 * handshake) and hand the initial server data to the listener. All auth
 * and LiveKit wiring lives in `<SpaceListener />`.
 */
export function SpaceClient({ spaceId, initialData }: SpaceClientProps) {
  useEffect(() => {
    // Await the promise so any error surfaces in devtools. The host keeps
    // the splash screen up until this resolves and suppresses action
    // prompts (signIn, openUrl, etc.) on desktop hosts, per the spec.
    sdk.actions.ready().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[miniapp] sdk.actions.ready failed", err);
    });
  }, []);

  return <SpaceListener spaceId={spaceId} initialData={initialData} />;
}
