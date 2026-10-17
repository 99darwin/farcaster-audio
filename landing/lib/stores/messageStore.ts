"use client";

/**
 * Messaging (Direct Casts) store for the Juke web app.
 *
 * Holds the inbox (default + requests segments), conversation metadata by id,
 * each opened conversation's loaded messages (ascending, deduped by
 * `message_id`), optimistic sends with retry, per-conversation reply targets
 * and composer drafts, and the unread total that drives the nav badge.
 *
 * Network calls go through `lib/api/messages.ts`. Every action is safe to call
 * repeatedly (in-flight guards), so polling, websocket events and user actions
 * can all funnel through the same entry points.
 */

import { create } from "zustand";
import * as api from "@/lib/api/messages";
import type {
  Conversation,
  InboxResponse,
  Message,
  MessageReactionSummary,
  MessageSearchHit,
  MessageUser,
  MessagesEvent,
  MessagesPage,
  SendMessageRequest,
} from "@/lib/api/messages.types";
import {
  clearPersistedDraft,
  loadPersistedDraft,
  persistDraft,
} from "@/lib/messages/draft-storage";
import { mergeInboxRefresh } from "@/lib/messages/inbox-merge";
import {
  buildOptimisticMessage,
  mergeMessages,
  mergeSendEcho,
  optimisticSentAt,
  pagesOverlap,
  removeMessage,
  toggleReaction as toggleReactionSummary,
  updateMessage,
} from "@/lib/messages/message-list";

export type InboxSegment = "default" | "request";

/**
 * `disabled`: the backend's `MESSAGING_ENABLED` flag is off (404 with detail
 * `messaging_disabled`, or GET /status `enabled: false`). A per-conversation
 * 404 never sets this; it marks that thread `isNotFound` instead.
 * `token_required`: the stored Direct Cast token is missing, expired or
 * rejected (403 `messaging_token_*`, or a 4403 socket close); the UI shows the
 * Enable-messages gate.
 */
export type MessagingAvailability =
  | "unknown"
  | "available"
  | "disabled"
  | "token_required";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface InboxList {
  ids: string[];
  cursor: string | null;
  hasMore: boolean;
  status: LoadStatus;
  loadingMore: boolean;
  error: string | null;
}

/**
 * One conversation's loaded window. The window is contiguous; it reaches the
 * live end when `hasNewer` is false. After a jump (search hit, `?m=`) it can
 * sit in the past: scrolling down pages forward with `newerCursor` until the
 * live end, where `/recent` polling and websocket frames take over.
 */
export interface ThreadState {
  messages: Message[];
  olderCursor: string | null;
  hasOlder: boolean;
  /** `next_newer_cursor` of the newest loaded page; null at the live end. */
  newerCursor: string | null;
  /** True while the window doesn't reach the newest message. */
  hasNewer: boolean;
  status: LoadStatus;
  loadingOlder: boolean;
  loadingNewer: boolean;
  error: string | null;
  /** The conversation 404'd (deleted, left, or never visible to the viewer). */
  isNotFound: boolean;
  /** Messages that arrived at the live end while the window was in the past. */
  newerWhileDetached: number;
}

/** Key used for optimistic messages to a peer with no conversation yet. */
export function draftConversationKey(peerFid: number): string {
  return `draft:${peerFid}`;
}

function emptyInbox(): InboxList {
  return {
    ids: [],
    cursor: null,
    hasMore: true,
    status: "idle",
    loadingMore: false,
    error: null,
  };
}

function emptyThread(): ThreadState {
  return {
    messages: [],
    olderCursor: null,
    hasOlder: true,
    newerCursor: null,
    hasNewer: false,
    status: "idle",
    loadingOlder: false,
    loadingNewer: false,
    error: null,
    isNotFound: false,
    newerWhileDetached: 0,
  };
}

/** A fresh window (no live-end continuity) built from one page. */
export interface WindowPage {
  items: readonly Message[];
  olderCursor: string | null;
  newerCursor: string | null;
  /** False only when the page is known to reach the live end. */
  hasNewer: boolean;
}

function windowFromMessagesPage(page: MessagesPage): WindowPage {
  return {
    items: page.items,
    olderCursor: page.next_cursor,
    newerCursor: page.next_newer_cursor ?? null,
    // A server that omits the field can't say; assume there may be newer
    // messages (loadNewer then reattaches via loadLatest).
    hasNewer: page.next_newer_cursor !== null,
  };
}

/**
 * Place a page into a thread's window. Overlapping pages extend the window
 * (taking the older / newer cursor from whichever side the page extends);
 * a disjoint page replaces it, keeping in-flight optimistic sends only when
 * the new window reaches the live end (that's where they render).
 */
