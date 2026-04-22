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
    sdk.actions.ready();
  }, []);

  return <SpaceListener spaceId={spaceId} initialData={initialData} />;
}
