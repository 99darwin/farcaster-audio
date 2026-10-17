"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Conversation } from "@/lib/api/messages.types";
import { MESSAGES_INBOX_PATH, NEW_MESSAGE_PATH } from "@/lib/messages/deep-link";
import { useMessageStore, type InboxSegment } from "@/lib/stores/messageStore";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ConversationRow } from "./ConversationRow";
import { InboxSearchResults } from "./InboxSearchResults";
import { ChatBubbleIcon, CloseIcon, ComposeIcon, SearchGlyph } from "./icons";

const SEGMENTS: { id: InboxSegment; label: string }[] = [
  { id: "default", label: "Chats" },
  { id: "request", label: "Requests" },
];
/** Start fetching the next page this far before the end of the list. */
const LOAD_MORE_ROOT_MARGIN = "400px";
const NOTICE_MS = 3_000;
const SKELETON_ROW_COUNT = 6;

export interface InboxPaneProps {
  activeConversationId: string | null;
}

/**
 * Conversation list with Chats/Requests segments, global search and
 * keyboard navigation (ArrowUp/Down, Home/End between rows, `u` toggles read).
 *
 * The search query lives in component state only, never in the URL: message
 * search terms are private and must not land in history, the address bar or
 * a shared link. The pane sits in the Messages layout, so the query survives
 * moving between the inbox and a thread.
 */
