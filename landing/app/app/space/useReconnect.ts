"use client";

/**
 * Reconnect + token-refresh engine for the web space session.
 *
 * Ported from `farcaster-audio/hooks/useReconnect.ts`. React-Native `AppState`
 * is replaced with `document.visibilitychange` + `window online/offline`; the
 * LiveKit token is proactively refreshed (LiveKit tokens are long-lived — ~6h —
 * so the timer just tops it up before expiry) via `POST /v1/rooms/{id}/token`.
 *
 * Native rooms are never reconnected here (the web app can't participate in
 * them in Phase 1), so the whole engine short-circuits for them.
 */

import { useCallback, useEffect, useRef } from "react";
import { useSpaceStore, type SessionParticipant } from "@/lib/space/spaceStore";
import { getUser } from "@/lib/auth/session";
import { refreshRoomToken, getSpaceDetail } from "@/lib/space/spaceApi";
import * as livekit from "@/lib/space/livekit";
import type { SpaceParticipant } from "@/lib/spaces";

const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const TOKEN_REFRESH_BUFFER_SEC = 5 * 60;
const TOKEN_CHECK_INTERVAL_MS = 60_000;

interface ReconnectState {
  attempts: number;
  isReconnecting: boolean;
  token: string;
  tokenExpiresAt: number;
  wsUrl: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a wire participant into the live-session shape (adds `is_speaking`). */
function toSessionParticipant(p: SpaceParticipant): SessionParticipant {
  return {
    fid: p.fid,
    role: p.role as SessionParticipant["role"],
    is_muted: p.is_muted,
    is_speaking: false,
    hand_raised: p.hand_raised,
    display_name: p.display_name,
    pfp_url: p.pfp_url,
  };
}

export function useReconnect() {
  const room = useSpaceStore((s) => s.room);
  const setConnected = useSpaceStore((s) => s.setConnected);
  const setParticipants = useSpaceStore((s) => s.setParticipants);
  const setRoom = useSpaceStore((s) => s.setRoom);
  const setMyRole = useSpaceStore((s) => s.setMyRole);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);

  const stateRef = useRef<ReconnectState>({
    attempts: 0,
    isReconnecting: false,
    token: "",
    tokenExpiresAt: 0,
    wsUrl: "",
  });

  const isTokenExpiringSoon = useCallback(() => {
    const now = Date.now() / 1000;
    return (
      !Number.isFinite(stateRef.current.tokenExpiresAt) ||
      stateRef.current.tokenExpiresAt - now < TOKEN_REFRESH_BUFFER_SEC
    );
  }, []);

  const cacheToken = useCallback(
    (token: string, expiresAt?: string | null, wsUrl?: string | null) => {
      stateRef.current.token = token;
      if (expiresAt) {
        const parsed = new Date(expiresAt).getTime() / 1000;
        stateRef.current.tokenExpiresAt = Number.isFinite(parsed) ? parsed : 0;
      } else {
        stateRef.current.tokenExpiresAt = 0;
      }
      if (wsUrl) stateRef.current.wsUrl = wsUrl;
    },
    [],
  );

  const reconnect = useCallback(async () => {
    if (!room || room.is_farcaster_native) return;
    if (stateRef.current.isReconnecting) return;

    stateRef.current.isReconnecting = true;
    stateRef.current.attempts = 0;
    setConnected(false);

    while (stateRef.current.attempts < RECONNECT_MAX_ATTEMPTS) {
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** stateRef.current.attempts,
        RECONNECT_MAX_DELAY_MS,
      );
      await sleep(delay);

      try {
        // 1. Refresh the token if it's near expiry (or missing).
        if (isTokenExpiringSoon() || !stateRef.current.token) {
          const { livekit_token, expires_at } = await refreshRoomToken(room.id);
          cacheToken(livekit_token, expires_at);
        }

        // 2. Confirm the room still exists + is live.
        const detail = await getSpaceDetail(room.id);
        if (!detail || detail.room.status !== "active") {
          await leaveSpace();
          stateRef.current.isReconnecting = false;
          return;
        }

        // 3. Reconnect LiveKit with the same SFU URL.
        await livekit.disconnectFromRoom();
        await livekit.connectToRoom(
          stateRef.current.wsUrl,
          stateRef.current.token,
        );

        // 4. Restore participant + role state.
        setRoom(detail.room);
        setParticipants(detail.participants.map(toSessionParticipant));

        const myFid = getUser()?.fid;
        const me = detail.participants.find((p) => p.fid === myFid);
        if (!me) {
          // Kicked while disconnected.
          await livekit.disconnectFromRoom();
          await leaveSpace();
          stateRef.current.isReconnecting = false;
          return;
        }

        setMyRole(me.role as SessionParticipant["role"]);
        setConnected(true);
        stateRef.current.attempts = 0;
        stateRef.current.isReconnecting = false;
        return;
      } catch {
        stateRef.current.attempts += 1;
      }
    }

    stateRef.current.isReconnecting = false;
    await leaveSpace();
  }, [
    room,
    setConnected,
    setRoom,
    setParticipants,
    setMyRole,
    leaveSpace,
    isTokenExpiringSoon,
    cacheToken,
  ]);

  // Reconnect when the tab regains focus or the network returns.
  useEffect(() => {
    if (!room || room.is_farcaster_native) return;

    const maybeReconnect = () => {
      const activeRoom = livekit.getActiveRoom();
      if (activeRoom?.state !== "connected") void reconnect();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") maybeReconnect();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", maybeReconnect);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", maybeReconnect);
    };
  }, [room, reconnect]);

  // Proactive token top-up.
  useEffect(() => {
    if (!room || room.is_farcaster_native) return;

    const timer = setInterval(() => {
      if (isTokenExpiringSoon()) {
        refreshRoomToken(room.id)
          .then(({ livekit_token, expires_at }) => {
            cacheToken(livekit_token, expires_at);
          })
          .catch(() => {});
      }
    }, TOKEN_CHECK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [room, isTokenExpiringSoon, cacheToken]);

  return {
    reconnect,
    setToken: cacheToken,
    isReconnecting: stateRef.current.isReconnecting,
  };
}
