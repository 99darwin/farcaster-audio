"use client";

/**
 * Messaging events WebSocket for the Juke web app (`WS /v1/messages/events`).
 *
 * Modelled on `events.ts` (room discovery): exponential-backoff reconnects, and
 * an immediate reconnect when the tab becomes visible or the network returns.
 * Differences, per messaging design doc 4.2:
 *   - Auth rides in `?ticket=<ticket>` (browsers can't set WS headers): a
 *     single-use, 30 s ticket minted with `POST /events/ticket` right before
 *     every connect and reconnect, so the JWT never lands in a URL (proxy and
 *     access logs, history). A 401 from the mint refreshes the session once and
 *     retries (see {@link mintEventsTicket}).
 *   - The client sends `{ "type": "ping" }` on an interval to keep the socket
 *     (and any intermediary) alive.
 *   - Close codes follow design doc 4.7 (see {@link closeAction}): 4401
 *     `ticket_rejected` mints a fresh ticket and reconnects with backoff (no
 *     refresh), giving up after {@link MAX_TICKET_REJECTIONS} in a row; 4401
 *     `session_expired` (or a bare 4401) refreshes the JWT once and reconnects,
 *     then reports `unauthorized`; 4403 stops (Enable-messages gate) unless
 *     the reason is the transient `messaging_token_unavailable`; 4404 stops
 *     (refetch /status); 4429 backs off at least a minute; anything else uses
 *     exponential backoff.
 *   - The socket layer NEVER signs out. Giving up only turns realtime off (the
 *     caller's polling resumes); signing out is reserved for the REST refresh
 *     path (`refreshSession` logs out on a conclusive 401/403).
 *   - While open, the client ping timer also watches for silence: no frame for
 *     {@link STALE_SOCKET_MS} means a half-open socket, which is retired and
 *     reconnected with backoff (a visible tab never gets a resume event).
 *   - On resume (tab visible / online) the socket is replaced when it isn't
 *     OPEN or has been silent longer than {@link STALE_SOCKET_MS}: the server
 *     pings after 25s idle, so silence that long means a half-dead socket.
 *
 * The caller treats an open socket as "realtime on" and relaxes its polling;
 * while closed, polling (design doc 3.4 Phase A) keeps the UI current.
 */

import { API_BASE_URL, ApiFetchError } from "@/lib/api/client";
import { getJwt } from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/authRefresh";
import {
  MESSAGING_TOKEN_UNAVAILABLE,
  createMessagesEventsTicket,
  isMessagingDisabledError,
} from "@/lib/api/messages";
import type { MessagesEvent } from "@/lib/api/messages.types";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CLIENT_PING_INTERVAL_MS = 25_000;
/** No frame (including server pings) for this long means the socket is stale. */
export const STALE_SOCKET_MS = 60_000;
/** Minimum wait after a 4429 rate-limit close. */
export const RATE_LIMITED_RECONNECT_MS = 60_000;

/** `WebSocket.OPEN`, without touching the global (absent in SSR). */
const WEBSOCKET_OPEN = 1;

/** Server close codes (design doc 4.7). */
export const CLOSE_UNAUTHORIZED = 4401;
/** Reason is a `messaging_token_*` detail; the Direct Cast token is unusable. */
export const CLOSE_TOKEN_REQUIRED = 4403;
export const CLOSE_DISABLED = 4404;
export const CLOSE_RATE_LIMITED = 4429;
/** 4401 reason: the session's JWT expired while the stream was open. */
export const SESSION_EXPIRED_REASON = "session_expired";
/** 4401 reason: the ticket was unknown, reused or expired; mint a fresh one. */
export const TICKET_REJECTED_REASON = "ticket_rejected";
/** Consecutive `ticket_rejected` closes (without an open) before giving up. */
export const MAX_TICKET_REJECTIONS = 5;

/**
 * Why the socket gave up for good:
 * - `token_required`: 4403, show the Enable-messages gate.
 * - `disabled`: 4404, refetch GET /status (the flag may be off).
 * - `unauthorized`: 4401 (or a 401 minting the ticket) again after a
 *   successful JWT refresh, or repeated `ticket_rejected`; realtime only
 *   gives up (polling resumes). Never a sign-out.
 * - `no_session`: no JWT, or the refresh itself failed conclusively (the REST
 *   refresh path already signed out).
 */
export type MessagesUnavailableReason = "token_required" | "disabled" | "unauthorized" | "no_session";

export type CloseAction =
  | { kind: "refresh_auth" }
  | { kind: "remint" }
  | { kind: "give_up"; reason: MessagesUnavailableReason }
  | { kind: "reconnect"; minDelayMs: number };

/**
 * What to do after the server closes with `code` and close `reason`
 * (design doc 4.7).
 */
