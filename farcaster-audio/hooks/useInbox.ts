/**
 * Inbox segment loader: first page, pull-to-refresh, pagination and a 15 s
 * poll while the inbox is focused (design §3.4 Phase A cadence).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptConversationRequest,
  declineConversationRequest,
  getInbox,
  markConversationRead,
  markConversationUnread,
  type MessagesErrorCode,
} from "@/services/messagesApi";
import {
  isConversationUnread,
  useMessageStore,
  type InboxPageMode,
  type InboxSegment,
} from "@/stores/messageStore";
import { applyMessagesError } from "@/utils/messagesErrors";
import type { Conversation } from "@/types/messages";

export const INBOX_POLL_MS = 15_000;

export interface UseInboxOptions {
  segment: InboxSegment;
  isEnabled: boolean;
  isFocused: boolean;
}

export interface UseInboxResult {
  conversations: Conversation[];
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  hasLoaded: boolean;
  errorCode: MessagesErrorCode | null;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  toggleUnread: (conversation: Conversation) => Promise<void>;
  /** Accept or decline a request, then refetch both segments. Throws. */
  respondToRequest: (
    conversation: Conversation,
    decision: RequestDecision,
  ) => Promise<void>;
  /** Conversation id whose request response is in flight. */
  respondingId: string | null;
}

export type RequestDecision = "accept" | "decline";

const REQUEST_ACTIONS: Record<RequestDecision, (conversationId: string) => Promise<void>> = {
  accept: acceptConversationRequest,
  decline: declineConversationRequest,
};

type FetchMode = "initial" | "refresh" | "poll" | "more";

/**
 * Only the first load may replace the list: a poll, refresh or badge fetch
 * returns page one alone, and replacing with it would drop every
 * conversation the user had paged in below.
 */
export const INBOX_PAGE_MODE: Record<FetchMode, InboxPageMode> = {
  initial: "replace",
  refresh: "merge",
  poll: "merge",
  more: "append",
};

export function useInbox({
  segment,
  isEnabled,
  isFocused,
}: UseInboxOptions): UseInboxResult {
  const slice = useMessageStore((s) => s.inbox[segment]);
  const conversationsById = useMessageStore((s) => s.conversations);
  const setInboxPage = useMessageStore((s) => s.setInboxPage);
  const patchConversation = useMessageStore((s) => s.patchConversation);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errorCode, setErrorCode] = useState<MessagesErrorCode | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  // Page-one fetches (initial / refresh / poll) and loadMore are tracked
  // apart, per segment: a slow poll must not swallow a scroll-triggered
  // loadMore, and a fetch still running for the segment just left must not
  // block the first load of the one switched to.
  const pageOneInFlightRef = useRef(new Set<InboxSegment>());
  const loadMoreInFlightRef = useRef(new Set<InboxSegment>());
  const segmentRef = useRef(segment);
  segmentRef.current = segment;

  // A failure belongs to the segment it happened on.
  useEffect(() => {
    setErrorCode(null);
  }, [segment]);

  const fetchPage = useCallback(
    async (mode: FetchMode) => {
      if (!isEnabled) return;
      const isAppend = mode === "more";
      const inFlight = isAppend ? loadMoreInFlightRef.current : pageOneInFlightRef.current;
      if (inFlight.has(segment)) return;
      const cursor = useMessageStore.getState().inbox[segment].cursor;
      if (isAppend && !cursor) return;
      inFlight.add(segment);
      const setBusy =
        mode === "initial"
          ? setIsLoading
          : mode === "refresh"
            ? setIsRefreshing
            : mode === "more"
              ? setIsLoadingMore
              : null;
      setBusy?.(true);
      try {
        const response = await getInbox({
          category: segment,
          cursor: isAppend ? cursor : null,
        });
        setInboxPage(segment, response, INBOX_PAGE_MODE[mode]);
        if (segmentRef.current === segment) setErrorCode(null);
      } catch (error) {
        const code = applyMessagesError(error);
        // Background polls stay quiet; a visible load reports the failure.
        if (code && mode !== "poll" && segmentRef.current === segment) {
          setErrorCode(code);
        }
      } finally {
        inFlight.delete(segment);
        setBusy?.(false);
      }
    },
    [isEnabled, segment, setInboxPage],
  );

  useEffect(() => {
    if (!isEnabled || !isFocused) return;
    const hasLoaded = useMessageStore.getState().inbox[segment].loadedAt !== null;
    void fetchPage(hasLoaded ? "poll" : "initial");
    const timer = setInterval(() => void fetchPage("poll"), INBOX_POLL_MS);
    return () => clearInterval(timer);
  }, [fetchPage, isEnabled, isFocused, segment]);

  const refresh = useCallback(() => fetchPage("refresh"), [fetchPage]);
  const loadMore = useCallback(() => fetchPage("more"), [fetchPage]);

  const toggleUnread = useCallback(
    async (conversation: Conversation) => {
      const isUnread = isConversationUnread(conversation);
      const previous = {
        unread_count: conversation.unread_count,
        manually_marked_unread: conversation.manually_marked_unread,
      };
      patchConversation(
        conversation.conversation_id,
        isUnread
          ? { unread_count: 0, manually_marked_unread: false }
          : { manually_marked_unread: true },
      );
      try {
        if (isUnread) {
          await markConversationRead(conversation.conversation_id);
        } else {
          await markConversationUnread(conversation.conversation_id);
        }
      } catch (error) {
        patchConversation(conversation.conversation_id, previous);
        applyMessagesError(error);
        throw error;
      }
    },
    [patchConversation],
  );

  const respondToRequest = useCallback(
    async (conversation: Conversation, decision: RequestDecision) => {
      setRespondingId(conversation.conversation_id);
      try {
        await REQUEST_ACTIONS[decision](conversation.conversation_id);
      } catch (error) {
        applyMessagesError(error);
        throw error;
      } finally {
        setRespondingId(null);
      }
      // The request moved (accept -> Chats) or vanished (decline): drop it
      // from Requests, then merge page one of both lists from the server
      // rather than guess the new order (merging keeps paged-in rows).
      useMessageStore
        .getState()
        .removeFromInbox("request", conversation.conversation_id);
      const [requests, chats] = await Promise.allSettled([
        getInbox({ category: "request", cursor: null }),
        getInbox({ category: "default", cursor: null }),
      ]);
      if (requests.status === "fulfilled") {
        setInboxPage("request", requests.value, "merge");
      }
      if (chats.status === "fulfilled") {
        setInboxPage("default", chats.value, "merge");
      }
    },
    [setInboxPage],
  );

  const conversations = useMemo(
    () =>
      slice.ids
        .map((id) => conversationsById[id])
        .filter((c): c is Conversation => c !== undefined),
    [slice.ids, conversationsById],
  );

  return {
    conversations,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore: slice.hasMore,
    hasLoaded: slice.loadedAt !== null,
    errorCode,
    refresh,
    loadMore,
    toggleUnread,
    respondToRequest,
    respondingId,
  };
}
