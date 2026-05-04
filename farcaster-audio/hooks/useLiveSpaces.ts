import { useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useSpaceStore } from "@/stores/spaceStore";
import * as api from "@/services/api";
import { Config } from "@/constants/config";

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
  const setActiveLiveSpaces = useSpaceStore((s) => s.setActiveLiveSpaces);
  const setScheduledSpaces = useSpaceStore((s) => s.setScheduledSpaces);
  const activeLiveSpaces = useSpaceStore((s) => s.activeLiveSpaces);
  const scheduledSpaces = useSpaceStore((s) => s.scheduledSpaces);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const fetchActiveSpaces = useCallback(async () => {
    try {
      const activeRes = await api.listRooms({ status: "active", limit: 20 });
      setActiveLiveSpaces(activeRes.rooms);
    } catch (err) {
      console.error("Failed to fetch live spaces:", err);
    }
  }, [setActiveLiveSpaces]);

  const fetchScheduledSpaces = useCallback(async () => {
    try {
      const scheduledRes = await api.listRooms({
        status: "scheduled",
        limit: 20,
      });
      setScheduledSpaces(scheduledRes.rooms);
    } catch (err) {
      console.error("Failed to fetch scheduled spaces:", err);
    }
  }, [setScheduledSpaces]);

  const refresh = useCallback(async () => {
    if (!refreshInFlightRef.current) {
      refreshInFlightRef.current = Promise.all([
        fetchActiveSpaces(),
        fetchScheduledSpaces(),
      ])
        .then(() => undefined)
        .finally(() => {
          refreshInFlightRef.current = null;
        });
    }
    await refreshInFlightRef.current;
  }, [fetchActiveSpaces, fetchScheduledSpaces]);

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

  return { activeLiveSpaces, scheduledSpaces, refresh };
}
