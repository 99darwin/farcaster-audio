/**
 * App-wide messaging upkeep, mounted once in the tab layout:
 *   - probes availability and keeps the tab badge's unread total fresh
 *     (initial inbox page, foreground refetch, websocket nudges);
 *   - applies websocket events to loaded threads;
 *   - clears messaging state on sign-out.
 */

import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { getConversation, getInbox } from "@/services/messagesApi";
import { useAuthStore } from "@/stores/authStore";
import { useMessageStore } from "@/stores/messageStore";
import { useMessagingAccess } from "@/hooks/useMessagingAccess";
import { useMessagesEvents } from "@/hooks/useMessagesEvents";
import { applyMessagesError } from "@/utils/messagesErrors";
import type { MessagesEvent } from "@/types/messages";

const BADGE_REFETCH_THROTTLE_MS = 60_000;
/** Coalesce bursts of websocket nudges into one inbox fetch. */
const EVENT_REFETCH_DEBOUNCE_MS = 1_500;

export function useMessagesBadge(): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const availability = useMessageStore((s) => s.availability);
  const access = useMessagingAccess();
  const isReady = isAuthenticated && access.state === "ready";
  const inFlightRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBadge = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    lastFetchAtRef.current = Date.now();
    try {
      const response = await getInbox({ category: "default" });
      // Upsert page one and the counts; never truncate a paged-in list.
      useMessageStore.getState().setInboxPage("default", response, "merge");
    } catch (error) {
      // Badge is non-critical; the store still learns about signer/feature state.
      applyMessagesError(error);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) useMessageStore.getState().reset();
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isReady || availability === "unavailable") return;
    void fetchBadge();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const loadedAt = useMessageStore.getState().inbox.default.loadedAt ?? 0;
      const last = Math.max(loadedAt, lastFetchAtRef.current);
      if (Date.now() - last <= BADGE_REFETCH_THROTTLE_MS) return;
      void fetchBadge();
    });
    return () => subscription.remove();
    // Re-probe only when readiness changes, not on every availability flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, fetchBadge]);

  const scheduleInboxRefetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void fetchBadge();
    }, EVENT_REFETCH_DEBOUNCE_MS);
  }, [fetchBadge]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const handleEvent = useCallback(
    (event: MessagesEvent) => {
      switch (event.type) {
        case "message":
          useMessageStore.getState().mergeLatest(event.conversation_id, [event.message]);
          scheduleInboxRefetch();
          return;
        case "read":
          void applyReadEvent(event.conversation_id, event.read_by);
          return;
        case "inbox":
          scheduleInboxRefetch();
      }
    },
    [scheduleInboxRefetch],
  );

  useMessagesEvents(isReady && availability !== "unavailable", handleEvent);
}

/**
 * A `read` frame (§4.5). `viewer` (or an older server without `read_by`)
 * means this account read the thread, possibly on another device: clear
 * unread locally. `peer` means the other party read: only their read
 * marker moves, so refetch the conversation for `peer_last_read_at` and
 * never touch the viewer's unread or manual-unread state.
 */
export async function applyReadEvent(
  conversationId: string,
  readBy: "viewer" | "peer" | undefined,
): Promise<void> {
  const store = useMessageStore.getState();
  if (readBy !== "peer") {
    store.markReadLocal(conversationId);
    return;
  }
  if (!store.conversations[conversationId]) return;
  try {
    const conversation = await getConversation(conversationId);
    useMessageStore
      .getState()
      .applyPeerRead(conversationId, conversation.peer_last_read_at ?? null);
  } catch (error) {
    applyMessagesError(error);
  }
}
