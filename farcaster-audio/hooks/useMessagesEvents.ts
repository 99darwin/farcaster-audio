/**
 * Subscribes to `WS /v1/messages/events` (design §3.4, §4.2) with the same
 * reconnect discipline as `useLiveSpaces`: exponential backoff, reconnect on
 * foreground, keepalive pings.
 *
 * Auth (§4.2): every connect and reconnect first mints a single-use ticket
 * (`POST /events/ticket`) and connects with `?ticket=`; the JWT never goes in
 * the URL. A 401 from the mint is handled like a bare 4401 close. Any other
 * mint failure takes the same path as the matching close (feature off stops,
 * rate limit waits a minute, everything else backs off).
 *
 * The socket layer never signs the user out. Refreshing goes through the
 * shared REST refresh (`refreshSession`), which signs out only on a
 * conclusive refresh failure; everything the socket can't recover from just
 * gives up realtime (`realtimeStatus: "disconnected"`) while the inbox and
 * thread polls carry on.
 *
 * Close codes (§4.7):
 *   4401        reason `ticket_rejected`: the ticket alone was bad (expired,
 *               reused); mint a fresh one and reconnect with backoff, no
 *               refresh. Reason `session_expired` (the JWT lapsed
 *               mid-stream) or no reason: refresh once, mint, reconnect.
 *               `session_expired` always refreshes. A refresh that throws
 *               (network) or a JWT still rejected after a refresh backs off
 *               exponentially; after `MAX_AUTH_RECOVERY_FAILURES` in a row
 *               realtime gives up until the app next comes to the foreground.
 *   4403        no usable Direct Cast token: stop, record the token error so the
 *               "Enable messages" gate shows; polling carries real-time.
 *   4404        feature off: stop and re-read `GET /status`.
 *   4429        rate limited: back off at least 60 s.
 *   other/drop  exponential backoff.
 *
 * On foreground the socket is replaced when it is not OPEN or has been
 * silent for longer than the server's ping interval allows (a half-open
 * socket after the OS suspended the app).
 */

import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { Config } from "@/constants/config";
import { getTokens } from "@/services/storage";
import { refreshSession } from "@/services/authRefresh";
import {
  createMessagesEventsTicket,
  MessagesApiError,
  messagesEventsUrl,
  toMessagingTokenError,
} from "@/services/messagesApi";
import {
  useMessageStore,
  type MessagingAccessError,
} from "@/stores/messageStore";
import { refreshMessagingAvailability } from "@/utils/messagesErrors";
import type { MessagesEvent } from "@/types/messages";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const KEEPALIVE_MS = 25_000;
/** The server pings after 25 s idle; 60 s of silence means a dead socket. */
export const STALE_SOCKET_MS = 60_000;
/** Minimum wait after a 4429 close. */
export const RATE_LIMITED_RECONNECT_MS = 60_000;

export const MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE = 4401;
/** No usable Direct Cast token; `reason` carries the `messaging_token_*` code. */
export const MESSAGES_WS_NO_SIGNER_CLOSE_CODE = 4403;
export const MESSAGES_WS_DISABLED_CLOSE_CODE = 4404;
export const MESSAGES_WS_RATE_LIMITED_CLOSE_CODE = 4429;
/** 4401 reason when the issuing JWT's `exp` passed on an open socket. */
export const MESSAGES_WS_SESSION_EXPIRED_REASON = "session_expired";
/** 4401 reason when only the ticket was refused; the JWT is still good. */
export const MESSAGES_WS_TICKET_REJECTED_REASON = "ticket_rejected";
/** Consecutive auth-recovery failures before realtime gives up. */
export const MAX_AUTH_RECOVERY_FAILURES = 5;

const WS_OPEN = 1;

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "message",
  "read",
  "inbox",
  "ping",
]);

export function parseMessagesEvent(raw: unknown): MessagesEvent | null {
  try {
    const value: unknown = JSON.parse(String(raw));
    if (!value || typeof value !== "object") return null;
    const type = (value as { type?: unknown }).type;
    if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;
    return value as MessagesEvent;
  } catch {
    return null;
  }
}

export type CloseAction =
  | { kind: "refresh_auth"; isSessionExpired: boolean }
  | { kind: "remint" }
  | { kind: "stop_access"; accessError: MessagingAccessError }
  | { kind: "stop_disabled" }
  | { kind: "backoff"; minDelayMs: number };

