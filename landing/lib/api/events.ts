"use client";

/**
 * Room-discovery events WebSocket for the Juke web app.
 *
 * Ported from `farcaster-audio/hooks/useLiveSpaces.ts`. Opens a browser
 * `WebSocket` to `wss://your-api-host.example.com/v1/rooms/events` and invokes
 * `onRoomsChanged` whenever the server pushes a `rooms_changed` event (a room
 * was scheduled/started/cancelled/ended, or an RSVP moved). Reconnects with
 * exponential backoff, and reconnects/refreshes when the tab becomes visible
 * or the network comes back online.
 *
 * `subscribeToRoomEvents` returns an unsubscribe function; call it on unmount.
 */

import { API_BASE_URL } from "@/lib/api/client";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type RoomDiscoveryReason =
  | "room_scheduled"
  | "room_started"
  | "room_cancelled"
  | "room_ended"
  | "rsvp_updated"
  | "participants_changed";

export interface RoomsChangedEvent {
  type: "rooms_changed";
  reason: RoomDiscoveryReason;
  room_id: string;
  status: "active" | "scheduled" | "cancelled" | "ended";
}

type RoomDiscoveryEvent = { type: "ping" } | RoomsChangedEvent;

function roomEventsUrl(): string {
  return `${API_BASE_URL.replace(/^http/, "ws")}/v1/rooms/events`;
}

export interface SubscribeOptions {
  /** Fired on every `rooms_changed` push. */
  onRoomsChanged: (event: RoomsChangedEvent) => void;
  /** Optional: fired when the tab regains visibility/online (refresh hint). */
  onResume?: () => void;
  /** Optional: fired when a socket transitions to OPEN (connected). */
  onOpen?: () => void;
  /** Optional: fired when a socket closes (disconnected, pre-reconnect). */
  onClose?: () => void;
}

/**
 * Open the discovery socket. Returns an idempotent unsubscribe function.
 * No-op (returns a noop cleanup) when called outside the browser.
 */
export function subscribeToRoomEvents({
  onRoomsChanged,
  onResume,
  onOpen,
  onClose,
}: SubscribeOptions): () => void {
  if (typeof window === "undefined") return () => {};

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
      RECONNECT_BASE_MS * 2 ** reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect(): void {
    if (cancelled) return;
    websocket?.close();

    let socket: WebSocket;
    try {
      socket = new WebSocket(roomEventsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    websocket = socket;

    socket.onopen = () => {
      reconnectAttempt = 0;
      onOpen?.();
    };

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as RoomDiscoveryEvent;
        if (payload.type === "rooms_changed") onRoomsChanged(payload);
      } catch {
        // Ignore malformed frames.
      }
    };

    socket.onerror = () => socket.close();

    socket.onclose = () => {
      onClose?.();
      if (websocket === socket) {
        websocket = null;
        scheduleReconnect();
      }
    };
  }

  const handleVisibility = () => {
    if (document.visibilityState === "visible") {
      onResume?.();
      if (!websocket) {
        reconnectAttempt = 0;
        clearReconnectTimer();
        connect();
      }
    }
  };

  const handleOnline = () => {
    onResume?.();
    if (!websocket) {
      reconnectAttempt = 0;
      clearReconnectTimer();
      connect();
    }
  };

  connect();
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("online", handleOnline);

  return () => {
    cancelled = true;
    clearReconnectTimer();
    websocket?.close();
    websocket = null;
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("online", handleOnline);
  };
}
