/**
 * Direct Cast state: inbox segments, per-conversation message windows,
 * optimistic sends, reply targets and the tab-bar unread total.
 *
 * Message windows are kept newest-first (the order an inverted list renders)
 * and deduped by `message_id`. Windows page in both directions (§4.3):
 * `olderCursor` comes from the oldest page loaded and `newerCursor` from the
 * newest. A window is "detached" while `newerCursor` is non-null, i.e. it was
 * loaded around a jump target and has not yet reached the live tail; the
 * thread then pages forward instead of polling `/recent` into a gap.
 */

import { create } from "zustand";
import type { MessagingTokenErrorCode } from "@/services/messagesApi";
import type {
  Conversation,
  InboxResponse,
  Message,
  MessageReactionSummary,
  MessageSearchHit,
  MessagesPage,
} from "@/types/messages";

export type InboxSegment = "default" | "request";
export type MessagingAvailability = "unknown" | "available" | "unavailable";

/** Direct Cast token problems that surface the "Enable messages" gate. */
export type MessagingAccessError = MessagingTokenErrorCode;

/**
 * The events socket. `disconnected` covers both "not started" and "gave
 * up"; polling carries freshness either way.
 */
export type RealtimeStatus = "connected" | "reconnecting" | "disconnected";

/**
 * How an inbox page lands in its segment:
 * - `replace`: the first load; the page becomes the whole list.
 * - `merge`: a background poll, pull-to-refresh or badge fetch of page one.
 *   Page-one conversations are upserted and moved to the top in server
 *   (last-activity) order; conversations already loaded beyond page one
 *   stay below, and the pagination cursor is kept so the tail can still
 *   page on. A page with no `next_cursor` is the whole inbox and replaces.
 * - `append`: the next page from `cursor`.
 */
export type InboxPageMode = "replace" | "merge" | "append";

export interface InboxSlice {
  ids: string[];
  cursor: string | null;
  hasMore: boolean;
  loadedAt: number | null;
}

export interface ThreadState {
  /** Newest first. */
  messages: Message[];
  olderCursor: string | null;
  hasOlder: boolean;
  newerCursor: string | null;
  /** True while the window has not reached the live tail. */
  hasNewer: boolean;
  /** Same as `hasNewer`; kept as the name the UI reads. */
  isDetached: boolean;
  isLoaded: boolean;
  /**
   * When the window was last confirmed contiguous with the live tail (ms
   * epoch): a latest-page load, or a `/recent` poll that overlapped it.
   * Null until then. Websocket pushes don't count: frames missed while the
   * socket was down would leave a hole behind them.
   */
  syncedAt: number | null;
}

/**
 * - `replace`: the latest page; resets the window.
 * - `older` / `newer`: one page further in that direction.
 * - `anchor`: a window around a jump target (anchor fetch or search seed);
 *   merged only when it shares a message id with the loaded window.
 */
export type ThreadPageMode = "replace" | "older" | "newer" | "anchor";

interface MessageStoreData {
  availability: MessagingAvailability;
  accessError: MessagingAccessError | null;
  realtimeStatus: RealtimeStatus;
  conversations: Record<string, Conversation>;
  inbox: Record<InboxSegment, InboxSlice>;
  requestsCount: number;
  hasUnreadRequests: boolean;
  unreadTotal: number;
  threads: Record<string, ThreadState>;
  replyTargets: Record<string, Message | null>;
  /** Draft thread key -> real conversation id, once the first send lands. */
  draftAliases: Record<string, string>;
  /** Search hits handed from the search screen to the thread, by message id. */
  searchSeeds: Record<string, MessageSearchHit>;
  /** Inverted-list scroll offset per thread, restored on return. */
  scrollOffsets: Record<string, number>;
}

