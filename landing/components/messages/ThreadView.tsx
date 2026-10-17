"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Message, MessageUser } from "@/lib/api/messages.types";
import { messagingErrorCopy } from "@/lib/api/messages";
import {
  conversationAvatar,
  conversationTitle,
  formatBadgeCount,
  profileHref,
  systemMessageText,
  userLabel,
} from "@/lib/messages/format";
import { MESSAGES_INBOX_PATH } from "@/lib/messages/deep-link";
import { queryTerms } from "@/lib/messages/highlight";
import { countIncomingAfter } from "@/lib/messages/message-list";
import { placeReadReceipt } from "@/lib/messages/receipts";
import { threadScrollMemory, type ScrollSnapshot } from "@/lib/messages/scroll-memory";
import { buildThreadRows, messageRowKey, UNREAD_ROW_KEY, type ThreadRow } from "@/lib/messages/thread-rows";
import { MAX_UNREAD_DIVIDER_PAGES, resolveUnreadDivider } from "@/lib/messages/unread-divider";
import { draftConversationKey, useMessageStore, type ThreadState } from "@/lib/stores/messageStore";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Composer, type ComposerHandle, type ComposerSubmit } from "./Composer";
import { MessageBubble, type MessageBubbleActions } from "./MessageBubble";
import { MessageList, type MessageListHandle, type ScrollRequest } from "./MessageList";
import { ReactorsPopover } from "./ReactorsPopover";
import { RequestActions } from "./RequestActions";
import { ThreadSearchBar, useThreadSearch, type ThreadSearchMatch } from "./ThreadSearchBar";
import { BackIcon, ChevronDownIcon, EnvelopeOpenIcon, SearchGlyph } from "./icons";
import { COARSE_POINTER_QUERY, TWO_PANE_QUERY, usePageVisible, useMediaQuery } from "./useMediaQuery";

/** `recent` poll while the conversation is focused and the socket is down. */
const THREAD_POLL_MS = 4_000;
/** Safety-net poll while the socket is connected. */
const THREAD_POLL_CONNECTED_MS = 25_000;
/** Jump-to-message highlight flash (design doc section 6). */
const FLASH_MS = 1_200;
const TOAST_MS = 2_500;
/** Characters of a new message read out by the screen-reader announcement. */
const ANNOUNCEMENT_PREVIEW_CHARS = 140;

const EMPTY_THREAD: ThreadState = {
  messages: [],
  olderCursor: null,
  hasOlder: false,
  newerCursor: null,
  hasNewer: false,
  status: "idle",
  loadingOlder: false,
  loadingNewer: false,
  error: null,
  isNotFound: false,
  newerWhileDetached: 0,
};

/** True when a key event comes from a text field (shortcuts must not fire). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
}

export interface ThreadViewProps {
  /** Null for a first message to `draftPeer` (no conversation exists yet). */
  conversationId: string | null;
  draftPeer?: MessageUser | null;
  /** Jump to and highlight this message once loaded (`?m=` deep link). */
  initialMessageId?: string | null;
  /** Called when the first message of a draft creates the conversation. */
  onConversationCreated?: (conversationId: string) => void;
}