export function closeAction(code: number, hasRetriedAuth: boolean, reason = ""): CloseAction {
  switch (code) {
    case CLOSE_UNAUTHORIZED:
      // The ticket (not the session) was bad: a fresh mint, no refresh.
      if (reason === TICKET_REJECTED_REASON) return { kind: "remint" };
      // `session_expired` or a bare 4401: one refresh, then give up realtime.
      return hasRetriedAuth
        ? { kind: "give_up", reason: "unauthorized" }
        : { kind: "refresh_auth" };
    case CLOSE_TOKEN_REQUIRED:
      // The server couldn't decrypt the stored token: transient, so retry.
      return reason === MESSAGING_TOKEN_UNAVAILABLE
        ? { kind: "reconnect", minDelayMs: 0 }
        : { kind: "give_up", reason: "token_required" };
    case CLOSE_DISABLED:
      return { kind: "give_up", reason: "disabled" };
    case CLOSE_RATE_LIMITED:
      return { kind: "reconnect", minDelayMs: RATE_LIMITED_RECONNECT_MS };
    default:
      // 1000 / 1001 / 1006 network drop / 1011 server error: exponential backoff.
      return { kind: "reconnect", minDelayMs: 0 };
  }
}

/** True when a resume should replace the current socket. */
export function shouldReplaceSocket(
  readyState: number | null,
  lastFrameAt: number,
  now: number,
): boolean {
  if (readyState !== WEBSOCKET_OPEN) return true;
  return now - lastFrameAt > STALE_SOCKET_MS;
}

export interface MessagesEventsOptions {
  /** Every non-ping server frame. */
  onEvent: (event: MessagesEvent) => void;
  /** Socket transitioned to OPEN. */
  onOpen?: () => void;
  /** The current socket closed (before any reconnect is scheduled). */
  onClose?: () => void;
  /** Tab became visible / network returned: callers should refetch. */
  onResume?: () => void;
  /** Gave up permanently; callers should rely on polling or show a CTA. */
  onUnavailable?: (reason: MessagesUnavailableReason) => void;
}

/** Socket URL for a ticket from {@link createMessagesEventsTicket}. */
export function messagesEventsUrl(ticket: string): string {
  const base = API_BASE_URL.replace(/^http/, "ws");
  return `${base}/v1/messages/events?ticket=${encodeURIComponent(ticket)}`;
}

export type TicketOutcome =
  | { kind: "ticket"; ticket: string }
  | { kind: "give_up"; reason: MessagesUnavailableReason }
  | { kind: "retry"; minDelayMs: number };

type TicketAttempt = TicketOutcome | { kind: "unauthorized" };

async function requestTicket(): Promise<TicketAttempt> {
  try {
    const { ticket } = await createMessagesEventsTicket();
    if (typeof ticket !== "string" || ticket === "") return { kind: "retry", minDelayMs: 0 };
    return { kind: "ticket", ticket };
  } catch (error) {
    if (!(error instanceof ApiFetchError)) return { kind: "retry", minDelayMs: 0 };
    if (error.status === 401) return { kind: "unauthorized" };
    if (isMessagingDisabledError(error)) return { kind: "give_up", reason: "disabled" };
    if (error.status === 429) return { kind: "retry", minDelayMs: RATE_LIMITED_RECONNECT_MS };
    return { kind: "retry", minDelayMs: 0 };
  }
}

/**
 * Mint a websocket ticket (design doc 4.2). A 401 refreshes the session once
 * and retries; a second 401 means the session is dead (`unauthorized`).
 * `messaging_disabled` gives up like a 4404 and a 429 waits like a 4429; any
 * other failure (network, 5xx) is retried with the normal backoff.
 */
export async function mintEventsTicket(): Promise<TicketOutcome> {
  if (!getJwt()) return { kind: "give_up", reason: "no_session" };
  const first = await requestTicket();
  if (first.kind !== "unauthorized") return first;

  let session: Awaited<ReturnType<typeof refreshSession>>;
  try {
    session = await refreshSession();
  } catch {
    // Transient refresh failure (offline, 5xx): the session is still intact.
    return { kind: "retry", minDelayMs: 0 };
  }
  if (!session) return { kind: "give_up", reason: "no_session" };

  const second = await requestTicket();
  return second.kind === "unauthorized" ? { kind: "give_up", reason: "unauthorized" } : second;
}

const EVENT_TYPES = new Set<MessagesEvent["type"]>([
  "message",
  "read",
  "inbox",
  "ping",
]);

/**
 * Parse one server frame. Returns null for malformed or unknown frames so a
 * newer server can add event types without breaking older clients.
 */