interface MessageStore extends MessageStoreData {
  setAvailability: (availability: MessagingAvailability) => void;
  setAccessError: (error: MessagingAccessError | null) => void;
  setRealtimeStatus: (status: RealtimeStatus) => void;
  setInboxPage: (
    segment: InboxSegment,
    response: InboxResponse,
    mode: InboxPageMode,
  ) => void;
  /** Drop one conversation from a segment's list (it moved or was declined). */
  removeFromInbox: (segment: InboxSegment, conversationId: string) => void;
  upsertConversation: (conversation: Conversation) => void;
  patchConversation: (
    conversationId: string,
    patch: Partial<Conversation>,
  ) => void;
  setThreadPage: (
    conversationId: string,
    page: MessagesPage,
    mode: ThreadPageMode,
  ) => void;
  mergeLatest: (conversationId: string, messages: Message[]) => void;
  /** Record that the window was just confirmed at the live tail. */
  markThreadSynced: (conversationId: string, syncedAt: number) => void;
  upsertMessage: (conversationId: string, message: Message) => void;
  /** Merge a send echo onto its optimistic row (keeps reply/metadata). */
  confirmSentMessage: (conversationId: string, echo: Message) => void;
  /** Mark a send failed only if the row is still `sending`. */
  markSendFailed: (conversationId: string, messageId: string) => void;
  patchMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<Message>,
  ) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  /** Move optimistic messages from a draft key to the real conversation id. */
  adoptDraftThread: (draftKey: string, conversationId: string) => void;
  applyReaction: (
    conversationId: string,
    messageId: string,
    reaction: string,
    add: boolean,
  ) => void;
  /** The viewer read the thread (here or on another device). */
  markReadLocal: (conversationId: string) => void;
  /** The other party read up to `peerLastReadAt`; unread state untouched. */
  applyPeerRead: (conversationId: string, peerLastReadAt: number | null) => void;
  stashSearchSeed: (hit: MessageSearchHit) => void;
  /** Return and forget the seed for `messageId`. */
  takeSearchSeed: (messageId: string) => MessageSearchHit | null;
  setScrollOffset: (threadKey: string, offset: number) => void;
  setReplyTarget: (conversationId: string, message: Message | null) => void;
  reset: () => void;
}

const EMPTY_SLICE: InboxSlice = {
  ids: [],
  cursor: null,
  hasMore: true,
  loadedAt: null,
};

export const EMPTY_THREAD: ThreadState = {
  messages: [],
  olderCursor: null,
  hasOlder: false,
  newerCursor: null,
  hasNewer: false,
  isDetached: false,
  isLoaded: false,
  syncedAt: null,
};

/** A thread created locally (an optimistic send or a pushed message). */
const LOCAL_THREAD: ThreadState = { ...EMPTY_THREAD, isLoaded: true };

const INITIAL_STATE: MessageStoreData = {
  availability: "unknown",
  accessError: null,
  realtimeStatus: "disconnected",
  conversations: {},
  inbox: { default: EMPTY_SLICE, request: EMPTY_SLICE },
  requestsCount: 0,
  hasUnreadRequests: false,
  unreadTotal: 0,
  threads: {},
  replyTargets: {},
  draftAliases: {},
  searchSeeds: {},
  scrollOffsets: {},
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function compareNewestFirst(a: Message, b: Message): number {
  if (a.sent_at !== b.sent_at) return b.sent_at - a.sent_at;
  return a.message_id < b.message_id ? 1 : -1;
}

/** Drop the client-only `send_state`: the server copy confirms the send. */
function toServerCopy(message: Message): Message {
  const { send_state: _ignored, ...serverCopy } = message;
  return serverCopy;
}

/** Newest-first union of two lists; `incoming` wins on a shared id. */
function mergeById(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of existing) byId.set(message.message_id, message);
  for (const message of incoming) byId.set(message.message_id, message);
  return Array.from(byId.values()).sort(compareNewestFirst);
}

/** Insert `message`, replacing any copy with the same id, newest-first. */
function replaceMessage(messages: Message[], message: Message): Message[] {
  const without = messages.filter((m) => m.message_id !== message.message_id);
  return [message, ...without].sort(compareNewestFirst);
}

function mapMessage(
  messages: Message[],
  messageId: string,
  update: (message: Message) => Message,
): Message[] {
  return messages.map((m) => (m.message_id === messageId ? update(m) : m));
}

export function isConversationUnread(conversation: Conversation): boolean {
  return conversation.unread_count > 0 || conversation.manually_marked_unread;
}

