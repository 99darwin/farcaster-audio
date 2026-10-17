"use client";

import { useEffect } from "react";

import { nativeHeartbeat } from "@/lib/native/nativeSpaceApi";
import { isProducingAudio } from "@/lib/space/audioMixer";

const HEARTBEAT_INTERVAL_MS = 30_000;
/** Fire once shortly after going live so the upstream timer resets promptly. */
const HEARTBEAT_KICK_MS = 2_000;

/**
 * Keep a Farcaster-native space alive while the local user is publishing audio.
 *
 * Farcaster auto-ends a native space after 10 minutes with no reported
 * host/cohost/speaker activity. Audio published through our web LiveKit client
 * (including external audio piped through the mixer) isn't automatically
 * credited to a FID upstream, so while we're actively producing audio we POST
 * an active-speaker heartbeat for our own fid every ~30s.
 *
 * Gated on `isProducingAudio()` so a fully-muted publisher stops reporting and
 * the space is allowed to time out — matching Farcaster's "stop heartbeats when
 * the stream is silent." Pass `active` = live && native && can-publish.
 */
export function useNativeHeartbeat(params: {
  active: boolean;
  roomId: string | undefined;
  fid: number | undefined;
}): void {
  const { active, roomId, fid } = params;

  useEffect(() => {
    if (!active || !roomId || !fid) return;

    const beat = async () => {
      if (!isProducingAudio()) return;
      try {
        await nativeHeartbeat(roomId, fid);
      } catch {
        // Best-effort keepalive — a dropped beat is recovered by the next tick.
      }
    };

    const kick = setTimeout(() => void beat(), HEARTBEAT_KICK_MS);
    const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
    };
  }, [active, roomId, fid]);
}
