/**
 * One thread's data: metadata, the newest-first message window, paging in
 * both directions (§4.3), jump-to-message (search seed or
 * `anchor_message_id`), a 4 s recent-messages poll while focused and at the
 * live tail (design §3.4), and read-state upkeep.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConversation,
  getMessages,
  getRecentMessages,
  markConversationRead,
  type MessagesErrorCode,
} from "@/services/messagesApi";
import {
  EMPTY_THREAD,
  canSeedFromHit,
  isConversationUnread,
  searchHitToPage,
  useMessageStore,
  type ThreadState,
} from "@/stores/messageStore";
import { applyMessagesError } from "@/utils/messagesErrors";
import type { Conversation, Message, MessageSearchHit } from "@/types/messages";

const RECENT_POLL_MS = 4_000;
/** A window not confirmed at the live tail for this long is reloaded. */
export const THREAD_SYNC_STALE_MS = 60_000;

/** Marker key for "nothing incoming in the window" in the auto mark-read. */
const NO_INCOMING_KEY = "";

/** Received from someone else and confirmed by the server. */
function isIncomingMessage(message: Message, viewerFid: number): boolean {
  return message.sender.fid !== viewerFid && !message.send_state;
}

/**
 * Whether the focused thread should POST /read now. `lastMarkedKey` is
 * undefined until the window first loads; `key` is the newest incoming
 * message id. Marks once per newest incoming message: a new arrival, or
 * unread state on first sight. Never re-marks the same message, so a
 * manual "mark unread" in the open thread sticks until something new comes.
 */
export function shouldAutoMarkRead({
  lastMarkedKey,
  key,
  hasUnread,
}: {
  lastMarkedKey: string | undefined;
  key: string;
  hasUnread: boolean;
}): boolean {
  if (lastMarkedKey === key) return false;
  if (lastMarkedKey === undefined) return hasUnread;
  return key !== NO_INCOMING_KEY;
}

/**
 * The oldest unread incoming message, above which the "New messages"
 * separator sits. Uses the viewer's `is_last_read` marker when it is in the
 * window, else counts back `unreadCount` incoming messages.
 */
export function findUnreadSeparatorId(
  messages: Message[],
  viewerFid: number,
  unreadCount: number,
): string | null {
  if (unreadCount <= 0) return null;
  const lastReadIndex = messages.findIndex((m) => m.is_last_read);
  if (lastReadIndex === 0) return null;
  const newer = lastReadIndex > 0 ? messages.slice(0, lastReadIndex) : messages;
  const incoming = newer.filter((m) => isIncomingMessage(m, viewerFid));
  if (incoming.length === 0) return null;
  if (lastReadIndex > 0) return incoming[incoming.length - 1].message_id;
  return incoming[Math.min(unreadCount, incoming.length) - 1].message_id;
}

/**
 * Whether a `/recent` poll result can be merged onto the loaded window, or
 * the window must be replaced by the latest page instead. Merging is only
 * safe when the window is known to reach the live tail: `/recent` shares a
 * message with it, and it was confirmed there recently. Otherwise (the app
 * was backgrounded, the thread left and reopened, or more arrived than one
 * `/recent` holds) merging would silently skip whatever lies between.
 */
export function shouldReloadLatest({
  thread,
  recent,
  now,
}: {
  thread: ThreadState | undefined;
  recent: Message[];
  now: number;
}): boolean {
  if (!thread?.isLoaded || thread.isDetached) return false;
  if (thread.syncedAt === null || now - thread.syncedAt > THREAD_SYNC_STALE_MS) {
    return true;
  }
  if (recent.length === 0) return false;
  const loadedIds = new Set(thread.messages.map((m) => m.message_id));
  return !recent.some((m) => loadedIds.has(m.message_id));
}

export interface UseConversationOptions {
  /** Real upstream id; null while composing to someone new. */
  conversationId: string | null;
  /** Store key: the conversation id, or a draft key before the first send. */
  threadKey: string;
  viewerFid: number;
  isEnabled: boolean;
  isFocused: boolean;
  /** Jump target from the route; a stashed search hit for it seeds page one. */
  anchorMessageId?: string | null;
}