/**
 * Merge two message lists into one newest-first, id-deduped list. Incoming
 * server copies win and confirm any optimistic copy with the same id (send
 * ids are client-generated, so the echo shares it). Pending messages absent
 * from `incoming` are kept untouched. Page order from the server is not
 * assumed; the result is always re-sorted.
 */
export function mergeMessages(
  existing: Message[],
  incoming: Message[],
): Message[] {
  return mergeById(existing, incoming.map(toServerCopy));
}

/** Fields of a thread window derived from a page's cursors. */
function cursorFields(
  olderCursor: string | null,
  newerCursor: string | null,
): Pick<
  ThreadState,
  "olderCursor" | "hasOlder" | "newerCursor" | "hasNewer" | "isDetached"
> {
  return {
    olderCursor,
    hasOlder: olderCursor !== null,
    newerCursor,
    hasNewer: newerCursor !== null,
    isDetached: newerCursor !== null,
  };
}

/**
 * Apply a jump-target window. It joins the loaded window only when the two
 * share a message id (time is not a contiguity signal: the server's pages
 * have no gaps only within one cursor chain). The merged window keeps the
 * older cursor of whichever side reaches further back and the newer cursor
 * of whichever reaches further forward, so a window already at the live
 * tail stays attached.
 */
export function applyAnchorPage(
  current: ThreadState,
  page: MessagesPage,
): ThreadState {
  const loadedIds = new Set(current.messages.map((m) => m.message_id));
  const overlaps =
    current.isLoaded && page.items.some((m) => loadedIds.has(m.message_id));
  if (!overlaps) {
    const newerCursor = page.next_newer_cursor ?? null;
    return {
      messages: mergeMessages([], page.items),
      ...cursorFields(page.next_cursor, newerCursor),
      isLoaded: true,
      // No newer page: this window already ends at the live tail.
      syncedAt: newerCursor === null ? Date.now() : null,
    };
  }
  const pageSorted = mergeMessages([], page.items);
  const pageNewest = pageSorted[0];
  const pageOldest = pageSorted[pageSorted.length - 1];
  const currentNewest = current.messages[0];
  const currentOldest = current.messages[current.messages.length - 1];
  const reachesOlder = compareNewestFirst(pageOldest, currentOldest) > 0;
  const reachesNewer = compareNewestFirst(pageNewest, currentNewest) < 0;
  const olderCursor = reachesOlder ? page.next_cursor : current.olderCursor;
  const newerCursor =
    reachesNewer && current.hasNewer
      ? (page.next_newer_cursor ?? null)
      : current.newerCursor;
  return {
    ...current,
    messages: mergeMessages(current.messages, page.items),
    ...cursorFields(olderCursor, newerCursor),
  };
}

/** Seed page for a search hit: `[...after, message, ...before]` (§4.4). */
export function searchHitToPage(hit: MessageSearchHit): MessagesPage {
  return {
    items: [...hit.after, hit.message, ...hit.before],
    next_cursor: hit.thread_cursor ?? null,
    next_newer_cursor: hit.thread_newer_cursor ?? null,
  };
}

/** True when the hit carries cursors to seed a pageable window. */
export function canSeedFromHit(hit: MessageSearchHit): boolean {
  return (
    hit.thread_cursor !== undefined || hit.thread_newer_cursor !== undefined
  );
}

/**
 * A send echo whose parent was not in the server's cache carries only the
 * parent id: `sender.fid === 0`, empty text (§4.2 `PUT /send`).
 */
function isPlaceholderQuote(quote: Message["in_reply_to"]): boolean {
  return quote?.sender.fid === 0;
}

/**
 * Echo wins, but a field the echo leaves empty keeps the optimistic value,
 * and a placeholder reply quote keeps the locally known one.
 */
export function mergeSendEcho(optimistic: Message | undefined, echo: Message): Message {
  const serverCopy = toServerCopy(echo);
  if (!optimistic) return serverCopy;
  const echoQuote = isPlaceholderQuote(serverCopy.in_reply_to)
    ? null
    : serverCopy.in_reply_to;
  return {
    ...serverCopy,
    in_reply_to: echoQuote ?? optimistic.in_reply_to ?? serverCopy.in_reply_to,
    metadata: serverCopy.metadata ?? optimistic.metadata,
  };
}