/** What to do after the socket closes with `code` / `reason`. */
export function classifyClose(code: number | undefined, reason: string | undefined): CloseAction {
  switch (code) {
    case MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE:
      if (reason === MESSAGES_WS_TICKET_REJECTED_REASON) return { kind: "remint" };
      return {
        kind: "refresh_auth",
        isSessionExpired: reason === MESSAGES_WS_SESSION_EXPIRED_REASON,
      };
    case MESSAGES_WS_NO_SIGNER_CLOSE_CODE:
      return {
        kind: "stop_access",
        accessError: toMessagingTokenError(reason || null),
      };
    case MESSAGES_WS_DISABLED_CLOSE_CODE:
      return { kind: "stop_disabled" };
    case MESSAGES_WS_RATE_LIMITED_CLOSE_CODE:
      return { kind: "backoff", minDelayMs: RATE_LIMITED_RECONNECT_MS };
    default:
      return { kind: "backoff", minDelayMs: 0 };
  }
}

/** What to do when minting the connect ticket fails (mirrors `classifyClose`). */
export function classifyTicketError(error: unknown): CloseAction {
  if (!(error instanceof MessagesApiError)) return { kind: "backoff", minDelayMs: 0 };
  switch (error.code) {
    case "unauthorized":
      return { kind: "refresh_auth", isSessionExpired: false };
    case "unavailable":
    case "not_found":
      // The router is gated by `MESSAGING_ENABLED`; a 404 here means it is off.
      return { kind: "stop_disabled" };
    case "rate_limited":
      return { kind: "backoff", minDelayMs: RATE_LIMITED_RECONNECT_MS };
    default:
      return { kind: "backoff", minDelayMs: 0 };
  }
}

export function computeReconnectDelay(attempt: number, minDelayMs: number): number {
  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return Math.max(exponential, minDelayMs);
}

/** True when an open socket has been silent long enough to be presumed dead. */
export function isSocketSilent(lastFrameAt: number, now: number): boolean {
  return now - lastFrameAt > STALE_SOCKET_MS;
}

/** True when a foregrounded app should replace its socket. */
export function shouldReconnectOnResume({
  readyState,
  lastFrameAt,
  now,
}: {
  readyState: number | null;
  lastFrameAt: number;
  now: number;
}): boolean {
  if (readyState !== WS_OPEN) return true;
  return isSocketSilent(lastFrameAt, now);
}

