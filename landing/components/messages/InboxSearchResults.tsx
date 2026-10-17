"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { isInvalidCursorError, searchConversations, searchMessages } from "@/lib/api/messages";
import type { Conversation, MessageSearchHit } from "@/lib/api/messages.types";
import {
  conversationAvatar,
  conversationTitle,
  formatInboxTime,
  userLabel,
} from "@/lib/messages/format";
import { conversationHref } from "@/lib/messages/deep-link";
import { hitSnippetSegments, queryTerms } from "@/lib/messages/highlight";
import { useMessageStore } from "@/lib/stores/messageStore";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { HighlightedText, SegmentedText } from "./MessageText";

const GLOBAL_SEARCH_DEBOUNCE_MS = 300;
/** Upstream search needs a couple of characters to be useful. */
const MIN_SEARCH_LENGTH = 2;
const CONVERSATION_RESULTS_LIMIT = 5;

interface SearchState {
  query: string;
  conversations: Conversation[];
  hits: MessageSearchHit[];
  cursor: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
}

const IDLE: SearchState = {
  query: "",
  conversations: [],
  hits: [],
  cursor: null,
  status: "idle",
  loadingMore: false,
};

export interface InboxSearchResultsProps {
  query: string;
  /** Called after a result is picked so the inbox can close the panel. */
  onNavigate: () => void;
}

/**
 * Global message search shown in place of the conversation list: matching
 * conversations first, then message hits with highlighted snippets. Picking a
 * hit opens the thread at that message (`?m=`).
 */
export function InboxSearchResults({ query, onNavigate }: InboxSearchResultsProps) {
  const viewerFid = useMessageStore((s) => s.viewer?.fid ?? null);
  const [state, setState] = useState<SearchState>(IDLE);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_SEARCH_LENGTH) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, query: trimmed, status: "loading" }));
    const timer = setTimeout(() => {
      Promise.all([
        searchConversations({ q: trimmed, limit: CONVERSATION_RESULTS_LIMIT, signal: controller.signal }).catch(
          () => ({ items: [] as Conversation[], next_cursor: null }),
        ),
        searchMessages({ q: trimmed, signal: controller.signal }),
      ])
        .then(([conversations, hits]) => {
          if (controller.signal.aborted) return;
          setState({
            query: trimmed,
            conversations: conversations.items,
            hits: hits.items,
            cursor: hits.next_cursor,
            status: "ready",
            loadingMore: false,
          });
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ ...IDLE, query: trimmed, status: "error" });
        });
    }, GLOBAL_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const loadMore = () => {
    if (!state.cursor || state.loadingMore) return;
    const { cursor, query: activeQuery } = state;
    setState((current) => ({ ...current, loadingMore: true }));
    searchMessages({ q: activeQuery, cursor })
      .then((page) =>
        setState((current) =>
          current.query === activeQuery
            ? {
                ...current,
                hits: [...current.hits, ...page.items],
                cursor: page.next_cursor,
                loadingMore: false,
              }
            : current,
        ),
      )
      .catch((error: unknown) => {
        if (!isInvalidCursorError(error)) {
          setState((current) => ({ ...current, loadingMore: false }));
          return;
        }
        // Stale cursor: drop it and reload the hits from the first page.
        searchMessages({ q: activeQuery })
          .then((firstPage) =>
            setState((current) =>
              current.query === activeQuery
                ? { ...current, hits: firstPage.items, cursor: firstPage.next_cursor, loadingMore: false }
                : current,
            ),
          )
          .catch(() => setState((current) => ({ ...current, loadingMore: false })));
      });
  };

  if (trimmed.length < MIN_SEARCH_LENGTH) {
    return (
      <p className="px-4 py-8 text-center text-sm text-juke-text-on-dark-tertiary">
        Search people, groups and messages.
      </p>
    );
  }

  const now = Date.now();
  const fallbackTerms = queryTerms(trimmed);
  const isEmpty = state.status === "ready" && state.conversations.length === 0 && state.hits.length === 0;

  return (
    <div aria-busy={state.status === "loading"} className="pb-6">
      <p className="sr-only" aria-live="polite">
        {state.status === "ready"
          ? `${state.conversations.length} conversations and ${state.hits.length}${state.cursor ? " or more" : ""} messages found`
          : ""}
      </p>

      {state.status === "loading" && state.hits.length === 0 && (
        <div className="flex justify-center py-8">
          <Spinner label="Searching messages" />
        </div>
      )}
      {state.status === "error" && (
        <p role="alert" className="px-4 py-8 text-center text-sm text-juke-text-on-dark-secondary">
          Search failed. Try again in a moment.
        </p>
      )}
      {isEmpty && (
        <p className="px-4 py-8 text-center text-sm text-juke-text-on-dark-secondary">
          No results for “{trimmed}”.
        </p>
      )}

      {state.conversations.length > 0 && (
        <section aria-label="Conversations">
          <h3 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-juke-text-on-dark-tertiary">
            Conversations
          </h3>
          <ul>
            {state.conversations.map((conversation) => {
              const title = conversationTitle(conversation, viewerFid);
              const avatar = conversationAvatar(conversation, viewerFid);
              return (
                <li key={conversation.conversation_id}>
                  <Link
                    href={conversationHref(conversation.conversation_id)}
                    onClick={onNavigate}
                    data-search-result
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-juke-surface/60 focus-visible:bg-juke-surface focus-visible:outline-none"
                  >
                    <Avatar src={avatar.src} name={avatar.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-juke-text-on-dark">
                      <HighlightedText text={title} terms={fallbackTerms} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {state.hits.length > 0 && (
        <section aria-label="Messages">
          <h3 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-juke-text-on-dark-tertiary">
            Messages
          </h3>
          <ul>
            {state.hits.map((hit) => {
              const title = conversationTitle(hit.conversation, viewerFid);
              const avatar = conversationAvatar(hit.conversation, viewerFid);
              const sender = hit.message.sender.fid === viewerFid ? "You" : userLabel(hit.message.sender);
              return (
                <li key={`${hit.conversation.conversation_id}:${hit.message.message_id}`}>
                  <Link
                    href={conversationHref(hit.conversation.conversation_id, hit.message.message_id)}
                    onClick={() => {
                      // Open at the hit using the window the search returned.
                      useMessageStore.getState().seedFromSearchHit(hit);
                      onNavigate();
                    }}
                    data-search-result
                    className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-juke-surface/60 focus-visible:bg-juke-surface focus-visible:outline-none"
                  >
                    <Avatar src={avatar.src} name={avatar.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-juke-text-on-dark">
                          {title}
                        </span>
                        <span className="shrink-0 text-xs text-juke-text-on-dark-tertiary">
                          {formatInboxTime(hit.message.sent_at, now)}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-sm leading-snug text-juke-text-on-dark-secondary [overflow-wrap:anywhere]">
                        {hit.conversation.is_group || sender === "You" ? `${sender}: ` : ""}
                        <SegmentedText segments={hitSnippetSegments(hit, fallbackTerms)} />
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {state.cursor && (
            <div className="flex justify-center pt-3">
              <button
                type="button"
                onClick={loadMore}
                disabled={state.loadingMore}
                className="rounded-full px-4 py-1.5 text-sm font-semibold text-juke-orange hover:bg-juke-orange/10 disabled:opacity-50"
              >
                {state.loadingMore ? "Loading…" : "More results"}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