function applyWindowPage(current: ThreadState, page: WindowPage): ThreadState {
  const oldest = current.messages.find((m) => !m.send_state);
  const newest = current.messages.filter((m) => !m.send_state).at(-1);
  const pageTimes = page.items.map((m) => m.sent_at);
  const pageOldest = Math.min(...pageTimes);
  const pageNewest = Math.max(...pageTimes);

  if (oldest && newest && pagesOverlap(current.messages, page.items)) {
    const extendsOlder = pageOldest < oldest.sent_at;
    const extendsNewer = pageNewest > newest.sent_at && current.hasNewer;
    const reachesLiveEnd = extendsNewer && !page.hasNewer;
    return {
      ...current,
      messages: mergeMessages(current.messages, page.items),
      olderCursor: extendsOlder ? page.olderCursor : current.olderCursor,
      hasOlder: extendsOlder ? page.olderCursor !== null : current.hasOlder,
      newerCursor: extendsNewer ? page.newerCursor : current.newerCursor,
      hasNewer: extendsNewer ? page.hasNewer : current.hasNewer,
      newerWhileDetached: reachesLiveEnd ? 0 : current.newerWhileDetached,
      status: "ready",
      error: null,
      isNotFound: false,
    };
  }

  const { hasNewer } = page;
  const optimistic = hasNewer ? [] : current.messages.filter((m) => m.send_state);
  return {
    ...current,
    messages: mergeMessages(optimistic, page.items),
    olderCursor: page.olderCursor,
    hasOlder: page.olderCursor !== null,
    newerCursor: page.newerCursor,
    hasNewer,
    loadingOlder: false,
    loadingNewer: false,
    newerWhileDetached: 0,
    status: "ready",
    error: null,
    isNotFound: false,
  };
}

/** A thread with nothing older to load: a new conversation or a fresh send. */
function emptyLiveThread(): ThreadState {
  return { ...emptyThread(), status: "ready", hasOlder: false };
}

function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback for very old browsers (and the jest node env).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

/** Badge total: unread, unmuted conversations in the default inbox. */
export function computeUnreadTotal(
  ids: readonly string[],
  conversations: Readonly<Record<string, Conversation>>,
): number {
  let total = 0;
  for (const id of ids) {
    const conversation = conversations[id];
    if (!conversation || conversation.muted) continue;
    if (conversation.unread_count > 0) total += conversation.unread_count;
    else if (conversation.manually_marked_unread) total += 1;
  }
  return total;
}

/** Move `id` to the top of `ids`, after any pinned conversations. */
function promote(
  ids: readonly string[],
  id: string,
  conversations: Readonly<Record<string, Conversation>>,
): string[] {
  const rest = ids.filter((existing) => existing !== id);
  const pinnedCount = conversations[id]?.pinned
    ? 0
    : rest.findIndex((existing) => !conversations[existing]?.pinned);
  const insertAt = pinnedCount === -1 ? rest.length : pinnedCount;
  return [...rest.slice(0, insertAt), id, ...rest.slice(insertAt)];
}

export interface SendInput {
  /** Existing conversation, or null for a first message to `recipientFid`. */
  conversationId: string | null;
  recipientFid?: number | null;
  text: string;
  replyTo: Message | null;
  /** False when the sender dismissed the link preview. */
  processMetadata?: boolean;
}

export interface SendResult {
  /** Real conversation id (resolved from the server echo for new 1:1s). */
  conversationId: string | null;
  messageId: string;
  ok: boolean;
}

export interface MessageState {
  viewer: MessageUser | null;
  availability: MessagingAvailability;
  conversations: Record<string, Conversation>;
  inbox: Record<InboxSegment, InboxList>;
  requestsCount: number;
  hasUnreadRequests: boolean;
  unreadTotal: number;
  threads: Record<string, ThreadState>;
  replyTargets: Record<string, Message | null>;
  drafts: Record<string, string>;
  /** Pending send requests by message id, kept for retry. */
  pendingSends: Record<string, SendMessageRequest>;
  /**
   * Why a failed send was refused, by message id, when upstream said
   * (`upstream_rejected`). Absent for outages; the bubble says "Not sent."
   */
  sendErrors: Record<string, string>;
  /** The conversation currently open and visible (for unread bookkeeping). */
  focusedConversationId: string | null;
  realtimeConnected: boolean;

  /** Conversation ids that 404'd (see {@link ThreadState.isNotFound}). */
  missingConversations: Record<string, true>;
  /** Newest message id each conversation was last marked read at. */
  readMarks: Record<string, string>;

  setViewer: (viewer: MessageUser | null) => void;
  loadInbox: (segment: InboxSegment) => Promise<void>;
  loadMoreInbox: (segment: InboxSegment) => Promise<void>;
  ensureConversation: (conversationId: string) => Promise<Conversation | null>;
  /**
   * The viewer's existing 1:1 with `fid`, or null when there is none yet
   * (compose a draft). Other failures reject.
   */
  findDirectConversation: (fid: number) => Promise<Conversation | null>;
  loadLatest: (conversationId: string) => Promise<void>;
  loadOlder: (conversationId: string) => Promise<void>;
  /** Page forward toward the live end after a jump. */
  loadNewer: (conversationId: string) => Promise<void>;
  pollRecent: (conversationId: string) => Promise<void>;
  /** Make sure `messageId` is loaded. Resolves true when it is. */
  jumpToMessage: (conversationId: string, messageId: string) => Promise<boolean>;
  /**
   * Seed a thread from a search hit (`[...after, message, ...before]` plus the
   * hit's thread cursors) so the jump needs no extra request.
   */
  seedFromSearchHit: (hit: MessageSearchHit) => void;
  acceptRequest: (conversationId: string) => Promise<void>;
  declineRequest: (conversationId: string) => Promise<void>;
  sendMessage: (input: SendInput) => Promise<SendResult>;
  retrySend: (conversationKey: string, messageId: string) => Promise<SendResult>;
  discardFailed: (conversationKey: string, messageId: string) => void;
  toggleReaction: (conversationId: string, messageId: string, reaction: string) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string) => Promise<void>;
  markRead: (conversationId: string) => Promise<void>;
  markUnread: (conversationId: string) => Promise<void>;
  /** Apply a websocket frame. Returns true when the inbox should be refetched. */
  ingestEvent: (event: MessagesEvent) => boolean;
  setReplyTarget: (conversationKey: string, message: Message | null) => void;
  /** Also persisted per viewer fid + conversation (see `draft-storage.ts`). */
  setDraft: (conversationKey: string, text: string) => void;
  /** Load the persisted draft into memory when the composer is empty (thread open). */
  restoreDraft: (conversationKey: string) => void;
  setFocusedConversation: (conversationId: string | null) => void;
  setRealtimeConnected: (connected: boolean) => void;
  /** Report an availability change seen outside the HTTP layer (socket, /status). */
  setAvailability: (availability: MessagingAvailability) => void;
  reset: () => void;
}

