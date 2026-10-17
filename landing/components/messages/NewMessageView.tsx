"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { searchRecipients } from "@/lib/api/messages";
import type { MessageUser } from "@/lib/api/messages.types";
import { getUser } from "@/lib/api/users";
import { MESSAGES_INBOX_PATH, parseFidParam } from "@/lib/messages/deep-link";
import { userLabel } from "@/lib/messages/format";
import { useMessageStore } from "@/lib/stores/messageStore";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/cn";
import { ThreadView } from "./ThreadView";
import { BackIcon, CloseIcon } from "./icons";

const RECIPIENT_SEARCH_DEBOUNCE_MS = 250;

function conversationPath(conversationId: string): string {
  return `/app/messages/${encodeURIComponent(conversationId)}`;
}

/** Existing 1:1 with `fid`, if the inbox already knows about one. */
function findDirectConversationId(fid: number): string | null {
  const { conversations } = useMessageStore.getState();
  for (const conversation of Object.values(conversations)) {
    if (!conversation.is_group && conversation.counterparty?.fid === fid) return conversation.conversation_id;
  }
  return null;
}

/**
 * New-message flow: pick a recipient (`GET /recipients`), then compose in a
 * draft thread. An existing 1:1 (from the inbox, else
 * `GET /conversations/with/{fid}`) is opened instead of starting a new one;
 * the first send creates the conversation and swaps the URL to it.
 * `?fid=` (e.g. a profile's Message button) skips the picker.
 */
export function NewMessageView() {
  const router = useRouter();
  const fidParam = parseFidParam(useSearchParams()?.get("fid"));
  const viewerFid = useMessageStore((s) => s.viewer?.fid ?? null);
  const [recipient, setRecipient] = useState<MessageUser | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  /** Open the existing 1:1 with `fid`; false when there is none (or the lookup failed). */
  const openExisting = useCallback(
    async (fid: number): Promise<boolean> => {
      const cached = findDirectConversationId(fid);
      const existing =
        cached ??
        (await useMessageStore
          .getState()
          .findDirectConversation(fid)
          .then((conversation) => conversation?.conversation_id ?? null)
          // A failed lookup falls back to a draft: the first send lands in the
          // same upstream 1:1 either way.
          .catch(() => null));
      if (!existing) return false;
      router.replace(conversationPath(existing));
      return true;
    },
    [router],
  );

  const pickRecipient = async (user: MessageUser) => {
    setIsResolving(true);
    try {
      if (!(await openExisting(user.fid))) setRecipient(user);
    } finally {
      setIsResolving(false);
    }
  };

  useEffect(() => {
    if (fidParam === null || viewerFid === null) return;
    if (fidParam === viewerFid) {
      setResolveError("You can't message yourself.");
      return;
    }
    let cancelled = false;
    setIsResolving(true);
    setResolveError(null);
    void (async () => {
      try {
        if (await openExisting(fidParam)) return;
        const profile = await getUser(fidParam);
        if (cancelled) return;
        setRecipient({
          fid: profile.fid,
          username: profile.username || null,
          display_name: profile.display_name || profile.username || `fid ${profile.fid}`,
          pfp_url: profile.pfp_url,
        });
      } catch {
        if (!cancelled) setResolveError("Couldn't find that person. Search for them instead.");
      } finally {
        if (!cancelled) setIsResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fidParam, viewerFid, openExisting]);

  if (isResolving && fidParam !== null && !recipient) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Opening conversation" />
      </div>
    );
  }

  if (recipient) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-juke-border px-4 py-2 text-sm">
          <span className="text-juke-text-on-dark-tertiary">To:</span>
          <span className="flex items-center gap-1.5 rounded-full bg-juke-surface py-0.5 pl-1 pr-1">
            <Avatar src={recipient.pfp_url} name={userLabel(recipient)} size="xs" />
            <span className="font-semibold text-juke-text-on-dark">{userLabel(recipient)}</span>
            <button
              type="button"
              onClick={() => setRecipient(null)}
              aria-label={`Remove ${userLabel(recipient)}`}
              className="flex h-5 w-5 items-center justify-center rounded-full text-juke-text-on-dark-tertiary hover:text-juke-text-on-dark"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <ThreadView
            conversationId={null}
            draftPeer={recipient}
            onConversationCreated={(conversationId) => router.replace(conversationPath(conversationId))}
          />
        </div>
      </div>
    );
  }

  return <RecipientPicker onPick={(user) => void pickRecipient(user)} notice={resolveError} />;
}

