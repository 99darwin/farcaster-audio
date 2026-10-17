"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { searchMessages } from "@/lib/api/messages";
import type { Message, MessageSearchHit } from "@/lib/api/messages.types";
import { matchesQuery } from "@/lib/messages/highlight";
import { collectThreadSearchHits, shouldSearchRemotely } from "@/lib/messages/thread-search";
import { Spinner } from "@/components/ui/spinner";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchGlyph } from "./icons";

const SEARCH_DEBOUNCE_MS = 250;

export interface ThreadSearchMatch {
  messageId: string;
  sentAt: number;
  /** Server hit with jump-seed cursors; absent for loaded-only matches. */
  hit?: MessageSearchHit;
}

/**
 * In-thread search: loaded messages are matched locally right away, then
 * `GET /search?conversation_id=` pages server-side matches in this
 * conversation (design doc 4.5): from 3 characters, at most
 * `MAX_THREAD_SEARCH_PAGES` pages. Newest match first.
 */
export function useThreadSearch(
  conversationId: string,
  loadedMessages: readonly Message[],
  query: string,
): { matches: ThreadSearchMatch[]; isSearching: boolean } {
  const [remote, setRemote] = useState<MessageSearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const trimmed = query.trim();

  useEffect(() => {
    setRemote([]);
    if (!conversationId || !shouldSearchRemotely(trimmed)) {
      setIsSearching(false);
      return;
    }
    const controller = new AbortController();
    setIsSearching(true);
    const timer = setTimeout(() => {
      collectThreadSearchHits(
        (cursor) => searchMessages({ q: trimmed, conversationId, cursor, signal: controller.signal }),
        { onProgress: setRemote, isCancelled: () => controller.signal.aborted },
      )
        .catch(() => {
          // Aborted or failed: local matches (and hits so far) still work.
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [conversationId, trimmed]);

  const matches = useMemo(() => {
    if (trimmed.length === 0) return [];
    const byId = new Map<string, ThreadSearchMatch>();
    for (const message of loadedMessages) {
      if (message.type === "text" && !message.is_deleted && matchesQuery(message.text, trimmed)) {
        byId.set(message.message_id, { messageId: message.message_id, sentAt: message.sent_at });
      }
    }
    for (const hit of remote) {
      const { message_id, sent_at } = hit.message;
      byId.set(message_id, { messageId: message_id, sentAt: byId.get(message_id)?.sentAt ?? sent_at, hit });
    }
    return [...byId.values()].sort((a, b) => b.sentAt - a.sentAt || (a.messageId < b.messageId ? 1 : -1));
  }, [loadedMessages, remote, trimmed]);

  return { matches, isSearching };
}

export interface ThreadSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  /** 0-based index of the current match, -1 when none. */
  currentIndex: number;
  isSearching: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

/** "Older"/"newer" step through matches; Enter = older, Shift+Enter = newer. */
export function ThreadSearchBar({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  isSearching,
  onPrevious,
  onNext,
  onClose,
}: ThreadSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const status =
    query.trim().length === 0
      ? ""
      : matchCount === 0
        ? isSearching
          ? "Searching…"
          : "No results"
        : `${currentIndex + 1} of ${matchCount}`;

  return (
    <div role="search" className="flex items-center gap-2 border-b border-juke-border bg-juke-navy px-3 py-2">
      <SearchGlyph className="h-4 w-4 shrink-0 text-juke-text-on-dark-tertiary" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onPrevious();
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder="Search in conversation"
        aria-label="Search in conversation"
        className="min-w-0 flex-1 bg-transparent text-sm text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:outline-none"
      />
      {isSearching && matchCount > 0 && <Spinner size="sm" label="Searching" />}
      <span aria-live="polite" className="shrink-0 text-xs tabular-nums text-juke-text-on-dark-secondary">
        {status}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Older match (Enter)"
        className="flex h-8 w-8 items-center justify-center rounded-full text-juke-text-on-dark-secondary hover:bg-juke-surface disabled:opacity-40"
      >
        <ChevronUpIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onPrevious}
        disabled={matchCount === 0}
        aria-label="Newer match (Shift+Enter)"
        className="flex h-8 w-8 items-center justify-center rounded-full text-juke-text-on-dark-secondary hover:bg-juke-surface disabled:opacity-40"
      >
        <ChevronDownIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close search (Escape)"
        className="flex h-8 w-8 items-center justify-center rounded-full text-juke-text-on-dark-secondary hover:bg-juke-surface"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