/** Rewrite one loaded thread's messages; a missing thread is left alone. */
function updateThreadMessages(
  threads: Record<string, ThreadState>,
  threadKey: string,
  update: (messages: Message[]) => Message[],
): Pick<MessageStore, "threads"> | Record<string, never> {
  const current = threads[threadKey];
  if (!current) return {};
  return {
    threads: {
      ...threads,
      [threadKey]: { ...current, messages: update(current.messages) },
    },
  };
}

/** Unread total for the tab badge: unmuted default-inbox conversations. */
export function computeUnreadTotal(
  ids: string[],
  conversations: Record<string, Conversation>,
): number {
  let total = 0;
  for (const id of ids) {
    const conversation = conversations[id];
    if (!conversation || conversation.muted) continue;
    if (conversation.unread_count > 0) {
      total += conversation.unread_count;
    } else if (conversation.manually_marked_unread) {
      total += 1;
    }
  }
  return total;
}

/** Toggle the viewer's reaction in a summary list. */
export function toggleReactionSummary(
  reactions: MessageReactionSummary[],
  reaction: string,
  add: boolean,
): MessageReactionSummary[] {
  const index = reactions.findIndex((r) => r.reaction === reaction);
  if (index < 0) {
    if (!add) return reactions;
    return [...reactions, { reaction, count: 1, viewer_reacted: true }];
  }
  const current = reactions[index];
  if (current.viewer_reacted === add) return reactions;
  const count = Math.max(0, current.count + (add ? 1 : -1));
  if (count === 0) return reactions.filter((_, i) => i !== index);
  const next = [...reactions];
  next[index] = { ...current, count, viewer_reacted: add };
  return next;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/**
 * The segment slice after `response` lands in `mode` (see `InboxPageMode`).
 * `now` stamps `loadedAt`.
 */
export function applyInboxPage(
  current: InboxSlice,
  response: InboxResponse,
  mode: InboxPageMode,
  now: number,
): InboxSlice {
  const pageIds = response.items.map((c) => c.conversation_id);
  const fromPage = {
    cursor: response.next_cursor,
    hasMore: response.next_cursor !== null,
    loadedAt: now,
  };
  if (mode === "append") {
    return { ids: uniqueIds([...current.ids, ...pageIds]), ...fromPage };
  }
  const isWholeInbox = response.next_cursor === null;
  const hasTail = current.loadedAt !== null && current.ids.length > 0;
  if (mode === "replace" || isWholeInbox || !hasTail) {
    return { ids: uniqueIds(pageIds), ...fromPage };
  }
  const onPage = new Set(pageIds);
  const tail = current.ids.filter((id) => !onPage.has(id));
  return {
    ids: uniqueIds([...pageIds, ...tail]),
    cursor: current.cursor,
    hasMore: current.hasMore,
    loadedAt: now,
  };
}

/** The tab badge counts the default inbox only. */
function inboxUnreadTotal(
  inbox: Record<InboxSegment, InboxSlice>,
  conversations: Record<string, Conversation>,
): number {
  return computeUnreadTotal(inbox.default.ids, conversations);
}

export const useMessageStore = create<MessageStore>((set, get) => ({
  ...INITIAL_STATE,

  setAvailability: (availability) => set({ availability }),
  setAccessError: (accessError) => set({ accessError }),
  setRealtimeStatus: (realtimeStatus) =>
    set((state) => (state.realtimeStatus === realtimeStatus ? {} : { realtimeStatus })),

  setInboxPage: (segment, response, mode) =>
    set((state) => {
      const conversations = { ...state.conversations };
      for (const conversation of response.items) {
        conversations[conversation.conversation_id] = conversation;
      }
      const inbox = {
        ...state.inbox,
        [segment]: applyInboxPage(state.inbox[segment], response, mode, Date.now()),
      };
      return {
        availability: "available" as const,
        accessError: null,
        conversations,
        inbox,
        requestsCount: response.requests_count,
        hasUnreadRequests: response.has_unread_requests,
        unreadTotal: inboxUnreadTotal(inbox, conversations),
      };
    }),

  removeFromInbox: (segment, conversationId) =>
    set((state) => {
      const slice = state.inbox[segment];
      if (!slice.ids.includes(conversationId)) return {};
      const inbox = {
        ...state.inbox,
        [segment]: { ...slice, ids: slice.ids.filter((id) => id !== conversationId) },
      };
      return {
        inbox,
        unreadTotal: inboxUnreadTotal(inbox, state.conversations),
      };
    }),

  upsertConversation: (conversation) =>
    set((state) => {
      const conversations = {
        ...state.conversations,
        [conversation.conversation_id]: conversation,
      };
      return {
        conversations,
        unreadTotal: inboxUnreadTotal(state.inbox, conversations),
      };
    }),

  patchConversation: (conversationId, patch) =>
    set((state) => {
      const current = state.conversations[conversationId];
      if (!current) return {};
      const conversations = {
        ...state.conversations,
        [conversationId]: { ...current, ...patch },
      };
      return {
        conversations,
        unreadTotal: inboxUnreadTotal(state.inbox, conversations),
      };
    }),

  setThreadPage: (conversationId, page, mode) =>
    set((state) => {
      const current = state.threads[conversationId] ?? EMPTY_THREAD;
      let next: ThreadState;
      if (mode === "older") {
        next = {
          ...current,
          messages: mergeMessages(current.messages, page.items),
          olderCursor: page.next_cursor,
          hasOlder: page.next_cursor !== null,
        };
      } else if (mode === "newer") {
        const newerCursor = page.next_newer_cursor ?? null;
        next = {
          ...current,
          messages: mergeMessages(current.messages, page.items),
          ...cursorFields(current.olderCursor, newerCursor),
          // Paging forward until there is no newer page reaches the tail.
          syncedAt: newerCursor === null ? Date.now() : current.syncedAt,
        };
      } else if (mode === "anchor") {
        next = applyAnchorPage(current, page);
      } else {
        const pending = current.messages.filter((m) => m.send_state);
        next = {
          messages: mergeMessages(pending, page.items),
          ...cursorFields(page.next_cursor, page.next_newer_cursor ?? null),
          isLoaded: true,
          syncedAt: Date.now(),
        };
      }
      return { threads: { ...state.threads, [conversationId]: next } };
    }),

  mergeLatest: (conversationId, messages) =>
    set((state) => {
      const current = state.threads[conversationId];
      // Nothing loaded yet, or the window is detached from the live tail:
      // appending would open a silent gap.
      if (!current?.isLoaded || current.isDetached) return {};
      return updateThreadMessages(state.threads, conversationId, (existing) =>
        mergeMessages(existing, messages),
      );
    }),

  markThreadSynced: (conversationId, syncedAt) =>
    set((state) => {
      const current = state.threads[conversationId];
      if (!current?.isLoaded || current.isDetached) return {};
      return {
        threads: { ...state.threads, [conversationId]: { ...current, syncedAt } },
      };
    }),

  upsertMessage: (conversationId, message) =>
    set((state) => {
      const current = state.threads[conversationId] ?? LOCAL_THREAD;
      return {
        threads: {
          ...state.threads,
          [conversationId]: {
            ...current,
            messages: replaceMessage(current.messages, message),
          },
        },
      };
    }),

  confirmSentMessage: (conversationId, echo) =>
    set((state) => {
      const current = state.threads[conversationId] ?? LOCAL_THREAD;
      const optimistic = current.messages.find(
        (m) => m.message_id === echo.message_id,
      );
      return {
        threads: {
          ...state.threads,
          [conversationId]: {
            ...current,
            messages: replaceMessage(current.messages, mergeSendEcho(optimistic, echo)),
          },
        },
      };
    }),

  markSendFailed: (conversationId, messageId) =>
    set((state) =>
      updateThreadMessages(state.threads, conversationId, (messages) =>
        mapMessage(messages, messageId, (m) =>
          m.send_state === "sending" ? { ...m, send_state: "failed" } : m,
        ),
      ),
    ),

  patchMessage: (conversationId, messageId, patch) =>
    set((state) =>
      updateThreadMessages(state.threads, conversationId, (messages) =>
        mapMessage(messages, messageId, (m) => ({ ...m, ...patch })),
      ),
    ),

  removeMessage: (conversationId, messageId) =>
    set((state) =>
      updateThreadMessages(state.threads, conversationId, (messages) =>
        messages.filter((m) => m.message_id !== messageId),
      ),
    ),

  adoptDraftThread: (draftKey, conversationId) =>
    set((state) => {
      const draft = state.threads[draftKey];
      if (!draft) {
        return {
          draftAliases: { ...state.draftAliases, [draftKey]: conversationId },
        };
      }
      const target = state.threads[conversationId] ?? LOCAL_THREAD;
      const moved = draft.messages.map((m) => ({
        ...m,
        conversation_id: conversationId,
      }));
      const threads = { ...state.threads };
      delete threads[draftKey];
      threads[conversationId] = {
        ...target,
        // Keeps each moved message's own `send_state`.
        messages: mergeById(target.messages, moved),
      };
      const replyTargets = { ...state.replyTargets };
      delete replyTargets[draftKey];
      return {
        threads,
        replyTargets,
        draftAliases: { ...state.draftAliases, [draftKey]: conversationId },
      };
    }),

  applyReaction: (conversationId, messageId, reaction, add) =>
    set((state) =>
      updateThreadMessages(state.threads, conversationId, (messages) =>
        mapMessage(messages, messageId, (m) => ({
          ...m,
          reactions: toggleReactionSummary(m.reactions, reaction, add),
        })),
      ),
    ),

  markReadLocal: (conversationId) =>
    set((state) => {
      const current = state.conversations[conversationId];
      if (!current || !isConversationUnread(current)) return {};
      const conversations = {
        ...state.conversations,
        [conversationId]: {
          ...current,
          unread_count: 0,
          unread_mentions_count: 0,
          manually_marked_unread: false,
          last_read_at: Date.now(),
        },
      };
      return {
        conversations,
        unreadTotal: inboxUnreadTotal(state.inbox, conversations),
      };
    }),

  applyPeerRead: (conversationId, peerLastReadAt) =>
    set((state) => {
      const current = state.conversations[conversationId];
      if (!current || current.peer_last_read_at === peerLastReadAt) return {};
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: { ...current, peer_last_read_at: peerLastReadAt },
        },
      };
    }),

  stashSearchSeed: (hit) =>
    set((state) => ({
      searchSeeds: { ...state.searchSeeds, [hit.message.message_id]: hit },
    })),

  takeSearchSeed: (messageId) => {
    const seed = get().searchSeeds[messageId] ?? null;
    if (!seed) return null;
    set((state) => {
      const searchSeeds = { ...state.searchSeeds };
      delete searchSeeds[messageId];
      return { searchSeeds };
    });
    return seed;
  },

  setScrollOffset: (threadKey, offset) =>
    set((state) =>
      state.scrollOffsets[threadKey] === offset
        ? {}
        : { scrollOffsets: { ...state.scrollOffsets, [threadKey]: offset } },
    ),

  setReplyTarget: (conversationId, message) =>
    set((state) => ({
      replyTargets: { ...state.replyTargets, [conversationId]: message },
    })),

  reset: () => set(INITIAL_STATE),
}));

/** The live store key for `threadKey`: a draft resolves to its real id. */
export function resolveThreadKey(threadKey: string): string {
  return useMessageStore.getState().draftAliases[threadKey] ?? threadKey;
}

/** Key for optimistic messages sent before a 1:1 conversation exists. */
export function draftThreadKey(recipientFid: number): string {
  return `draft:${recipientFid}`;
}

/** Find a loaded 1:1 conversation with `fid`, if any. */
export function findDirectConversation(
  conversations: Record<string, Conversation>,
  fid: number,
): Conversation | null {
  for (const conversation of Object.values(conversations)) {
    if (conversation.is_group) continue;
    if (conversation.counterparty?.fid === fid) return conversation;
  }
  return null;
}
