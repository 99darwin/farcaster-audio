import { useEffect, useRef, useCallback, useMemo } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useSpaceStore } from "@/stores/spaceStore";
import * as api from "@/services/api";
import { Config } from "@/constants/config";
import { mergeDiscoverySpaces } from "@/hooks/mergeDiscoverySpaces";

const ROOM_EVENTS_RECONNECT_BASE_MS = 1000;
const ROOM_EVENTS_RECONNECT_MAX_MS = 30_000;

type RoomDiscoveryEvent =
  | { type: "ping" }
  | {
      type: "rooms_changed";
      reason:
        | "room_scheduled"
        | "room_started"
        | "room_cancelled"
        | "room_ended"
        | "rsvp_updated";
      room_id: string;
      status: "active" | "scheduled" | "cancelled" | "ended";
    };

const roomEventsUrl = () =>
  `${Config.API_BASE_URL.replace(/^http/, "ws")}/v1/rooms/events`;

export function useLiveSpaces() {
  const setDiscoverySpaces = useSpaceStore((s) => s.setDiscoverySpaces);
  const activeLiveSpaces = useSpaceStore((s) => s.activeLiveSpaces);
  const scheduledSpaces = useSpaceStore((s) => s.scheduledSpaces);
  const farcasterLiveSpaces = useSpaceStore((s) => s.farcasterLiveSpaces);
  const farcasterScheduledSpaces = useSpaceStore(
    (s) => s.farcasterScheduledSpaces,
  );
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const fetchActiveSpaces = useCallback(async () => {
    try {
      const activeRes = await api.listRooms({ status: "active", limit: 20 });
      return activeRes.rooms;
    } catch {
      // Axios errors can carry the authenticated request config. Keep logs
      // useful without exposing Authorization or response payloads.
      console.error("Failed to fetch live spaces");
      return useSpaceStore.getState().activeLiveSpaces;
    }
  }, []);

  const fetchScheduledSpaces = useCallback(async () => {
    try {
      const scheduledRes = await api.listRooms({
        status: "scheduled",
        limit: 20,
      });
      return scheduledRes.rooms;
    } catch {
      console.error("Failed to fetch scheduled spaces");
      return useSpaceStore.getState().scheduledSpaces;
    }
  }, []);

  const fetchFarcasterLive = useCallback(async () => {
    try {
      return await api.fetchFarcasterNativeSpaces({
        status: "live",
        limit: 20,
      });
    } catch {
      // Do not log the raw Axios error: its request config may include JWTs.
      console.error("Failed to fetch Farcaster live spaces");
      return useSpaceStore.getState().farcasterLiveSpaces;
    }
  }, []);

  const fetchFarcasterScheduled = useCallback(async () => {
    try {
      return await api.fetchFarcasterNativeSpaces({
        status: "scheduled",
        limit: 20,
      });
    } catch {
      console.error("Failed to fetch Farcaster scheduled spaces");
      return useSpaceStore.getState().farcasterScheduledSpaces;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!refreshInFlightRef.current) {
      refreshInFlightRef.current = Promise.all([
        fetchActiveSpaces(),
        fetchScheduledSpaces(),
        fetchFarcasterLive(),
        fetchFarcasterScheduled(),
      ])
        .then(([
          activeLiveSpaces,
          scheduledSpaces,
          farcasterLiveSpaces,
          farcasterScheduledSpaces,
        ]) => {
          setDiscoverySpaces({
            activeLiveSpaces,
            scheduledSpaces,
            farcasterLiveSpaces,
            farcasterScheduledSpaces,
          });
        })
        .finally(() => {
          refreshInFlightRef.current = null;
        });
    }
    await refreshInFlightRef.current;
  }, [
    fetchActiveSpaces,
    fetchScheduledSpaces,
    fetchFarcasterLive,
    fetchFarcasterScheduled,
    setDiscoverySpaces,
  ]);

  useEffect(() => {
    let cancelled = false;
    let websocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      const delay = Math.min(
        ROOM_EVENTS_RECONNECT_BASE_MS * 2 ** reconnectAttempt,
        ROOM_EVENTS_RECONNECT_MAX_MS,
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      websocket?.close();

      const socket = new WebSocket(roomEventsUrl());
      websocket = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as RoomDiscoveryEvent;
          if (payload.type === "rooms_changed") {
            void refresh();
          }
        } catch (err) {
          if (__DEV__) console.warn("Invalid room event payload:", err);
        }
      };

      socket.onerror = () => {
        socket.close();
      };

      socket.onclose = () => {
        if (websocket === socket) {
          websocket = null;
          scheduleReconnect();
        }
      };
    };

    void refresh();
    connect();

    const appStateSubscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        if (state === "active") {
          void refresh();
          if (!websocket) connect();
        }
      },
    );

    return () => {
      cancelled = true;
      clearReconnectTimer();
      websocket?.close();
      appStateSubscription.remove();
    };
  }, [refresh]);

  const discoverySpaces = useMemo(() => {
    const merged = mergeDiscoverySpaces({
      jukeLive: activeLiveSpaces,
      jukeScheduled: scheduledSpaces,
      farcasterLive: farcasterLiveSpaces,
      farcasterScheduled: farcasterScheduledSpaces,
    });
    const isLive = (item: (typeof merged)[number]) =>
      item.isFarcasterNative
        ? item.space.state === "live"
        : item.space.status === "active";
    const time = (item: (typeof merged)[number]) => {
      const raw = item.isFarcasterNative
        ? (isLive(item) ? item.space.started_at : item.space.scheduled_at)
        : (isLive(item) ? item.space.started_at : item.space.scheduled_at);
      const parsed = raw ? Date.parse(raw) : NaN;
      return Number.isFinite(parsed)
        ? parsed
        : isLive(item)
          ? 0
          : Number.MAX_SAFE_INTEGER;
    };
    return merged.sort((a, b) => {
      const aLive = isLive(a);
      const bLive = isLive(b);
      if (aLive !== bLive) return aLive ? -1 : 1;
      return aLive ? time(b) - time(a) : time(a) - time(b);
    });
  },
    [
      activeLiveSpaces,
      scheduledSpaces,
      farcasterLiveSpaces,
      farcasterScheduledSpaces,
    ],
  );

  return {
    activeLiveSpaces,
    scheduledSpaces,
    farcasterLiveSpaces,
    farcasterScheduledSpaces,
    discoverySpaces,
    refresh,
  };
}