export function parseMessagesEvent(raw: unknown): MessagesEvent | null {
  let payload: unknown;
  try {
    payload = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { type?: unknown; conversation_id?: unknown; message?: unknown };
  if (typeof candidate.type !== "string") return null;
  if (!EVENT_TYPES.has(candidate.type as MessagesEvent["type"])) return null;
  if (candidate.type === "ping") return { type: "ping" };
  if (typeof candidate.conversation_id !== "string") return null;
  if (candidate.type === "message") {
    const message = candidate.message as { message_id?: unknown } | null;
    if (!message || typeof message.message_id !== "string") return null;
  }
  return payload as MessagesEvent;
}

/** Backoff delay for the given (0-based) attempt, capped. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

/**
 * Open the messaging socket. Returns an idempotent unsubscribe function.
 * No-op outside the browser.
 */
export function subscribeToMessageEvents({
  onEvent,
  onOpen,
  onClose,
  onResume,
  onUnavailable,
}: MessagesEventsOptions): () => void {
  if (typeof window === "undefined") return () => {};

  let cancelled = false;
  let stopped = false;
  let websocket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let hasRetriedAuth = false;
  /** `ticket_rejected` closes since the last successful open. */
  let ticketRejections = 0;
  /** Last time the current socket opened or delivered any frame. */
  let lastFrameAt = 0;
  /** A 4429 close must not be bypassed by a resume. */
  let rateLimitedUntil = 0;
  /** Bumped by every connect; a ticket minted for an older one is discarded. */
  let connectGeneration = 0;
  /** True while a ticket is being minted (no socket to replace yet). */
  let isMintingTicket = false;

  const stopPingTimer = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopPingTimer();
  };

  const giveUp = (reason: MessagesUnavailableReason) => {
    stopped = true;
    clearTimers();
    onUnavailable?.(reason);
  };

  const scheduleReconnect = (minDelayMs = 0) => {
    if (cancelled || stopped || reconnectTimer) return;
    if (minDelayMs > 0) rateLimitedUntil = Date.now() + minDelayMs;
    const delay = Math.max(minDelayMs, reconnectDelayMs(reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  /**
   * Retire the current socket before a replacement connects. Its own onclose
   * is then ignored as superseded, so the disconnect is reported here: the
   * ticket mint leaves a gap before the next socket opens.
   */
  const detachSocket = () => {
    const previous = websocket;
    if (!previous) return;
    websocket = null;
    stopPingTimer();
    previous.close();
    onClose?.();
  };

  /**
   * A half-open socket may never fire onclose (the close handshake can't
   * complete), so retire it here and run the normal backoff.
   */
  const retireStaleSocket = () => {
    detachSocket();
    scheduleReconnect();
  };

  async function connect(): Promise<void> {
    if (cancelled || stopped) return;
    detachSocket();

    const generation = ++connectGeneration;
    isMintingTicket = true;
    const outcome = await mintEventsTicket();
    // A newer connect (resume) or an unsubscribe overtook this one.
    if (generation !== connectGeneration) return;
    isMintingTicket = false;
    if (cancelled || stopped) return;
    if (outcome.kind === "give_up") {
      giveUp(outcome.reason);
      return;
    }
    if (outcome.kind === "retry") {
      scheduleReconnect(outcome.minDelayMs);
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(messagesEventsUrl(outcome.ticket));
    } catch {
      scheduleReconnect();
      return;
    }
    websocket = socket;

    socket.onopen = () => {
      reconnectAttempt = 0;
      hasRetriedAuth = false;
      ticketRejections = 0;
      lastFrameAt = Date.now();
      stopPingTimer();
      pingTimer = setInterval(() => {
        if (websocket !== socket) return;
        if (Date.now() - lastFrameAt > STALE_SOCKET_MS) {
          retireStaleSocket();
          return;
        }
        if (socket.readyState === WEBSOCKET_OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, CLIENT_PING_INTERVAL_MS);
      onOpen?.();
    };

    socket.onmessage = (frame) => {
      lastFrameAt = Date.now();
      const event = parseMessagesEvent(String(frame.data));
      if (event && event.type !== "ping") onEvent(event);
    };

    socket.onerror = () => socket.close();

    socket.onclose = (closeEvent) => {
      // A superseded socket closing must not report the live one as down (or
      // clear its ping timer).
      if (websocket !== socket) return;
      stopPingTimer();
      websocket = null;
      onClose?.();
      const action = closeAction(closeEvent.code, hasRetriedAuth, closeEvent.reason);
      if (action.kind === "give_up") {
        giveUp(action.reason);
        return;
      }
      if (action.kind === "remint") {
        ticketRejections += 1;
        if (ticketRejections >= MAX_TICKET_REJECTIONS) {
          giveUp("unauthorized");
          return;
        }
        // connect() always mints a fresh ticket; back off between attempts.
        scheduleReconnect();
        return;
      }
      if (action.kind === "refresh_auth") {
        hasRetriedAuth = true;
        // connect() mints a fresh ticket with the refreshed JWT.
        refreshSession().then(
          (session) => {
            if (session) void connect();
            else giveUp("no_session");
          },
          // Transient refresh failure: the session survives; retry later.
          () => scheduleReconnect(),
        );
        return;
      }
      scheduleReconnect(action.minDelayMs);
    };
  }

  const resume = () => {
    onResume?.();
    if (stopped || cancelled) return;
    if (isMintingTicket) return;
    if (Date.now() < rateLimitedUntil) return;
    if (websocket && !shouldReplaceSocket(websocket.readyState, lastFrameAt, Date.now())) return;
    reconnectAttempt = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    void connect();
  };

  const handleVisibility = () => {
    if (document.visibilityState === "visible") resume();
  };

  void connect();
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("online", resume);

  return () => {
    cancelled = true;
    connectGeneration += 1;
    clearTimers();
    const socket = websocket;
    websocket = null;
    socket?.close();
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("online", resume);
  };
}