export function InboxPane({ activeConversationId }: InboxPaneProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [segment, setSegment] = useState<InboxSegment>("default");
  const [query, setQuery] = useState("");
  /** Cmd/Ctrl+K from a full-screen thread: focus search once the inbox shows. */
  const [isSearchFocusPending, setIsSearchFocusPending] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  const viewerFid = useMessageStore((s) => s.viewer?.fid ?? null);
  const inbox = useMessageStore((s) => s.inbox[segment]);
  const conversations = useMessageStore((s) => s.conversations);
  const requestsCount = useMessageStore((s) => s.requestsCount);
  const hasUnreadRequests = useMessageStore((s) => s.hasUnreadRequests);
  const store = useMessageStore.getState;

  const isSearching = query.trim().length > 0;
  const isInboxRoute = pathname === MESSAGES_INBOX_PATH;

  useEffect(() => {
    if (!isSearchFocusPending || !isInboxRoute) return;
    setIsSearchFocusPending(false);
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [isSearchFocusPending, isInboxRoute]);

  useEffect(() => {
    if (store().inbox[segment].status === "idle") void store().loadInbox(segment);
  }, [segment, store]);

  // Requests count/dot come with any inbox page; load Chats first regardless.
  useEffect(() => {
    if (store().inbox.default.status === "idle") void store().loadInbox("default");
  }, [store]);

  // Cmd/Ctrl+K focuses the search field when the inbox is on screen.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      const input = searchRef.current;
      if (!input) return;
      event.preventDefault();
      // Single-pane layout with a thread open: go back to the inbox to search.
      if (input.offsetParent === null) {
        setIsSearchFocusPending(true);
        router.push(MESSAGES_INBOX_PATH);
        return;
      }
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  // Infinite scroll.
  const hasMore = inbox.hasMore && inbox.status === "ready";
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isSearching) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void store().loadMoreInbox(segment);
      },
      { rootMargin: LOAD_MORE_ROOT_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isSearching, segment, store]);

  const rows = inbox.ids.map((id) => conversations[id]).filter((c): c is Conversation => Boolean(c));
  const clampedFocus = Math.min(focusedIndex, Math.max(0, rows.length - 1));

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleToggleRead = useCallback(
    (conversation: Conversation) => {
      const isUnread = conversation.unread_count > 0 || conversation.manually_marked_unread;
      const action = isUnread ? store().markRead : store().markUnread;
      void action(conversation.conversation_id).catch(() => undefined);
    },
    [store],
  );

  const focusRow = (index: number) => {
    const links = listRef.current?.querySelectorAll<HTMLAnchorElement>("[data-inbox-row]");
    if (!links || links.length === 0) return;
    const next = Math.max(0, Math.min(index, links.length - 1));
    setFocusedIndex(next);
    links[next].focus();
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>("[data-inbox-row]") ?? [])];
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (current === -1) return;
    if (event.key === "ArrowDown") focusRow(current + 1);
    else if (event.key === "ArrowUp") {
      if (current === 0) searchRef.current?.focus();
      else focusRow(current - 1);
    } else if (event.key === "Home") focusRow(0);
    else if (event.key === "End") focusRow(links.length - 1);
    else if (event.key === "u" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const conversation = rows[current];
      if (conversation) handleToggleRead(conversation);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      setQuery("");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (isSearching) {
        document.querySelector<HTMLAnchorElement>("[data-search-result]")?.focus();
      } else {
        focusRow(clampedFocus);
      }
    }
  };

  const now = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
        <h1 className="text-xl font-bold text-juke-text-on-dark">Messages</h1>
        <Link
          href={NEW_MESSAGE_PATH}
          aria-label="New message"
          title="New message"
          className="flex h-10 w-10 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-juke-surface hover:text-juke-orange"
        >
          <ComposeIcon className="h-5 w-5" />
        </Link>
      </header>

      <div className="px-4 pb-2">
        <div className="relative">
          <SearchGlyph className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-juke-text-on-dark-tertiary" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search messages"
            aria-label="Search messages"
            aria-keyshortcuts="Control+K Meta+K"
            className="h-10 w-full rounded-full border border-juke-border bg-juke-surface pl-9 pr-9 text-sm text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-juke-text-on-dark-tertiary hover:text-juke-text-on-dark"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {isSearching ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <InboxSearchResults query={query} onNavigate={() => undefined} />
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Inbox" className="flex shrink-0 gap-1 border-b border-juke-border px-2">
            {SEGMENTS.map((item) => {
              const isSelected = segment === item.id;
              const showDot = item.id === "request" && hasUnreadRequests;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`inbox-tab-${item.id}`}
                  aria-selected={isSelected}
                  aria-controls="inbox-panel"
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => {
                    setSegment(item.id);
                    setFocusedIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const next = SEGMENTS[(SEGMENTS.indexOf(item) + 1) % SEGMENTS.length];
                    setSegment(next.id);
                    document.getElementById(`inbox-tab-${next.id}`)?.focus();
                  }}
                  className={cn(
                    "relative flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold transition-colors",
                    isSelected ? "text-juke-text-on-dark" : "text-juke-text-on-dark-secondary hover:text-juke-text-on-dark",
                  )}
                >
                  {item.label}
                  {item.id === "request" && requestsCount > 0 && (
                    <span className="text-xs tabular-nums text-juke-text-on-dark-tertiary">{requestsCount}</span>
                  )}
                  {showDot && (
                    <span className="h-2 w-2 rounded-full bg-juke-purple">
                      <span className="sr-only">, unread requests</span>
                    </span>
                  )}
                  {isSelected && (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-juke-orange" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>

          <div
            id="inbox-panel"
            role="tabpanel"
            aria-labelledby={`inbox-tab-${segment}`}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {segment === "request" && rows.length > 0 && (
              <p className="px-4 pb-1 pt-3 text-xs text-juke-text-on-dark-tertiary">
                Message requests come from people you don&apos;t follow.
              </p>
            )}
            {inbox.status === "loading" && rows.length === 0 ? (
              <InboxSkeleton />
            ) : inbox.status === "error" && rows.length === 0 ? (
              <EmptyState
                title="Couldn't load your messages"
                description={inbox.error ?? undefined}
                action={
                  <Button variant="secondary" onClick={() => void store().loadInbox(segment)}>
                    Try again
                  </Button>
                }
              />
            ) : rows.length === 0 && inbox.status === "ready" ? (
              <EmptyState
                icon={<ChatBubbleIcon className="h-8 w-8" />}
                title={segment === "request" ? "No message requests" : "No conversations yet"}
                description={
                  segment === "request"
                    ? "Messages from people you don't follow land here."
                    : "Direct Casts you send and receive on Farcaster show up here."
                }
                action={
                  segment === "default" ? (
                    <Link
                      href={NEW_MESSAGE_PATH}
                      className="rounded-full bg-juke-orange px-4 py-2 text-sm font-semibold text-white hover:bg-juke-orange-hover"
                    >
                      Start a conversation
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <ul ref={listRef} onKeyDown={handleListKeyDown} aria-label="Conversations">
                {rows.map((conversation, index) => (
                  <li key={conversation.conversation_id}>
                    <ConversationRow
                      conversation={conversation}
                      viewerFid={viewerFid}
                      isActive={conversation.conversation_id === activeConversationId}
                      now={now}
                      tabIndex={index === clampedFocus ? 0 : -1}
                      onToggleRead={handleToggleRead}
                      onRequestError={segment === "request" ? setNotice : undefined}
                    />
                  </li>
                ))}
                {hasMore && (
                  <li ref={sentinelRef} className="flex justify-center py-4" aria-hidden={!inbox.loadingMore}>
                    {inbox.loadingMore && <Spinner size="sm" label="Loading more conversations" />}
                  </li>
                )}
              </ul>
            )}
            {notice && (
              <p role="alert" className="px-4 py-3 text-center text-xs text-red-300">
                {notice}
              </p>
            )}
            {inbox.error && rows.length > 0 && (
              <p role="alert" className="px-4 py-3 text-center text-xs text-juke-text-on-dark-secondary">
                {inbox.error}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Placeholder rows while the first inbox page loads. */
function InboxSkeleton() {
  return (
    <ul role="status" aria-label="Loading conversations" className="flex flex-col">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <li key={index} className="flex items-center gap-3 px-4 py-3">
          <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-juke-surface motion-reduce:animate-none" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="h-3.5 w-1/3 animate-pulse rounded-full bg-juke-surface motion-reduce:animate-none" />
            <span className="h-3 w-2/3 animate-pulse rounded-full bg-juke-surface/70 motion-reduce:animate-none" />
          </span>
        </li>
      ))}
    </ul>
  );
}
