import { useRef, useCallback, useEffect } from "react";
import { AppState, AppStateStatus } from "react-native";
import { useSpaceStore } from "@/stores/spaceStore";
import { useAuthStore } from "@/stores/authStore";
import * as api from "@/services/api";
import * as livekitService from "@/services/livekit";
import { Config } from "@/constants/config";

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

export function useReconnect() {
  const room = useSpaceStore((s) => s.room);
  const setConnected = useSpaceStore((s) => s.setConnected);
  const setParticipants = useSpaceStore((s) => s.setParticipants);
  const setRoom = useSpaceStore((s) => s.setRoom);
  const setMyRole = useSpaceStore((s) => s.setMyRole);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);
  const user = useAuthStore((s) => s.user);

  const stateRef = useRef<ReconnectState>({
    attempts: 0,
    isReconnecting: false,
    token: "",
    tokenExpiresAt: 0,
    wsUrl: "",
  });

  const isTokenExpiringSoon = useCallback(() => {
    const now = Date.now() / 1000;
    return !Number.isFinite(stateRef.current.tokenExpiresAt) || (
      stateRef.current.tokenExpiresAt - now < Config.TOKEN_REFRESH_BUFFER_SEC
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
      if (wsUrl) {
        stateRef.current.wsUrl = wsUrl;
      }
    },
    [],
  );

  const reconnect = useCallback(async () => {
    if (!room || stateRef.current.isReconnecting) return;

    stateRef.current.isReconnecting = true;
    stateRef.current.attempts = 0;
    setConnected(false);

    while (stateRef.current.attempts < Config.RECONNECT_MAX_ATTEMPTS) {
      const delay = Math.min(
        Config.RECONNECT_BASE_DELAY_MS * Math.pow(2, stateRef.current.attempts),
        30_000,
      );
      await sleep(delay);

      try {
        // 1. Refresh token if needed
        if (isTokenExpiringSoon() || !stateRef.current.token) {
          const { livekit_token, expires_at } = await api.refreshRoomToken(room.id);
          cacheToken(livekit_token, expires_at);
        }

        // 2. Check if room still exists
        const roomData = await api.getRoom(room.id);
        if (roomData.room.status !== "active") {
          leaveSpace();
          stateRef.current.isReconnecting = false;
          return;
        }

        // 3. Reconnect to LiveKit
        await livekitService.disconnectFromRoom();
        await livekitService.connectToRoom(
          stateRef.current.wsUrl || Config.LIVEKIT_WS_URL,
          stateRef.current.token,
        );

        // 4. Restore state
        setRoom(roomData.room);
        setParticipants(roomData.participants);

        const me = roomData.participants.find((p) => p.fid === user?.fid);
        if (!me) {
          // We were kicked while disconnected
          await livekitService.disconnectFromRoom();
          leaveSpace();
          stateRef.current.isReconnecting = false;
          return;
        }

        setMyRole(me.role);
        setConnected(true);
        stateRef.current.attempts = 0;
        stateRef.current.isReconnecting = false;
        return;
      } catch {
        stateRef.current.attempts++;
      }
    }

    // Max attempts reached — give up
    stateRef.current.isReconnecting = false;
    leaveSpace();
  }, [
    room,
    user,
    setConnected,
    setRoom,
    setParticipants,
    setMyRole,
    leaveSpace,
    isTokenExpiringSoon,
    cacheToken,
  ]);

  // Handle app state changes (background/foreground)
  useEffect(() => {
    if (!room) return;

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === "active") {
        // App came to foreground — check connection
        const activeRoom = livekitService.getActiveRoom();
        if (activeRoom?.state !== "connected") {
          reconnect();
        }
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );
    return () => subscription.remove();
  }, [room, reconnect]);

  // Token refresh timer
  useEffect(() => {
    if (!room) return;

    const checkToken = setInterval(() => {
      if (isTokenExpiringSoon()) {
        api
          .refreshRoomToken(room.id)
          .then(({ livekit_token, expires_at }) => {
            cacheToken(livekit_token, expires_at);
          })
          .catch(() => {});
      }
    }, 60_000); // Check every minute

    return () => clearInterval(checkToken);
  }, [room, isTokenExpiringSoon, cacheToken]);

  return {
    reconnect,
    setToken: cacheToken,
    isReconnecting: stateRef.current.isReconnecting,
  };
}