export interface UseConversationResult {
  conversation: Conversation | null;
  thread: ThreadState;
  isLoading: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  errorCode: MessagesErrorCode | null;
  /** Frozen when the window first loads: where "New messages" goes. */
  unreadSeparatorId: string | null;
  reload: () => Promise<void>;
  loadOlder: () => Promise<void>;
  /** Page toward the live tail of a detached window. */
  loadNewer: () => Promise<void>;
  /**
   * Ensure `messageId` is in the window; resolves false if it can't be
   * found. A search `hit` (or one stashed by the search screen) seeds the
   * window directly; otherwise it is fetched by `anchor_message_id`.
   */
  ensureMessageLoaded: (messageId: string, hit?: MessageSearchHit | null) => Promise<boolean>;
  jumpToLatest: () => Promise<void>;
}

export function useConversation({
  conversationId,
  threadKey,
  viewerFid,
  isEnabled,
  isFocused,
  anchorMessageId = null,
}: UseConversationOptions): UseConversationResult {
  const conversation = useMessageStore((s) =>
    conversationId ? (s.conversations[conversationId] ?? null) : null,
  );
  const thread = useMessageStore((s) => s.threads[threadKey] ?? EMPTY_THREAD);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const [errorCode, setErrorCode] = useState<MessagesErrorCode | null>(null);
  const [unreadSeparatorId, setUnreadSeparatorId] = useState<string | null>(null);
  const isPollInFlightRef = useRef(false);
  const lastMarkedKeyRef = useRef<string | undefined>(undefined);
  const hasCapturedSeparatorRef = useRef(false);

  const canFetch = isEnabled && conversationId !== null;

  const reload = useCallback(async () => {
    if (!isEnabled || !conversationId) return;
    setIsLoading(true);
    try {
      const page = await getMessages(conversationId);
      useMessageStore.getState().setThreadPage(conversationId, page, "replace");
      setErrorCode(null);
    } catch (error) {
      setErrorCode(applyMessagesError(error));
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isEnabled]);

  // Metadata (header name, avatar, access) when not already in the store.
  useEffect(() => {
    if (!canFetch || !conversationId) return;
    if (useMessageStore.getState().conversations[conversationId]) return;
    const controller = new AbortController();
    getConversation(conversationId, { signal: controller.signal })
      .then((c) => useMessageStore.getState().upsertConversation(c))
      .catch((error: unknown) => {
        applyMessagesError(error);
      });
    return () => controller.abort();
  }, [canFetch, conversationId]);

  // First page. Arriving from search with a stashed, cursor-bearing hit
  // seeds the window from it instead of fetching the latest page.
  useEffect(() => {
    if (!canFetch || !conversationId) return;
    const store = useMessageStore.getState();
    if (store.threads[conversationId]?.isLoaded) return;
    const seed = anchorMessageId ? store.searchSeeds[anchorMessageId] : undefined;
    if (seed && canSeedFromHit(seed)) {
      store.takeSearchSeed(seed.message.message_id);
      store.setThreadPage(conversationId, searchHitToPage(seed), "anchor");
      return;
    }
    void reload();
  }, [anchorMessageId, canFetch, conversationId, reload]);

  // Recent-messages poll while focused and at the live tail; a detached
  // window pages forward with `loadNewer` instead. A window that can't be
  // shown to reach the tail is reloaded (pending and failed sends kept)
  // rather than merged across a hole.
  const isDetached = thread.isDetached;
  useEffect(() => {
    if (!canFetch || !isFocused || !conversationId || isDetached) return;
    const poll = async () => {
      if (isPollInFlightRef.current) return;
      isPollInFlightRef.current = true;
      try {
        const recent = await getRecentMessages(conversationId);
        const store = useMessageStore.getState();
        const isReloadNeeded = shouldReloadLatest({
          thread: store.threads[conversationId],
          recent: recent.items,
          now: Date.now(),
        });
        if (isReloadNeeded) {
          const latest = await getMessages(conversationId);
          useMessageStore.getState().setThreadPage(conversationId, latest, "replace");
          return;
        }
        store.mergeLatest(conversationId, recent.items);
        store.markThreadSynced(conversationId, Date.now());
      } catch (error) {
        applyMessagesError(error);
      } finally {
        isPollInFlightRef.current = false;
      }
    };
    // Returning to an already-loaded thread: check for a hole right away
    // instead of after the first interval.
    if (useMessageStore.getState().threads[conversationId]?.isLoaded) void poll();
    const timer = setInterval(() => void poll(), RECENT_POLL_MS);
    return () => clearInterval(timer);
  }, [canFetch, conversationId, isDetached, isFocused]);

  // Read state: mark read once per newest incoming message while focused.
  const newestIncomingId =
    thread.messages.find((m) => isIncomingMessage(m, viewerFid))?.message_id ??
    NO_INCOMING_KEY;
  const hasUnread = conversation !== null && isConversationUnread(conversation);
  const isWindowReady = thread.isLoaded && conversation !== null;

  // Freeze the unread separator before the mark-read below zeroes the count
  // (effects run in order, both reading this render's values).
  useEffect(() => {
    if (!isWindowReady || hasCapturedSeparatorRef.current || !conversation) return;
    hasCapturedSeparatorRef.current = true;
    setUnreadSeparatorId(
      findUnreadSeparatorId(thread.messages, viewerFid, conversation.unread_count),
    );
  }, [conversation, isWindowReady, thread.messages, viewerFid]);

  useEffect(() => {
    if (!canFetch || !isFocused || !conversationId || !isWindowReady) return;
    const isNeeded = shouldAutoMarkRead({
      lastMarkedKey: lastMarkedKeyRef.current,
      key: newestIncomingId,
      hasUnread,
    });
    lastMarkedKeyRef.current = newestIncomingId;
    if (!isNeeded) return;
    useMessageStore.getState().markReadLocal(conversationId);
    markConversationRead(conversationId).catch((error: unknown) => {
      applyMessagesError(error);
    });
  }, [canFetch, conversationId, hasUnread, isFocused, isWindowReady, newestIncomingId]);

  /** One page further from the loaded window, by that side's cursor. */
  const loadAdjacentPage = useCallback(
    async (direction: "older" | "newer", setIsBusy: (isBusy: boolean) => void) => {
      if (!canFetch || !conversationId) return;
      const current = useMessageStore.getState().threads[conversationId];
      const cursor = direction === "older" ? current?.olderCursor : current?.newerCursor;
      if (!cursor) return;
      setIsBusy(true);
      try {
        const page = await getMessages(conversationId, { cursor });
        useMessageStore.getState().setThreadPage(conversationId, page, direction);
      } catch (error) {
        applyMessagesError(error);
      } finally {
        setIsBusy(false);
      }
    },
    [canFetch, conversationId],
  );

  const loadOlder = useCallback(async () => {
    if (isLoadingOlder) return;
    await loadAdjacentPage("older", setIsLoadingOlder);
  }, [isLoadingOlder, loadAdjacentPage]);

  const loadNewer = useCallback(async () => {
    if (isLoadingNewer) return;
    await loadAdjacentPage("newer", setIsLoadingNewer);
  }, [isLoadingNewer, loadAdjacentPage]);

  const ensureMessageLoaded = useCallback(
    async (messageId: string, hit: MessageSearchHit | null = null) => {
      if (!canFetch || !conversationId) return false;
      const store = useMessageStore.getState();
      const isLoaded = (store.threads[conversationId]?.messages ?? []).some(
        (m) => m.message_id === messageId,
      );
      const seed = hit ?? store.takeSearchSeed(messageId);
      if (isLoaded) return true;
      if (seed && seed.message.message_id === messageId && canSeedFromHit(seed)) {
        store.setThreadPage(conversationId, searchHitToPage(seed), "anchor");
        return true;
      }
      try {
        const page = await getMessages(conversationId, {
          anchorMessageId: messageId,
        });
        if (!page.items.some((m) => m.message_id === messageId)) return false;
        useMessageStore.getState().setThreadPage(conversationId, page, "anchor");
        return true;
      } catch (error) {
        applyMessagesError(error);
        return false;
      }
    },
    [canFetch, conversationId],
  );

  return {
    conversation,
    thread,
    isLoading,
    isLoadingOlder,
    isLoadingNewer,
    errorCode,
    unreadSeparatorId,
    reload,
    loadOlder,
    loadNewer,
    ensureMessageLoaded,
    jumpToLatest: reload,
  };
}
