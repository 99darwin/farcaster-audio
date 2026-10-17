"use client";

/**
 * Session wiring + background sync for messaging.
 *
 * - {@link useMessagingSession}: maps auth state to a messaging access state
 *   and keeps `messageStore.viewer` in sync (clearing the store on account
 *   switch).
 * - {@link useInboxBackgroundPoll}: the nav badge's slow inbox poll, which
 *   only runs once GET /status confirms an active Direct Cast token (see
 *   `lib/messages/background-poll.ts`; ref-counted, one timer).
 * - {@link useMessagesRealtime}: the Messages surface's websocket subscription
 *   plus the faster polling fallback from design doc 3.4.
 */

import { useEffect } from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import { getMessagingStatus, isMessagingDisabledError } from "@/lib/api/messages";
import { subscribeToMessageEvents, type MessagesUnavailableReason } from "@/lib/api/messagesEvents";
import { createBackgroundInboxPoll } from "@/lib/messages/background-poll";
import { useMessageStore } from "@/lib/stores/messageStore";

/** Build-time flag; the backend also 404s every route when messaging is off. */
export const MESSAGING_UI_ENABLED =
  process.env.NEXT_PUBLIC_MESSAGING_ENABLED === "true";

/** Badge poll while browsing the rest of the app. */
const BACKGROUND_INBOX_POLL_MS = 60_000;
/** Inbox poll while the Messages surface is open and the socket is down. */
const FOCUSED_INBOX_POLL_MS = 15_000;
/** Coalesce bursts of `inbox` events into one refetch. */
const INBOX_REFRESH_DEBOUNCE_MS = 750;

export type MessagingAccess = "loading" | "anonymous" | "ready";

export function useMessagingSession(): MessagingAccess {
  const { user, status } = useAuth();
  const setViewer = useMessageStore((s) => s.setViewer);

  useEffect(() => {
    if (status === "loading") return;
    setViewer(
      user
        ? {
            fid: user.fid,
            username: user.username || null,
            display_name: user.display_name || user.username || `fid ${user.fid}`,
            pfp_url: user.pfp_url,
          }
        : null,
    );
  }, [status, user, setViewer]);

  if (status === "loading") return "loading";
  if (status === "anonymous" || !user) return "anonymous";
  // Messaging authorizes with the stored custody-minted Direct Cast token, not
  // the managed signer; the shell gates on GET /status `token_status`.
  return "ready";
}

function isStoreUsable(): boolean {
  const { availability } = useMessageStore.getState();
  return availability !== "disabled" && availability !== "token_required";
}

/** 4404: the flag may have flipped off; confirm with GET /status (design doc 4.7). */
async function recheckMessagingEnabled(): Promise<void> {
  const { setAvailability } = useMessageStore.getState();
  try {
    const status = await getMessagingStatus();
    if (!status.enabled) setAvailability("disabled");
  } catch (error) {
    if (isMessagingDisabledError(error)) setAvailability("disabled");
  }
}

const backgroundInboxPoll = createBackgroundInboxPoll({
  getStatus: () => getMessagingStatus(),
  loadInbox: () => useMessageStore.getState().loadInbox("default"),
  getViewerFid: () => useMessageStore.getState().viewer?.fid ?? null,
  getAvailability: () => useMessageStore.getState().availability,
  setAvailability: (availability) => useMessageStore.getState().setAvailability(availability),
  isVisible: () => document.visibilityState === "visible",
  intervalMs: BACKGROUND_INBOX_POLL_MS,
});

/** Keep the unread badge fresh while `enabled`. */
export function useInboxBackgroundPoll(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return backgroundInboxPoll.retain();
  }, [enabled]);
}

/**
 * Websocket subscription for the Messages surface. While the socket is down
 * (or unavailable), polls the inbox every {@link FOCUSED_INBOX_POLL_MS}.
 */
export function useMessagesRealtime(enabled: boolean): void {
  const connected = useMessageStore((s) => s.realtimeConnected);

  useEffect(() => {
    if (!enabled) return;
    const store = useMessageStore.getState;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshInbox = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void store().loadInbox("default");
        if (store().inbox.request.status !== "idle") void store().loadInbox("request");
      }, INBOX_REFRESH_DEBOUNCE_MS);
    };
    const catchUp = () => {
      refreshInbox();
      const focused = store().focusedConversationId;
      if (focused) void store().pollRecent(focused);
    };

    const unsubscribe = subscribeToMessageEvents({
      onEvent: (event) => {
        if (store().ingestEvent(event)) refreshInbox();
      },
      onOpen: () => store().setRealtimeConnected(true),
      onClose: () => store().setRealtimeConnected(false),
      onResume: catchUp,
      onUnavailable: (reason: MessagesUnavailableReason) => {
        // Realtime only: `realtimeConnected` false resumes the focused poll.
        // The socket layer never signs out; only the REST refresh path does.
        store().setRealtimeConnected(false);
        if (reason === "token_required") store().setAvailability("token_required");
        else if (reason === "disabled") void recheckMessagingEnabled();
      },
    });

    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unsubscribe();
      store().setRealtimeConnected(false);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || connected) return;
    const poll = () => {
      if (document.visibilityState !== "visible" || !isStoreUsable()) return;
      void useMessageStore.getState().loadInbox("default");
    };
    const timer = setInterval(poll, FOCUSED_INBOX_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, connected]);
}