function RecipientPicker({ onPick, notice }: { onPick: (user: MessageUser) => void; notice: string | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageUser[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmed = query.trim().replace(/^@/, "");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    const timer = setTimeout(() => {
      searchRecipients({ q: trimmed, signal: controller.signal })
        .then((page) => {
          setResults(page.items);
          setActiveIndex(0);
          setStatus("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) setStatus("error");
        });
    }, RECIPIENT_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") setActiveIndex((i) => (i + 1) % results.length);
    else if (event.key === "ArrowUp") setActiveIndex((i) => (i - 1 + results.length) % results.length);
    else if (event.key === "Enter") onPick(results[activeIndex]);
    else return;
    event.preventDefault();
  };

  const activeId = results[activeIndex] ? `recipient-${results[activeIndex].fid}` : undefined;

  return (
    <section aria-label="New message" className="flex h-full min-h-0 flex-col bg-juke-navy">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-juke-border px-2 md:px-3">
        <Link
          href={MESSAGES_INBOX_PATH}
          aria-label="Back to conversations"
          className="flex h-10 w-10 items-center justify-center rounded-full text-juke-text-on-dark-secondary hover:bg-juke-surface hover:text-juke-text-on-dark lg:hidden"
        >
          <BackIcon className="h-5 w-5" />
        </Link>
        <h2 className="px-2 text-[15px] font-bold text-juke-text-on-dark">New message</h2>
      </header>
      <div className="flex shrink-0 items-center gap-2 border-b border-juke-border px-4 py-2">
        <label htmlFor="recipient-search" className="text-sm text-juke-text-on-dark-tertiary">
          To:
        </label>
        <input
          id="recipient-search"
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search by name or @username"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="recipient-results"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent py-1 text-sm text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {notice && status === "idle" && (
          <p role="alert" className="px-4 pt-6 text-center text-sm text-juke-text-on-dark-secondary">
            {notice}
          </p>
        )}
        {status === "loading" && results.length === 0 && (
          <div className="flex justify-center py-8">
            <Spinner label="Searching people" />
          </div>
        )}
        {status === "error" && (
          <p role="alert" className="px-4 py-8 text-center text-sm text-juke-text-on-dark-secondary">
            Couldn&apos;t search right now. Try again in a moment.
          </p>
        )}
        {status === "ready" && results.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-juke-text-on-dark-secondary">
            Nobody found for “{trimmed}”.
          </p>
        )}
        {status === "idle" && (
          <p className="px-4 py-8 text-center text-sm text-juke-text-on-dark-tertiary">
            Find someone on Farcaster to message.
          </p>
        )}
        <ul id="recipient-results" role="listbox" aria-label="People">
          {results.map((user, index) => (
            <li
              key={user.fid}
              id={`recipient-${user.fid}`}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => onPick(user)}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                "flex cursor-pointer items-center gap-3 px-4 py-2.5",
                index === activeIndex ? "bg-juke-surface" : "hover:bg-juke-surface/60",
              )}
            >
              <Avatar src={user.pfp_url} name={userLabel(user)} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-juke-text-on-dark">
                  {user.display_name || userLabel(user)}
                </span>
                {user.username && (
                  <span className="block truncate text-xs text-juke-text-on-dark-tertiary">@{user.username}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