export function ThreadView({
  conversationId,
  draftPeer = null,
  initialMessageId = null,
  onConversationCreated,
}: ThreadViewProps) {
  const conversationKey = conversationId ?? (draftPeer ? draftConversationKey(draftPeer.fid) : "");
  const isDraft = conversationId === null;

  const viewer = useMessageStore((s) => s.viewer);
  const conversation = useMessageStore((s) => (conversationId ? s.conversations[conversationId] : undefined));
  const thread = useMessageStore((s) => s.threads[conversationKey]) ?? EMPTY_THREAD;
  const replyTo = useMessageStore((s) => s.replyTargets[conversationKey] ?? null);
  const draft = useMessageStore((s) => s.drafts[conversationKey] ?? "");
  const sendErrors = useMessageStore((s) => s.sendErrors);
  const realtimeConnected = useMessageStore((s) => s.realtimeConnected);
  const availability = useMessageStore((s) => s.availability);
  const isMissing = useMessageStore((s) => (conversationId ? Boolean(s.missingConversations[conversationId]) : false));
  const store = useMessageStore.getState;
  const router = useRouter();

  const isCoarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  const isTwoPane = useMediaQuery(TWO_PANE_QUERY);
  const shouldReduceMotion = useReducedMotion() ?? false;
  const isVisible = usePageVisible();
  const viewerFid = viewer?.fid ?? null;

  const listRef = useRef<MessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  const nonceRef = useRef(0);
  const requestScroll = useCallback((rowKey: string | null, align: ScrollRequest["align"] = "center") => {
    nonceRef.current += 1;
    setScrollRequest({ rowKey, nonce: nonceRef.current, align });
  }, []);

  const [flashId, setFlashId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [reactorsFor, setReactorsFor] = useState<{ message: Message; reaction: string | null } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(-1);

  const showToast = useCallback((text: string) => setToast(text), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  // --- lifecycle: focus bookkeeping, initial load, polling -----------------

  useEffect(() => {
    if (!conversationId) return;
    store().setFocusedConversation(conversationId);
    void store().ensureConversation(conversationId);
    const existing = store().threads[conversationId];
    // A window seeded from a search hit already holds the deep-linked message;
    // keep it (its cursors page outward) instead of replacing it with the latest page.
    const holdsLinkedMessage =
      Boolean(initialMessageId) && Boolean(existing?.messages.some((m) => m.message_id === initialMessageId));
    const isUsable = existing && existing.status !== "idle" && existing.status !== "error";
    if (!isUsable || (existing.hasNewer && !holdsLinkedMessage)) {
      void store().loadLatest(conversationId);
    } else {
      void store().pollRecent(conversationId);
    }
    return () => {
      if (store().focusedConversationId === conversationId) store().setFocusedConversation(null);
    };
    // initialMessageId is read once on open; later `?m=` changes jump in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, store]);

  // Bring back an unsent draft saved for this viewer + conversation.
  useEffect(() => {
    if (viewerFid !== null) store().restoreDraft(conversationKey);
  }, [conversationKey, viewerFid, store]);

  useEffect(() => {
    if (!conversationId || !isVisible) return;
    const interval = realtimeConnected ? THREAD_POLL_CONNECTED_MS : THREAD_POLL_MS;
    const timer = setInterval(() => void store().pollRecent(conversationId), interval);
    return () => clearInterval(timer);
  }, [conversationId, isVisible, realtimeConnected, store]);

  // --- rows ----------------------------------------------------------------

  const [unreadAfterId, setUnreadAfterId] = useState<string | null>(null);
  const hasCapturedUnreadRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  // Read state as of opening: auto-read zeroes `unread_count` while older
  // pages are still loading for the divider.
  const unreadOnOpenRef = useRef<{ unreadCount: number; lastReadAt: number } | null>(null);
  if (!unreadOnOpenRef.current && conversation && thread.status === "ready") {
    unreadOnOpenRef.current = { unreadCount: conversation.unread_count, lastReadAt: conversation.last_read_at };
  }
  /**
   * Older pages requested to reach the divider (bounded by
   * MAX_UNREAD_DIVIDER_PAGES). Counted when a load starts, so the effect
   * re-running on the page's own state changes can't overshoot the bound.
   */
  const dividerPagesRef = useRef(0);

  useEffect(() => {
    if (hasCapturedUnreadRef.current || thread.status !== "ready" || thread.loadingOlder) return;
    const onOpen = unreadOnOpenRef.current;
    if (!conversationId || !onOpen) return;
    // A deep link opens elsewhere, so don't page history just for the divider;
    // a failed older page stops the search (the fallback is last_read_at).
    const isPagingDone = Boolean(initialMessageId) || (dividerPagesRef.current > 0 && Boolean(thread.error));
    const resolution = resolveUnreadDivider({
      messages: thread.messages,
      unreadCount: onOpen.unreadCount,
      viewerFid,
      lastReadAt: onOpen.lastReadAt,
      hasOlder: thread.hasOlder,
      pagesLoaded: isPagingDone ? MAX_UNREAD_DIVIDER_PAGES : dividerPagesRef.current,
    });
    if (resolution.kind === "load_older") {
      dividerPagesRef.current += 1;
      // `loadingOlder` flips back when the page lands (or fails), re-running this.
      void store().loadOlder(conversationId);
      return;
    }
    hasCapturedUnreadRef.current = true;
    setUnreadAfterId(resolution.afterId);
  }, [
    conversationId,
    thread.status,
    thread.loadingOlder,
    thread.messages,
    thread.hasOlder,
    thread.error,
    viewerFid,
    initialMessageId,
    conversation,
    store,
  ]);

  const now = Date.now();
  const rows = useMemo(
    () => buildThreadRows(thread.messages, { viewerFid, unreadAfterId, now }),
    // `now` only matters at day granularity; recompute with the messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread.messages, viewerFid, unreadAfterId],
  );

  // --- jump to message -------------------------------------------------------

  const jumpToMessage = useCallback(
    async (messageId: string, { flash = true, match }: { flash?: boolean; match?: ThreadSearchMatch } = {}) => {
      if (!conversationId) return;
      // A server search hit carries its own window: seed it instead of an anchor fetch.
      if (match?.hit) store().seedFromSearchHit(match.hit);
      const ok = await store().jumpToMessage(conversationId, messageId);
      if (!ok) {
        showToast("That message isn't available anymore");
        return;
      }
      requestScroll(messageRowKey(messageId));
      if (flash) setFlashId(messageId);
    },
    [conversationId, requestScroll, showToast, store],
  );

  // Initial scroll: deep-linked message, else the unread divider, else bottom.
  useEffect(() => {
    if (initialScrollDoneRef.current || thread.status !== "ready") return;
    if (!isDraft && !hasCapturedUnreadRef.current) return;
    initialScrollDoneRef.current = true;
    if (initialMessageId) {
      void jumpToMessage(initialMessageId);
    } else if (unreadAfterId) {
      requestScroll(UNREAD_ROW_KEY, "start");
    }
  }, [thread.status, isDraft, initialMessageId, unreadAfterId, jumpToMessage, requestScroll]);

  // A new `?m=` for the conversation that is already open (e.g. picked from
  // global search in the inbox pane).
  const lastDeepLinkRef = useRef(initialMessageId);
  useEffect(() => {
    if (!initialMessageId || initialMessageId === lastDeepLinkRef.current) return;
    lastDeepLinkRef.current = initialMessageId;
    if (initialScrollDoneRef.current) void jumpToMessage(initialMessageId);
  }, [initialMessageId, jumpToMessage]);

  // --- read state + new-message counter -----------------------------------

  const lastSeenIdRef = useRef<string | null>(null);
  const newestId = thread.messages.at(-1)?.message_id ?? null;
  if (isAtBottom && !thread.hasNewer) lastSeenIdRef.current = newestId;
  const newBelowCount = thread.hasNewer
    ? thread.newerWhileDetached
    : isAtBottom
      ? 0
      : countIncomingAfter(thread.messages, lastSeenIdRef.current, viewerFid);

  const hasUnread = Boolean(conversation && (conversation.unread_count > 0 || conversation.manually_marked_unread));
  // Set by "Mark as unread" so the auto-read below doesn't undo it while the
  // thread is still mounted: narrow layouts navigate back to the inbox, but the
  // two-pane layout keeps the thread open beside it. Sending releases it.
  const suppressAutoReadRef = useRef(false);
  useEffect(() => {
    if (!conversationId || !hasUnread || !isVisible || !isAtBottom) return;
    if (thread.status !== "ready" || thread.hasNewer || suppressAutoReadRef.current) return;
    void store().markRead(conversationId);
  }, [conversationId, hasUnread, isVisible, isAtBottom, thread.status, thread.hasNewer, newestId, store]);

  const handleMarkUnread = useCallback(() => {
    if (!conversationId) return;
    suppressAutoReadRef.current = true;
    store()
      .markUnread(conversationId)
      .then(() => {
        // Two-pane: the inbox row is right there showing the unread state.
        if (isTwoPane) showToast("Marked as unread");
        else router.push(MESSAGES_INBOX_PATH);
      })
      .catch((error: unknown) => {
        suppressAutoReadRef.current = false;
        showToast(messagingErrorCopy(error, "Couldn't mark as unread"));
      });
  }, [conversationId, isTwoPane, router, showToast, store]);

  // Screen-reader announcement for incoming messages.
  const announcedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const newest = thread.messages.at(-1);
    if (!newest) return;
    if (announcedIdRef.current === null) {
      announcedIdRef.current = newest.message_id;
      return;
    }
    if (announcedIdRef.current === newest.message_id) return;
    announcedIdRef.current = newest.message_id;
    if (newest.sender.fid !== viewerFid && newest.type === "text") {
      setAnnouncement(`New message from ${userLabel(newest.sender)}: ${newest.text.slice(0, ANNOUNCEMENT_PREVIEW_CHARS)}`);
    }
  }, [thread.messages, viewerFid]);

  const scrollToLatest = useCallback(async () => {
    if (thread.hasNewer && conversationId) await store().loadLatest(conversationId);
    requestScroll(null);
  }, [thread.hasNewer, conversationId, requestScroll, store]);

  const handleLoadOlder = useCallback(() => {
    if (conversationId) void store().loadOlder(conversationId);
  }, [conversationId, store]);
  const handleLoadNewer = useCallback(() => {
    if (conversationId) void store().loadNewer(conversationId);
  }, [conversationId, store]);

  // --- scroll restore ------------------------------------------------------

  // Read once per mount (the component is keyed by conversation). Only an
  // anchor that is still loaded is usable; otherwise open at the bottom.
  const [initialSnapshot] = useState<ScrollSnapshot | null>(() => {
    if (!conversationId || initialMessageId) return null;
    const saved = threadScrollMemory.recall(conversationId);
    if (saved?.kind !== "anchor") return null;
    const loaded = store().threads[conversationId]?.messages ?? [];
    return loaded.some((m) => messageRowKey(m.message_id) === saved.anchor.key) ? saved : null;
  });
  const handleSnapshot = useCallback(
    (snapshot: ScrollSnapshot) => {
      if (conversationId) threadScrollMemory.save(conversationId, snapshot);
    },
    [conversationId],
  );

  // --- in-thread search ----------------------------------------------------

  const { matches, isSearching } = useThreadSearch(
    conversationId ?? "",
    thread.messages,
    isSearchOpen ? searchQuery : "",
  );
  const searchTerms = useMemo(
    () => (isSearchOpen ? queryTerms(searchQuery) : []),
    [isSearchOpen, searchQuery],
  );

  useEffect(() => {
    setSearchIndex(-1);
  }, [searchQuery]);

  // Land on the newest match as soon as there is one.
  useEffect(() => {
    if (searchIndex === -1 && matches.length > 0) {
      setSearchIndex(0);
      void jumpToMessage(matches[0].messageId, { match: matches[0] });
    }
  }, [matches, searchIndex, jumpToMessage]);

  const stepSearch = useCallback(
    (step: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (Math.max(0, searchIndex) + step + matches.length) % matches.length;
      setSearchIndex(next);
      void jumpToMessage(matches[next].messageId, { match: matches[next] });
    },
    [matches, searchIndex, jumpToMessage],
  );

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
    composerRef.current?.focus();
  }, []);

  // Cmd/Ctrl+F opens in-thread search instead of the browser's find bar.
  useEffect(() => {
    if (isDraft) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      setIsSearchOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDraft]);

  /** Focus the viewer's newest sent message (so "r" replies to it); else the newest message. */
  const focusLastOwnMessage = useCallback(() => {
    const messages = store().threads[conversationKey]?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.sender.fid === viewerFid && !message.is_deleted && !message.send_state) {
        listRef.current?.focusRow(messageRowKey(message.message_id));
        return;
      }
    }
    listRef.current?.focusLastMessage();
  }, [conversationKey, viewerFid, store]);

  // Escape closes search, then cancels the reply (inputs handle their own
  // Escape first and stop it). ArrowUp from the list background focuses the
  // viewer's last message, where "r" replies.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === "Escape") {
        if (isSearchOpen) {
          event.preventDefault();
          closeSearch();
        } else if (store().replyTargets[conversationKey]) {
          event.preventDefault();
          store().setReplyTarget(conversationKey, null);
        }
        return;
      }
      if (event.key === "ArrowUp" && !isTypingTarget(event.target) && event.target === document.body) {
        event.preventDefault();
        focusLastOwnMessage();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSearchOpen, closeSearch, conversationKey, focusLastOwnMessage, store]);

  // --- actions -------------------------------------------------------------

  const canWrite = isDraft || conversation?.access !== "read";

  const handleSubmit = useCallback(
    async ({ text, processMetadata }: ComposerSubmit) => {
      // Replying means the viewer is reading again: let auto-read resume.
      suppressAutoReadRef.current = false;
      requestScroll(null);
      const result = await store().sendMessage({
        conversationId,
        recipientFid: draftPeer?.fid ?? null,
        text,
        replyTo,
        processMetadata,
      });
      if (!result.ok) {
        if (store().availability === "token_required") return;
        // Upstream refused it: retrying unchanged won't help, so say why.
        const reason = store().sendErrors[result.messageId];
        showToast(reason ? `Message not sent: ${reason}` : "Message not sent. Tap Retry to try again.");
        return;
      }
      if (isDraft && result.conversationId) onConversationCreated?.(result.conversationId);
    },
    [conversationId, draftPeer, replyTo, isDraft, onConversationCreated, requestScroll, showToast, store],
  );

  const latest = useRef({ conversationKey, conversationId, showToast });
  latest.current = { conversationKey, conversationId, showToast };

  const actions = useMemo<MessageBubbleActions>(
    () => ({
      onReply: (message) => {
        store().setReplyTarget(latest.current.conversationKey, message);
        composerRef.current?.focus();
      },
      onToggleReaction: (message, reaction) => {
        const id = latest.current.conversationId;
        if (!id) return;
        store()
          .toggleReaction(id, message.message_id, reaction)
          .catch((error: unknown) =>
            latest.current.showToast(messagingErrorCopy(error, "Couldn't update your reaction")),
          );
      },
      onOpenReactors: (message, reaction) => setReactorsFor({ message, reaction }),
      onJumpToMessage: (messageId) => void jumpToMessage(messageId),
      onRetry: (message) => {
        void store()
          .retrySend(latest.current.conversationKey, message.message_id)
          .then((result) => {
            if (result.ok && !latest.current.conversationId && result.conversationId) {
              onConversationCreated?.(result.conversationId);
            }
          });
      },
      onDiscard: (message) => store().discardFailed(latest.current.conversationKey, message.message_id),
      onDelete: (message) => {
        const id = latest.current.conversationId;
        if (!id) return;
        store()
          .deleteMessage(id, message.message_id)
          .catch((error: unknown) =>
            latest.current.showToast(messagingErrorCopy(error, "Couldn't delete that message")),
          );
      },
      onCopy: (message) => {
        void navigator.clipboard
          ?.writeText(message.text)
          .then(() => latest.current.showToast("Copied"))
          .catch(() => latest.current.showToast("Couldn't copy"));
      },
    }),
    [jumpToMessage, onConversationCreated, store],
  );

  const isGroup = conversation?.is_group ?? false;
  const receipt = useMemo(
    () => (isGroup ? null : placeReadReceipt(thread.messages, viewerFid, conversation?.peer_last_read_at)),
    [isGroup, thread.messages, viewerFid, conversation?.peer_last_read_at],
  );
  const currentMatchId = searchIndex >= 0 ? matches[searchIndex]?.messageId ?? null : null;

  const renderRow = useCallback(
    (row: ThreadRow, { tabIndex }: { tabIndex: 0 | -1 }) => {
      switch (row.kind) {
        case "day":
          return (
            <div className="flex justify-center py-3" role="separator" aria-label={row.label}>
              <span className="rounded-full bg-juke-surface/80 px-3 py-1 text-xs font-semibold text-juke-text-on-dark-secondary">
                {row.label}
              </span>
            </div>
          );
        case "unread":
          return (
            <div className="flex items-center gap-3 px-4 py-3" role="separator" aria-label="New messages">
              <span className="h-px flex-1 bg-juke-orange/50" />
              <span className="text-xs font-semibold uppercase tracking-wide text-juke-orange">New messages</span>
              <span className="h-px flex-1 bg-juke-orange/50" />
            </div>
          );
        case "system":
          return (
            <p className="px-6 py-2 text-center text-xs text-juke-text-on-dark-tertiary">
              {systemMessageText(row.message)}
            </p>
          );
        case "message":
          return (
            <MessageBubble
              message={row.message}
              isOwn={row.isOwn}
              isFirstInGroup={row.isFirstInGroup}
              isLastInGroup={row.isLastInGroup}
              isGroup={isGroup}
              canWrite={canWrite}
              isCoarsePointer={isCoarsePointer}
              tabIndex={tabIndex}
              highlightTerms={searchTerms.length ? searchTerms : undefined}
              isFlashing={flashId === row.message.message_id || currentMatchId === row.message.message_id}
              readReceipt={receipt?.messageId === row.message.message_id ? receipt.receipt : null}
              sendError={sendErrors[row.message.message_id] ?? null}
              actions={actions}
            />
          );
      }
    },
    [isGroup, canWrite, isCoarsePointer, searchTerms, flashId, currentMatchId, receipt, sendErrors, actions],
  );

  // --- header --------------------------------------------------------------

  const peer =
    conversation?.counterparty ??
    conversation?.participants.find((p) => p.fid !== viewerFid) ??
    draftPeer ??
    null;
  const title = conversation ? conversationTitle(conversation, viewerFid) : peer ? userLabel(peer) : "Conversation";
  const avatar = conversation ? conversationAvatar(conversation, viewerFid) : { src: peer?.pfp_url ?? null, name: title };
  const subtitle = conversation?.is_group
    ? `${conversation.participants.length} members`
    : peer?.username
      ? `@${peer.username}`
      : null;
  const titleHref = !isGroup && peer ? profileHref(peer) : null;

  const disabledReason =
    availability === "token_required"
      ? "Enable messages to send Direct Casts."
      : !canWrite
        ? "You can read this conversation but can't send messages to it."
        : null;

  const isInitialLoading = !isDraft && thread.messages.length === 0 && (thread.status === "loading" || thread.status === "idle");

  return (
    <section
      aria-label={`Conversation with ${title}`}
      className="relative flex h-full min-h-0 w-full flex-col bg-juke-navy"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-juke-border px-2 md:px-3">
        <Link
          href={MESSAGES_INBOX_PATH}
          aria-label="Back to conversations"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-juke-surface hover:text-juke-text-on-dark lg:hidden"
        >
          <BackIcon className="h-5 w-5" />
        </Link>
        {titleHref ? (
          <Link href={titleHref} className="flex min-w-0 flex-1 items-center gap-3 rounded-full py-1 pr-2">
            <Avatar src={avatar.src} name={avatar.name} size="sm" />
            <HeaderTitle title={title} subtitle={subtitle} />
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3 py-1">
            <Avatar src={avatar.src} name={avatar.name} size="sm" />
            <HeaderTitle title={title} subtitle={subtitle} />
          </div>
        )}
        {!isDraft && (
          <>
            <button
              type="button"
              onClick={handleMarkUnread}
              aria-label="Mark as unread"
              title="Mark as unread"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-juke-surface hover:text-juke-text-on-dark"
            >
              <EnvelopeOpenIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setIsSearchOpen((open) => !open)}
              aria-label="Search in conversation"
              aria-expanded={isSearchOpen}
              aria-keyshortcuts="Control+F Meta+F"
              title="Search (Ctrl/⌘ F)"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-juke-surface",
                isSearchOpen ? "text-juke-orange" : "text-juke-text-on-dark-secondary hover:text-juke-text-on-dark",
              )}
            >
              <SearchGlyph className="h-5 w-5" />
            </button>
          </>
        )}
      </header>

      {isSearchOpen && (
        <ThreadSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          matchCount={matches.length}
          currentIndex={searchIndex}
          isSearching={isSearching}
          onNext={() => stepSearch(1)}
          onPrevious={() => stepSearch(-1)}
          onClose={closeSearch}
        />
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {(thread.isNotFound || isMissing) && thread.messages.length === 0 ? (
          <EmptyState
            className="flex-1"
            title="Conversation not found"
            description="It may have been deleted, or you're no longer a member."
            action={
              <Button variant="secondary" onClick={() => router.push(MESSAGES_INBOX_PATH)}>
                Back to messages
              </Button>
            }
          />
        ) : isInitialLoading ? (
          <ThreadSkeleton />
        ) : thread.status === "error" && thread.messages.length === 0 ? (
          <EmptyState
            className="flex-1"
            title="Couldn't load this conversation"
            description={thread.error ?? undefined}
            action={
              <Button variant="secondary" onClick={() => conversationId && void store().loadLatest(conversationId)}>
                Try again
              </Button>
            }
          />
        ) : isDraft && thread.messages.length === 0 ? (
          <EmptyState
            className="flex-1"
            title={peer ? `Start a conversation with ${userLabel(peer)}` : "New message"}
            description="Messages are Farcaster Direct Casts, visible in any Farcaster client."
          />
        ) : (
          <MessageList
            ref={listRef}
            rows={rows}
            renderRow={renderRow}
            hasOlder={!isDraft && thread.hasOlder}
            loadingOlder={thread.loadingOlder}
            onLoadOlder={handleLoadOlder}
            hasNewer={!isDraft && thread.hasNewer}
            loadingNewer={thread.loadingNewer}
            onLoadNewer={handleLoadNewer}
            initialSnapshot={initialSnapshot}
            onSnapshot={handleSnapshot}
            onAtBottomChange={setIsAtBottom}
            scrollRequest={scrollRequest}
          />
        )}

        <AnimatePresence>
          {(!isAtBottom || thread.hasNewer) && thread.messages.length > 0 && (
            <motion.button
              type="button"
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.12 }}
              onClick={() => void scrollToLatest()}
              aria-label={newBelowCount > 0 ? `Scroll to latest, ${newBelowCount} new` : "Scroll to latest"}
              className="absolute bottom-4 right-4 flex h-11 w-11 items-center justify-center rounded-full border border-juke-border bg-juke-surface text-juke-text-on-dark shadow-xl transition-colors hover:bg-juke-border"
            >
              <ChevronDownIcon className="h-5 w-5" />
              {newBelowCount > 0 && (
                <span className="absolute -top-1.5 left-1/2 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center rounded-full bg-juke-orange px-1 text-[11px] font-bold text-white">
                  {formatBadgeCount(newBelowCount)}
                </span>
              )}
            </motion.button>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {toast && (
            <motion.p
              role="status"
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-juke-surface px-4 py-2 text-sm text-juke-text-on-dark shadow-xl"
            >
              {toast}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {conversationId && conversation?.category === "request" && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-juke-border px-4 py-2.5">
          <p className="text-xs text-juke-text-on-dark-secondary">
            Message request. Accept to move it to Chats.
          </p>
          <RequestActions
            conversationId={conversationId}
            title={title}
            onError={showToast}
            onDecided={(decision) => {
              if (decision === "decline") router.push(MESSAGES_INBOX_PATH);
            }}
          />
        </div>
      )}

      <Composer
        ref={composerRef}
        draft={draft}
        onDraftChange={(text) => store().setDraft(conversationKey, text)}
        replyTo={replyTo}
        onCancelReply={() => store().setReplyTarget(conversationKey, null)}
        onSubmit={(input) => void handleSubmit(input)}
        onFocusLastMessage={focusLastOwnMessage}
        disabledReason={disabledReason}
        placeholder={isDraft && peer ? `Message ${userLabel(peer)}` : "Message"}
        autoFocus={!isCoarsePointer}
      />

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <ReactorsPopover
        message={reactorsFor?.message ?? null}
        initialReaction={reactorsFor?.reaction ?? null}
        onClose={() => setReactorsFor(null)}
      />
    </section>
  );
}

function HeaderTitle({ title, subtitle }: { title: string; subtitle: string | null }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-[15px] font-bold leading-tight text-juke-text-on-dark">{title}</span>
      {subtitle && (
        <span className="block truncate text-xs leading-tight text-juke-text-on-dark-tertiary">{subtitle}</span>
      )}
    </span>
  );
}

/** Placeholder bubbles while the first page loads. */
const SKELETON_ROWS: ReadonlyArray<{ isOwn: boolean; width: string }> = [
  { isOwn: false, width: "w-48" },
  { isOwn: false, width: "w-64" },
  { isOwn: true, width: "w-40" },
  { isOwn: false, width: "w-56" },
  { isOwn: true, width: "w-72" },
  { isOwn: true, width: "w-32" },
];

function ThreadSkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" className="flex flex-1 flex-col justify-end gap-2 px-4 pb-4">
      {SKELETON_ROWS.map((row, index) => (
        <div key={index} className={cn("flex", row.isOwn ? "justify-end" : "justify-start")}>
          <div
            className={cn(
              "h-9 max-w-[75%] animate-pulse rounded-2xl motion-reduce:animate-none",
              row.width,
              row.isOwn ? "bg-juke-orange/25" : "bg-juke-surface",
            )}
          />
        </div>
      ))}
    </div>
  );
}
