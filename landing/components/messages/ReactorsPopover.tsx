"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { getReactors, isInvalidCursorError } from "@/lib/api/messages";
import type { Message, ReactorEntry } from "@/lib/api/messages.types";
import { profileHref, userLabel } from "@/lib/messages/format";
import { shouldAutoPageReactors } from "@/lib/messages/reactors";
import { Avatar } from "@/components/ui/avatar";
import { Modal } from "@/components/ui/modal";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/cn";
import { TWO_PANE_QUERY, useMediaQuery } from "./useMediaQuery";

const ALL_TAB = "__all__";

export interface ReactorsPopoverProps {
  message: Message | null;
  /** Tab to open on (an emoji), defaults to "All". */
  initialReaction?: string | null;
  onClose: () => void;
}

/**
 * Who reacted: per-emoji tabs over the paginated `GET /reactions` list, each
 * entry linking to the reactor's profile. A centered dialog on desktop and a
 * bottom sheet on narrow screens.
 */
export function ReactorsPopover({ message, initialReaction = null, onClose }: ReactorsPopoverProps) {
  const isWide = useMediaQuery(TWO_PANE_QUERY);
  const open = message !== null;
  const content = message ? (
    <ReactorsContent key={message.message_id} message={message} initialReaction={initialReaction} />
  ) : null;

  return isWide ? (
    <Modal open={open} onClose={onClose} title="Reactions" className="max-w-sm">
      {content}
    </Modal>
  ) : (
    <Sheet open={open} onClose={onClose} title="Reactions">
      {content}
    </Sheet>
  );
}

function ReactorsContent({
  message,
  initialReaction,
}: {
  message: Message;
  initialReaction: string | null;
}) {
  const [tab, setTab] = useState<string>(initialReaction ?? ALL_TAB);
  const [entries, setEntries] = useState<ReactorEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (pageCursor: string | null) => {
      setIsLoading(true);
      setError(null);
      const fetchPage = (cursorToLoad: string | null) =>
        getReactors({
          conversationId: message.conversation_id,
          messageId: message.message_id,
          cursor: cursorToLoad,
        });
      try {
        let isAppending = pageCursor !== null;
        let page: Awaited<ReturnType<typeof getReactors>>;
        try {
          page = await fetchPage(pageCursor);
        } catch (loadError) {
          if (!isAppending || !isInvalidCursorError(loadError)) throw loadError;
          // Stale cursor: drop it and reload from the first page.
          isAppending = false;
          page = await fetchPage(null);
        }
        setEntries((current) => (isAppending ? [...current, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setHasMore(page.next_cursor !== null);
      } catch {
        setError("Couldn't load reactions");
      } finally {
        setIsLoading(false);
      }
    },
    [message.conversation_id, message.message_id],
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  const tabs = useMemo(
    () => [
      { id: ALL_TAB, label: "All", count: message.reactions.reduce((sum, r) => sum + r.count, 0) },
      ...message.reactions.map((r) => ({ id: r.reaction, label: r.reaction, count: r.count })),
    ],
    [message.reactions],
  );
  const visible = tab === ALL_TAB ? entries : entries.filter((e) => e.reaction === tab);

  // Pages mix emojis, so keep fetching while the selected tab has nothing yet.
  const shouldAutoPage = shouldAutoPageReactors({
    visibleCount: visible.length,
    cursor,
    hasMore,
    isLoading,
    hasError: error !== null,
  });
  useEffect(() => {
    if (shouldAutoPage) void loadPage(cursor);
  }, [shouldAutoPage, cursor, loadPage]);

  const idPrefix = useId();
  const tabDomId = (tabId: string): string => `${idPrefix}-tab-${tabs.findIndex((t) => t.id === tabId)}`;
  const panelDomId = `${idPrefix}-panel`;

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const index = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    setTab(next.id);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)
      ?.focus();
    event.preventDefault();
  };

  return (
    <div className="flex max-h-[70dvh] flex-col">
      <div
        role="tablist"
        aria-label="Filter by reaction"
        onKeyDown={handleTabKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-juke-border px-1 pb-2"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={tabDomId(t.id)}
            aria-controls={panelDomId}
            data-tab-id={t.id}
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-sm font-semibold transition-colors",
              tab === t.id
                ? "bg-juke-orange/20 text-juke-text-on-dark"
                : "text-juke-text-on-dark-secondary hover:bg-juke-border/60",
            )}
          >
            {t.label} <span className="tabular-nums">{t.count}</span>
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={panelDomId}
        aria-labelledby={tabDomId(tab)}
        tabIndex={0}
        className="min-h-[8rem] overflow-y-auto py-2">
        {visible.length > 0 && (
          <ul className="flex flex-col">
            {visible.map((entry, index) => (
              <li key={`${entry.user.fid}:${entry.reaction}:${index}`}>
                <Link
                  href={profileHref(entry.user)}
                  className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-juke-border/50"
                >
                  <Avatar src={entry.user.pfp_url} name={userLabel(entry.user)} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-juke-text-on-dark">
                      {entry.user.display_name || userLabel(entry.user)}
                    </span>
                    {entry.user.username && (
                      <span className="block truncate text-xs text-juke-text-on-dark-tertiary">
                        @{entry.user.username}
                      </span>
                    )}
                  </span>
                  <span className="text-lg" aria-label={`reacted ${entry.reaction}`}>
                    {entry.reaction}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {isLoading && (
          <div className="flex justify-center py-4">
            <Spinner size="sm" label="Loading reactions" />
          </div>
        )}
        {error && (
          <p role="alert" className="py-4 text-center text-sm text-juke-text-on-dark-secondary">
            {error}{" "}
            <button type="button" className="font-semibold text-juke-orange" onClick={() => void loadPage(cursor)}>
              Retry
            </button>
          </p>
        )}
        {!isLoading && !error && !shouldAutoPage && visible.length === 0 && (
          <p className="py-6 text-center text-sm text-juke-text-on-dark-tertiary">No reactions yet</p>
        )}
        {!isLoading && !error && hasMore && cursor && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={() => void loadPage(cursor)}
              className="rounded-full px-4 py-1.5 text-sm font-semibold text-juke-orange hover:bg-juke-orange/10"
            >
              Show more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