function initialData() {
  return {
    viewer: null,
    availability: "unknown" as MessagingAvailability,
    conversations: {},
    inbox: { default: emptyInbox(), request: emptyInbox() },
    requestsCount: 0,
    hasUnreadRequests: false,
    unreadTotal: 0,
    threads: {},
    replyTargets: {},
    drafts: {},
    pendingSends: {},
    sendErrors: {},
    focusedConversationId: null,
    realtimeConnected: false,
    missingConversations: {},
    readMarks: {},
  };
}

export const useMessageStore = create<MessageState>()((set, get) => {
  /**
   * Sends from a draft (no conversation yet) run one at a time per peer: the
   * first creates the conversation, the rest wait for its real id so they
   * don't each create (or race to create) a conversation upstream.
   */
  const draftSendChains = new Map<string, Promise<string | null>>();
  /** Draft key -> real conversation id once the first send landed. */
  const resolvedDrafts = new Map<string, string>();

  const noteNotFound = (conversationId: string) => {
    set((state) => ({
      missingConversations: { ...state.missingConversations, [conversationId]: true },
    }));
  };

  /** Record availability from any API failure. Returns true when handled. */
  const noteAvailabilityError = (error: unknown): boolean => {
    if (api.isMessagingDisabledError(error)) {
      set({ availability: "disabled" });
      return true;
    }
    if (api.isMessagingTokenError(error)) {
      set({ availability: "token_required" });
      return true;
    }
    return false;
  };

  const patchThread = (conversationId: string, patch: Partial<ThreadState>) => {
    set((state) => ({
      threads: {
        ...state.threads,
        [conversationId]: {
          ...(state.threads[conversationId] ?? emptyThread()),
          ...patch,
        },
      },
    }));
  };

  /** Optimistically drop a request from the request inbox; returns the ids to restore. */
  const removeFromRequests = (conversationId: string): string[] => {
    const requestIds = get().inbox.request.ids;
    set((state) => ({
      inbox: {
        ...state.inbox,
        request: { ...state.inbox.request, ids: requestIds.filter((id) => id !== conversationId) },
      },
      requestsCount: Math.max(0, state.requestsCount - 1),
    }));
    return requestIds;
  };

  const restoreRequests = (requestIds: string[]) =>
    set((state) => ({
      inbox: { ...state.inbox, request: { ...state.inbox.request, ids: requestIds } },
      requestsCount: state.requestsCount + 1,
    }));

  /** Rewrite one loaded message in place; a no-op when the thread is gone. */
  const updateLoadedMessage = (
    conversationId: string,
    messageId: string,
    update: (message: Message) => Message,
  ) =>
    set((state) => {
      const current = state.threads[conversationId];
      if (!current) return {};
      return {
        threads: {
          ...state.threads,
          [conversationId]: {
            ...current,
            messages: updateMessage(current.messages, messageId, update),
          },
        },
      };
    });

  const patchConversation = (
    conversationId: string,
    update: (conversation: Conversation) => Conversation,
  ) => {
    const current = get().conversations[conversationId];
    if (!current) return;
    const next = update(current);
    if (next === current) return;
    set((state) => {
      const conversations = { ...state.conversations, [conversationId]: next };
      return {
        conversations,
        unreadTotal: computeUnreadTotal(state.inbox.default.ids, conversations),
      };
    });
  };

  const applyInboxPage = (
    segment: InboxSegment,
    page: InboxResponse,
    append: boolean,
  ) => {
    set((state) => {
      const conversations = { ...state.conversations };
      for (const conversation of page.items) {
        conversations[conversation.conversation_id] = conversation;
      }
      const existing = state.inbox[segment];
      const pageIds = page.items.map((c) => c.conversation_id);
      const merged = append
        ? {
            ids: [...existing.ids, ...pageIds.filter((id) => !existing.ids.includes(id))],
            cursor: page.next_cursor,
            hasMore: page.next_cursor !== null,
          }
        : mergeInboxRefresh({
            existing,
            pageIds,
            nextCursor: page.next_cursor,
            conversations,
          });
      const inbox = {
        ...state.inbox,
        [segment]: {
          ids: [...merged.ids],
          cursor: merged.cursor,
          hasMore: merged.hasMore,
          status: "ready" as LoadStatus,
          loadingMore: false,
          error: null,
        },
      };
      return {
        availability: "available",
        conversations,
        inbox,
        requestsCount: page.requests_count,
        hasUnreadRequests: page.has_unread_requests,
        unreadTotal: computeUnreadTotal(inbox.default.ids, conversations),
      };
    });
  };

  const withoutSendError = (
    sendErrors: Record<string, string>,
    messageId: string,
  ): Record<string, string> => {
    if (!(messageId in sendErrors)) return sendErrors;
    const { [messageId]: _cleared, ...rest } = sendErrors;
    return rest;
  };

  /**
   * A paging cursor went stale (400 `invalid_cursor`): drop the loaded window
   * and reload the thread from its newest page. Optimistic sends survive.
   */
  const reloadThreadFromStart = async (conversationId: string) => {
    set((state) => {
      const current = state.threads[conversationId] ?? emptyThread();
      return {
        threads: {
          ...state.threads,
          [conversationId]: {
            ...emptyThread(),
            messages: current.messages.filter((m) => m.send_state),
          },
        },
      };
    });
    await get().loadLatest(conversationId);
  };

  const patchInbox = (segment: InboxSegment, patch: Partial<InboxList>) => {
    set((state) => ({
      inbox: { ...state.inbox, [segment]: { ...state.inbox[segment], ...patch } },
    }));
  };

  /** Apply a sent/received message to its conversation's inbox row. */
  const noteLastMessage = (message: Message, countUnread: boolean) => {
    const conversationId = message.conversation_id;
    const conversation = get().conversations[conversationId];
    if (!conversation) return;
    const isNewer =
      !conversation.last_message ||
      message.sent_at >= conversation.last_message.sent_at;
    if (!isNewer) return;
    const isAlreadyLast =
      conversation.last_message?.message_id === message.message_id;
    patchConversation(conversationId, (c) => ({
      ...c,
      last_message: message,
      unread_count:
        countUnread && !isAlreadyLast ? c.unread_count + 1 : c.unread_count,
    }));
    set((state) => {
      const segment: InboxSegment =
        state.conversations[conversationId]?.category === "request" ? "request" : "default";
      if (!state.inbox[segment].ids.includes(conversationId) && state.inbox[segment].status !== "ready") {
        return {};
      }
      return {
        inbox: {
          ...state.inbox,
          [segment]: {
            ...state.inbox[segment],
            ids: promote(state.inbox[segment].ids, conversationId, state.conversations),
          },
        },
      };
    });
  };

  const performSend = async (
    conversationKey: string,
    request: SendMessageRequest,
  ): Promise<SendResult> => {
    try {
      const { message: echo } = await api.sendMessage(request);
      const realId = echo.conversation_id;
      set((state) => {
        const { [request.message_id]: _sent, ...pendingSends } = state.pendingSends;
        const sendErrors = withoutSendError(state.sendErrors, request.message_id);
        const threads = { ...state.threads };
        const source = threads[conversationKey] ?? emptyThread();
        const optimistic = source.messages.find((m) => m.message_id === request.message_id);
        const message = mergeSendEcho(echo, optimistic);
        const withoutOptimistic = removeMessage(source.messages, request.message_id);
        if (realId !== conversationKey) {
          // First message to a new peer: the conversation now has a real id.
          const { [conversationKey]: _draft, ...rest } = threads;
          const target = rest[realId] ?? emptyLiveThread();
          rest[realId] = {
            ...target,
            messages: mergeMessages(
              mergeMessages(target.messages, withoutOptimistic),
              [message],
            ),
          };
          return { pendingSends, sendErrors, threads: rest };
        }
        threads[conversationKey] = {
          ...source,
          messages: mergeMessages(withoutOptimistic, [message]),
        };
        return { pendingSends, sendErrors, threads };
      });
      const confirmed =
        get().threads[realId]?.messages.find((m) => m.message_id === request.message_id) ?? echo;
      if (!get().conversations[realId]) {
        void get().ensureConversation(realId).then(() => noteLastMessage(confirmed, false));
      } else {
        noteLastMessage(confirmed, false);
      }
      return { conversationId: realId, messageId: request.message_id, ok: true };
    } catch (error) {
      noteAvailabilityError(error);
      // Upstream refused this message (content/state): say why. Not an
      // outage, and resending the same request won't help, so no auto-retry.
      const reason = api.isUpstreamRejectedError(error) ? api.upstreamRejectedCopy(error) : null;
      set((state) => {
        const thread = state.threads[conversationKey];
        const sendErrors = reason
          ? { ...state.sendErrors, [request.message_id]: reason }
          : withoutSendError(state.sendErrors, request.message_id);
        if (!thread) return { sendErrors };
        return {
          sendErrors,
          threads: {
            ...state.threads,
            [conversationKey]: {
              ...thread,
              // A concurrent echo (websocket / poll) may already have
              // confirmed this message; never downgrade it to failed.
              messages: updateMessage(thread.messages, request.message_id, (m) =>
                m.send_state === "sending" ? { ...m, send_state: "failed" } : m,
              ),
            },
          },
        };
      });
      return {
        conversationId: request.conversation_id,
        messageId: request.message_id,
        ok: false,
      };
    }
  };

  /** Queue a draft send behind any earlier one to the same peer. */
  const sendFromDraft = (
    draftKey: string,
    request: SendMessageRequest,
  ): Promise<SendResult> => {
    const previous = draftSendChains.get(draftKey) ?? Promise.resolve(null);
    const result = previous.then((realId) => {
      if (!realId) return performSend(draftKey, request);
      // The earlier send created the conversation (and moved this row there).
      const resolved = { ...request, conversation_id: realId, recipient_fids: [] };
      set((state) =>
        state.pendingSends[request.message_id]
          ? { pendingSends: { ...state.pendingSends, [request.message_id]: resolved } }
          : {},
      );
      return performSend(realId, resolved);
    });
    const chain = result.then((outcome) => {
      if (outcome.ok && outcome.conversationId) {
        resolvedDrafts.set(draftKey, outcome.conversationId);
        return outcome.conversationId;
      }
      return resolvedDrafts.get(draftKey) ?? null;
    });
    draftSendChains.set(draftKey, chain);
    void chain.then(() => {
      if (draftSendChains.get(draftKey) === chain) draftSendChains.delete(draftKey);
    });
    return result;
  };

  return {
    ...initialData(),

    setViewer: (viewer) => {
      if (get().viewer?.fid !== viewer?.fid) {
        // A different account must never see the previous one's messages.
        draftSendChains.clear();
        resolvedDrafts.clear();
        set({ ...initialData(), viewer });
        return;
      }
      set({ viewer });
    },

    loadInbox: async (segment) => {
      const current = get().inbox[segment];
      if (current.status === "loading") return;
      patchInbox(segment, {
        status: current.status === "ready" ? "ready" : "loading",
        error: null,
      });
      try {
        const page = await api.getInbox({ category: segment });
        applyInboxPage(segment, page, false);
      } catch (error) {
        if (noteAvailabilityError(error)) {
          patchInbox(segment, { status: "error", error: null });
          return;
        }
        patchInbox(segment, {
          status: get().inbox[segment].ids.length > 0 ? "ready" : "error",
          error: api.messagingErrorCopy(error, "Couldn't load your messages"),
        });
      }
    },

    loadMoreInbox: async (segment) => {
      const { cursor, hasMore, loadingMore, status } = get().inbox[segment];
      if (!cursor || !hasMore || loadingMore || status !== "ready") return;
      patchInbox(segment, { loadingMore: true });
      try {
        const page = await api.getInbox({ category: segment, cursor });
        applyInboxPage(segment, page, true);
      } catch (error) {
        if (api.isInvalidCursorError(error)) {
          // Stale cursor: drop it (and the pages it extended) and reload.
          patchInbox(segment, { ...emptyInbox(), status: "idle" });
          await get().loadInbox(segment);
          return;
        }
        noteAvailabilityError(error);
        patchInbox(segment, {
          loadingMore: false,
          error: api.messagingErrorCopy(error, "Couldn't load more conversations"),
        });
      }
    },

    ensureConversation: async (conversationId) => {
      const existing = get().conversations[conversationId];
      if (existing) return existing;
      try {
        const conversation = await api.getConversation(conversationId);
        set((state) => ({
          availability: "available",
          conversations: { ...state.conversations, [conversationId]: conversation },
        }));
        return conversation;
      } catch (error) {
        if (api.isConversationNotFoundError(error)) noteNotFound(conversationId);
        else noteAvailabilityError(error);
        return null;
      }
    },

    findDirectConversation: async (fid) => {
      try {
        const conversation = await api.getConversationWith(fid);
        set((state) => ({
          availability: "available",
          conversations: { ...state.conversations, [conversation.conversation_id]: conversation },
        }));
        return conversation;
      } catch (error) {
        if (api.isConversationNotFoundError(error)) return null;
        noteAvailabilityError(error);
        throw error;
      }
    },

    loadLatest: async (conversationId) => {
      const thread = get().threads[conversationId];
      if (thread?.status === "loading") return;
      patchThread(conversationId, {
        status: thread && thread.messages.length > 0 && !thread.hasNewer ? "ready" : "loading",
        error: null,
      });
      try {
        const page = await api.getMessages(conversationId);
        set((state) => {
          const current = state.threads[conversationId] ?? emptyThread();
          // The newest page is the live end by definition.
          const latest: WindowPage = {
            ...windowFromMessagesPage(page),
            newerCursor: null,
            hasNewer: false,
          };
          return {
            availability: "available",
            threads: { ...state.threads, [conversationId]: applyWindowPage(current, latest) },
          };
        });
      } catch (error) {
        const isNotFound = api.isConversationNotFoundError(error);
        if (isNotFound) noteNotFound(conversationId);
        else noteAvailabilityError(error);
        patchThread(conversationId, {
          status: "error",
          isNotFound,
          error: isNotFound ? null : api.messagingErrorCopy(error, "Couldn't load this conversation"),
        });
      }
    },

    loadOlder: async (conversationId) => {
      const thread = get().threads[conversationId];
      if (!thread || thread.loadingOlder || !thread.hasOlder || thread.status !== "ready") return;
      if (!thread.olderCursor) {
        patchThread(conversationId, { hasOlder: false });
        return;
      }
      patchThread(conversationId, { loadingOlder: true });
      try {
        const page = await api.getMessages(conversationId, { cursor: thread.olderCursor });
        set((state) => {
          const current = state.threads[conversationId] ?? emptyThread();
          return {
            threads: {
              ...state.threads,
              [conversationId]: {
                ...current,
                messages: mergeMessages(current.messages, page.items),
                olderCursor: page.next_cursor,
                hasOlder: page.next_cursor !== null && page.items.length > 0,
                loadingOlder: false,
              },
            },
          };
        });
      } catch (error) {
        if (api.isInvalidCursorError(error)) {
          await reloadThreadFromStart(conversationId);
          return;
        }
        noteAvailabilityError(error);
        patchThread(conversationId, {
          loadingOlder: false,
          error: api.messagingErrorCopy(error, "Couldn't load older messages"),
        });
      }
    },

    loadNewer: async (conversationId) => {
      const thread = get().threads[conversationId];
      if (!thread || thread.loadingNewer || !thread.hasNewer || thread.status !== "ready") return;
      if (!thread.newerCursor) {
        // No way forward from here; reattach at the live end instead.
        await get().loadLatest(conversationId);
        return;
      }
      patchThread(conversationId, { loadingNewer: true });
      try {
        const page = await api.getMessages(conversationId, { cursor: thread.newerCursor });
        set((state) => {
          const current = state.threads[conversationId] ?? emptyThread();
          const newerCursor = page.next_newer_cursor ?? null;
          const hasNewer = newerCursor !== null && page.items.length > 0;
          return {
            threads: {
              ...state.threads,
              [conversationId]: {
                ...current,
                messages: mergeMessages(current.messages, page.items),
                newerCursor: hasNewer ? newerCursor : null,
                hasNewer,
                newerWhileDetached: hasNewer ? current.newerWhileDetached : 0,
                loadingNewer: false,
              },
            },
          };
        });
        // Reached the live end: pick up anything the cursor walk raced past.
        if (!get().threads[conversationId]?.hasNewer) void get().pollRecent(conversationId);
      } catch (error) {
        if (api.isInvalidCursorError(error)) {
          await reloadThreadFromStart(conversationId);
          return;
        }
        noteAvailabilityError(error);
        patchThread(conversationId, {
          loadingNewer: false,
          error: api.messagingErrorCopy(error, "Couldn't load newer messages"),
        });
      }
    },

    pollRecent: async (conversationId) => {
      const thread = get().threads[conversationId];
      if (!thread || thread.status !== "ready") return;
      try {
        const page = await api.getRecentMessages(conversationId);
        set((state) => {
          const current = state.threads[conversationId];
          if (!current) return {};
          if (current.hasNewer) {
            const known = new Set(current.messages.map((m) => m.message_id));
            const newest = current.messages.at(-1)?.sent_at ?? 0;
            const fresh = page.items.filter(
              (m) => !known.has(m.message_id) && m.sent_at > newest,
            ).length;
            return fresh === current.newerWhileDetached
              ? {}
              : {
                  threads: {
                    ...state.threads,
                    [conversationId]: { ...current, newerWhileDetached: fresh },
                  },
                };
          }
          const messages = mergeMessages(current.messages, page.items);
          if (messages === current.messages) return {};
          return {
            threads: { ...state.threads, [conversationId]: { ...current, messages } },
          };
        });
        const latest = get().threads[conversationId]?.messages.at(-1);
        if (latest && !latest.send_state) noteLastMessage(latest, false);
      } catch (error) {
        // Polling failures are transient; only availability changes surface.
        noteAvailabilityError(error);
      }
    },

    jumpToMessage: async (conversationId, messageId) => {
      const loaded = get().threads[conversationId]?.messages ?? [];
      if (loaded.some((m) => m.message_id === messageId)) return true;
      try {
        const page = await api.getMessages(conversationId, { anchorMessageId: messageId });
        if (!page.items.some((m) => m.message_id === messageId)) return false;
        set((state) => ({
          threads: {
            ...state.threads,
            [conversationId]: applyWindowPage(
              state.threads[conversationId] ?? emptyThread(),
              windowFromMessagesPage(page),
            ),
          },
        }));
        return true;
      } catch (error) {
        noteAvailabilityError(error);
        return false;
      }
    },

    seedFromSearchHit: (hit) => {
      const conversationId = hit.conversation.conversation_id;
      const messageId = hit.message.message_id;
      const loaded = get().threads[conversationId]?.messages ?? [];
      if (loaded.some((m) => m.message_id === messageId)) return;
      // Older servers send no thread cursors; jumpToMessage (anchor) covers it.
      if (hit.thread_cursor === undefined || hit.thread_newer_cursor === undefined) return;
      set((state) => ({
        conversations: state.conversations[conversationId]
          ? state.conversations
          : { ...state.conversations, [conversationId]: hit.conversation },
        threads: {
          ...state.threads,
          [conversationId]: applyWindowPage(state.threads[conversationId] ?? emptyThread(), {
            items: [...hit.after, hit.message, ...hit.before],
            olderCursor: hit.thread_cursor ?? null,
            newerCursor: hit.thread_newer_cursor ?? null,
            hasNewer: hit.thread_newer_cursor !== null,
          }),
        },
      }));
    },

    acceptRequest: async (conversationId) => {
      const before = get().conversations[conversationId];
      const requestIds = removeFromRequests(conversationId);
      patchConversation(conversationId, (c) => ({ ...c, category: "default" }));
      try {
        await api.acceptConversation(conversationId);
      } catch (error) {
        noteAvailabilityError(error);
        restoreRequests(requestIds);
        if (before) patchConversation(conversationId, () => before);
        throw error;
      }
      await Promise.all([get().loadInbox("default"), get().loadInbox("request")]);
    },

    declineRequest: async (conversationId) => {
      const requestIds = removeFromRequests(conversationId);
      try {
        await api.declineConversation(conversationId);
      } catch (error) {
        noteAvailabilityError(error);
        restoreRequests(requestIds);
        throw error;
      }
      await get().loadInbox("request");
    },

    sendMessage: async ({
      conversationId,
      recipientFid = null,
      text,
      replyTo,
      processMetadata = true,
    }) => {
      const viewer = get().viewer;
      const trimmed = text.trim();
      const messageId = newMessageId();
      if (!viewer || !trimmed || (!conversationId && recipientFid == null)) {
        return { conversationId, messageId, ok: false };
      }
      const draftKey = conversationId ? null : draftConversationKey(recipientFid as number);
      // A draft whose first send already landed sends to the real id.
      const knownId = conversationId ?? (draftKey ? resolvedDrafts.get(draftKey) ?? null : null);
      const conversationKey = knownId ?? (draftKey as string);
      const request: SendMessageRequest = {
        conversation_id: knownId,
        recipient_fids: knownId ? [] : [recipientFid as number],
        message_id: messageId,
        text: trimmed,
        in_reply_to_id: replyTo?.message_id ?? null,
        ...(processMetadata ? {} : { process_metadata: false }),
      };
      const optimistic = buildOptimisticMessage({
        messageId,
        conversationId: conversationKey,
        sender: viewer,
        text: trimmed,
        sentAt: optimisticSentAt(get().threads[conversationKey]?.messages ?? [], Date.now()),
        replyTo,
      });
      set((state) => {
        const thread = state.threads[conversationKey] ?? emptyLiveThread();
        return {
          pendingSends: { ...state.pendingSends, [messageId]: request },
          threads: {
            ...state.threads,
            [conversationKey]: {
              ...thread,
              messages: mergeMessages(thread.messages, [optimistic]),
            },
          },
          replyTargets: { ...state.replyTargets, [conversationKey]: null },
          drafts: {
            ...state.drafts,
            [conversationKey]: "",
            // The composer of a resolved draft is still keyed `draft:{fid}`.
            ...(draftKey ? { [draftKey]: "" } : {}),
          },
        };
      });
      clearPersistedDraft(viewer.fid, conversationKey);
      if (draftKey && draftKey !== conversationKey) clearPersistedDraft(viewer.fid, draftKey);
      if (knownId) return performSend(conversationKey, request);
      return sendFromDraft(conversationKey, request);
    },

    retrySend: async (conversationKey, messageId) => {
      const request = get().pendingSends[messageId];
      if (!request) return { conversationId: conversationKey, messageId, ok: false };
      patchThread(conversationKey, {
        messages: updateMessage(
          get().threads[conversationKey]?.messages ?? [],
          messageId,
          (m) => ({ ...m, send_state: "sending" }),
        ),
      });
      set((state) => ({ sendErrors: withoutSendError(state.sendErrors, messageId) }));
      // Same message_id: the backend forwards it as the upstream
      // idempotency-key, so a send that actually landed is not duplicated.
      return performSend(conversationKey, request);
    },

    discardFailed: (conversationKey, messageId) => {
      set((state) => {
        const thread = state.threads[conversationKey];
        const { [messageId]: _discarded, ...pendingSends } = state.pendingSends;
        const sendErrors = withoutSendError(state.sendErrors, messageId);
        if (!thread) return { pendingSends, sendErrors };
        return {
          pendingSends,
          sendErrors,
          threads: {
            ...state.threads,
            [conversationKey]: { ...thread, messages: removeMessage(thread.messages, messageId) },
          },
        };
      });
    },

    toggleReaction: async (conversationId, messageId, reaction) => {
      const thread = get().threads[conversationId];
      const message = thread?.messages.find((m) => m.message_id === messageId);
      if (!thread || !message || message.send_state) return;
      const hasReacted = message.reactions.some(
        (r) => r.reaction === reaction && r.viewer_reacted,
      );
      const snapshot = message.reactions;
      const setReactions = (
        update: (reactions: MessageReactionSummary[]) => MessageReactionSummary[],
      ) => updateLoadedMessage(conversationId, messageId, (m) => ({ ...m, reactions: update(m.reactions) }));
      setReactions((reactions) => toggleReactionSummary(reactions, reaction, !hasReacted));
      try {
        const request = { conversation_id: conversationId, message_id: messageId, reaction };
        await (hasReacted ? api.removeReaction(request) : api.addReaction(request));
      } catch (error) {
        noteAvailabilityError(error);
        // Restore exactly what was there; a relative re-toggle drifts when
        // another update (poll, websocket) landed in between.
        setReactions(() => snapshot);
        throw error;
      }
    },

    deleteMessage: async (conversationId, messageId) => {
      const thread = get().threads[conversationId];
      const original = thread?.messages.find((m) => m.message_id === messageId);
      if (!thread || !original) return;
      const setDeleted = (isDeleted: boolean) =>
        updateLoadedMessage(conversationId, messageId, (m) => ({ ...m, is_deleted: isDeleted }));
      setDeleted(true);
      try {
        await api.deleteMessage(conversationId, messageId);
      } catch (error) {
        noteAvailabilityError(error);
        setDeleted(original.is_deleted);
        throw error;
      }
    },

    markRead: async (conversationId) => {
      const conversation = get().conversations[conversationId];
      if (
        conversation &&
        conversation.unread_count === 0 &&
        !conversation.manually_marked_unread
      ) {
        return;
      }
      const newestId =
        get().threads[conversationId]?.messages.filter((m) => !m.send_state).at(-1)?.message_id ?? null;
      const isAlreadyMarked =
        newestId !== null &&
        get().readMarks[conversationId] === newestId &&
        !conversation?.manually_marked_unread;
      patchConversation(conversationId, (c) => ({
        ...c,
        unread_count: 0,
        unread_mentions_count: 0,
        manually_marked_unread: false,
        last_read_at: Date.now(),
      }));
      // A stale inbox poll can resurrect the count; the server already has
      // this mark, so only the local state needs fixing.
      if (isAlreadyMarked) return;
      if (newestId !== null) {
        set((state) => ({ readMarks: { ...state.readMarks, [conversationId]: newestId } }));
      }
      try {
        await api.markConversationRead(conversationId);
      } catch (error) {
        // Unread counts self-heal on the next inbox poll.
        noteAvailabilityError(error);
      }
    },

    markUnread: async (conversationId) => {
      set((state) => {
        const { [conversationId]: _cleared, ...readMarks } = state.readMarks;
        return { readMarks };
      });
      patchConversation(conversationId, (c) => ({ ...c, manually_marked_unread: true }));
      try {
        await api.markConversationUnread(conversationId);
      } catch (error) {
        noteAvailabilityError(error);
        patchConversation(conversationId, (c) => ({ ...c, manually_marked_unread: false }));
        throw error;
      }
    },

    ingestEvent: (event) => {
      if (event.type === "ping") return false;
      if (event.type === "inbox") return true;
      const conversationId = event.conversation_id;
      if (event.type === "read") {
        if (event.read_by === "peer") {
          // The peer read: only the receipt changes. The frame carries no
          // timestamp, so refetch the conversation for the new value.
          void api
            .getConversation(conversationId)
            .then((fresh) =>
              patchConversation(conversationId, (c) =>
                c.peer_last_read_at === fresh.peer_last_read_at
                  ? c
                  : { ...c, peer_last_read_at: fresh.peer_last_read_at },
              ),
            )
            .catch((error: unknown) => {
              noteAvailabilityError(error);
            });
          return false;
        }
        patchConversation(conversationId, (c) =>
          c.unread_count === 0 && !c.manually_marked_unread
            ? c
            : { ...c, unread_count: 0, unread_mentions_count: 0, manually_marked_unread: false },
        );
        return false;
      }

      const { message } = event;
      const state = get();
      const thread = state.threads[conversationId];
      if (thread) {
        if (thread.hasNewer) {
          patchThread(conversationId, { newerWhileDetached: thread.newerWhileDetached + 1 });
        } else {
          const messages = mergeMessages(thread.messages, [message]);
          if (messages !== thread.messages) patchThread(conversationId, { messages });
        }
      }
      const isIncoming = message.sender.fid !== state.viewer?.fid;
      const isFocused =
        state.focusedConversationId === conversationId &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible";
      if (!state.conversations[conversationId]) return true;
      noteLastMessage(message, isIncoming && !isFocused);
      return false;
    },

    setReplyTarget: (conversationKey, message) =>
      set((state) => ({ replyTargets: { ...state.replyTargets, [conversationKey]: message } })),

    setDraft: (conversationKey, text) => {
      if (get().drafts[conversationKey] === text) return;
      set((state) => ({ drafts: { ...state.drafts, [conversationKey]: text } }));
      const fid = get().viewer?.fid;
      if (fid != null) persistDraft(fid, conversationKey, text);
    },

    restoreDraft: (conversationKey) => {
      const fid = get().viewer?.fid;
      if (fid == null || !conversationKey || get().drafts[conversationKey]) return;
      const saved = loadPersistedDraft(fid, conversationKey);
      if (saved) set((state) => ({ drafts: { ...state.drafts, [conversationKey]: saved } }));
    },

    setFocusedConversation: (focusedConversationId) => set({ focusedConversationId }),

    setRealtimeConnected: (realtimeConnected) => set({ realtimeConnected }),

    setAvailability: (availability) =>
      set((state) => (state.availability === availability ? {} : { availability })),

    reset: () => {
      draftSendChains.clear();
      resolvedDrafts.clear();
      set(initialData());
    },
  };
});