export function useMessagesEvents(
  enabled: boolean,
  onEvent: (event: MessagesEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    const setRealtimeStatus = useMessageStore.getState().setRealtimeStatus;
    let cancelled = false;
    /** No more reconnects (access, feature off, session over, gave up). */
    let isStopped = false;
    /** Stopped only because recovery kept failing; a foreground retries. */
    let hasGivenUp = false;
    /** A refresh landed and no socket has opened on the new JWT yet. */
    let hasRefreshedAuth = false;
    let authRecoveryFailures = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let lastFrameAt = 0;
    let pendingMinDelayMs = 0;

    const clearKeepalive = () => {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    };

    const clearTimers = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearKeepalive();
    };

    /** Detach first so the old socket's `onclose` sees it was superseded. */
    const closeSocket = () => {
      const current = socket;
      socket = null;
      current?.close();
    };

    const scheduleReconnect = (minDelayMs: number) => {
      if (cancelled || isStopped || reconnectTimer) return;
      const delay = computeReconnectDelay(attempt, minDelayMs);
      pendingMinDelayMs = minDelayMs;
      attempt += 1;
      setRealtimeStatus("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const stop = () => {
      isStopped = true;
      clearTimers();
      setRealtimeStatus("disconnected");
    };

    /** Realtime only: polling keeps the inbox and open thread fresh. */
    const giveUp = () => {
      stop();
      hasGivenUp = true;
    };

    const recordAuthRecoveryFailure = () => {
      authRecoveryFailures += 1;
      if (authRecoveryFailures >= MAX_AUTH_RECOVERY_FAILURES) {
        giveUp();
        return;
      }
      scheduleReconnect(0);
    };

    const handleUnauthorized = async (isSessionExpired: boolean) => {
      // A mid-stream expiry follows a healthy session: always refresh.
      if (isSessionExpired) hasRefreshedAuth = false;
      if (hasRefreshedAuth) {
        // Still rejected on the refreshed JWT. Signing out is the REST
        // layer's call, never the socket's: back off and mint again.
        recordAuthRecoveryFailure();
        return;
      }
      hasRefreshedAuth = true;
      let refreshed: unknown;
      try {
        refreshed = await refreshSession();
      } catch {
        // Transient (offline, timeout, 5xx): the session may be fine. Allow
        // another refresh on the next cycle.
        if (cancelled) return;
        hasRefreshedAuth = false;
        recordAuthRecoveryFailure();
        return;
      }
      if (cancelled) return;
      if (!refreshed) {
        // The refresh path ended the session itself; nothing to reconnect.
        stop();
        return;
      }
      scheduleReconnect(0);
    };

    const handleAction = (action: CloseAction) => {
      switch (action.kind) {
        case "refresh_auth":
          void handleUnauthorized(action.isSessionExpired);
          return;
        case "remint":
          // `connect` always mints a fresh ticket.
          scheduleReconnect(0);
          return;
        case "stop_access":
          stop();
          useMessageStore.getState().setAccessError(action.accessError);
          return;
        case "stop_disabled":
          stop();
          void refreshMessagingAvailability();
          return;
        case "backoff":
          scheduleReconnect(action.minDelayMs);
      }
    };

    /** Bumped per connect so a slow ticket mint can't open a superseded socket. */
    let connectGeneration = 0;

    const connect = async () => {
      if (cancelled || isStopped) return;
      const generation = ++connectGeneration;
      const tokens = await getTokens();
      if (cancelled || isStopped || !tokens?.jwt) return;
      let ticket: string;
      try {
        ticket = (await createMessagesEventsTicket()).ticket;
      } catch (error) {
        if (cancelled || isStopped || generation !== connectGeneration) return;
        handleAction(classifyTicketError(error));
        return;
      }
      if (cancelled || isStopped || generation !== connectGeneration) return;
      closeSocket();
      const next = new WebSocket(messagesEventsUrl(Config.API_BASE_URL, ticket));
      socket = next;

      /** Drop a silent socket without waiting for an `onclose` that may never come. */
      const abandonSilentSocket = () => {
        if (socket !== next) return;
        clearKeepalive();
        closeSocket();
        scheduleReconnect(0);
      };

      next.onopen = () => {
        attempt = 0;
        hasRefreshedAuth = false;
        authRecoveryFailures = 0;
        lastFrameAt = Date.now();
        setRealtimeStatus("connected");
        clearKeepalive();
        keepaliveTimer = setInterval(() => {
          if (isSocketSilent(lastFrameAt, Date.now())) {
            abandonSilentSocket();
            return;
          }
          if (next.readyState === WebSocket.OPEN) {
            next.send(JSON.stringify({ type: "ping" }));
          }
        }, KEEPALIVE_MS);
      };
      next.onmessage = (message) => {
        lastFrameAt = Date.now();
        const event = parseMessagesEvent(message.data);
        if (event && event.type !== "ping") onEventRef.current(event);
      };
      next.onerror = () => next.close();
      next.onclose = (closeEvent) => {
        if (socket !== next) return;
        socket = null;
        clearKeepalive();
        handleAction(classifyClose(closeEvent.code, closeEvent.reason));
      };
    };

    void connect();

    const subscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        if (state !== "active") return;
        if (hasGivenUp) {
          // Fresh start: conditions (network, session) may have changed.
          hasGivenUp = false;
          isStopped = false;
          authRecoveryFailures = 0;
          hasRefreshedAuth = false;
          attempt = 0;
          void connect();
          return;
        }
        if (isStopped) return;
        const isStale = shouldReconnectOnResume({
          readyState: socket?.readyState ?? null,
          lastFrameAt,
          now: Date.now(),
        });
        if (!isStale) return;
        // Honour a rate-limit wait; otherwise skip the backoff and go now.
        if (reconnectTimer && pendingMinDelayMs > 0) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attempt = 0;
        void connect();
      },
    );

    return () => {
      cancelled = true;
      clearTimers();
      closeSocket();
      subscription.remove();
      setRealtimeStatus("disconnected");
    };
  }, [enabled]);
}
