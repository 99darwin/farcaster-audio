"use client";

/**
 * FIP-2 live chat panel for the web space screen, ported from mobile
 * `components/spaces/SpaceChat.tsx`. Mobile puts chat behind a tab; on web
 * there's room to render it inline below the participant grid.
 *
 * Messages are casts threaded under the room's root cast (`Room.cast_hash`).
 * The nested Farcaster conversation tree is flattened chronologically — a live
 * chat reads as a stream, not a thread — and the composer always replies to
 * the root, matching mobile.
 *
 * Refresh strategy: when this session is live, the backend pings
 * `space_chat`/`new_reply` over the LiveKit data channel and `useSpace` bumps
 * `chatNewReplyTick`; previewing users have no data channel, so we poll.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useSpaceStore } from "@/lib/space/spaceStore";
import {
  fetchCastThread,
  publishChatReply,
  type ChatCast,
} from "@/lib/space/chatApi";
import { ApiFetchError } from "@/lib/api/client";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import {
  useComposerAutocomplete,
  type SuggestionRow,
} from "@/components/compose/useComposerAutocomplete";
import { rowInserted } from "@/components/compose/SuggestionPopover";

const POLL_INTERVAL_MS = 15_000;
const STICK_TO_BOTTOM_THRESHOLD_PX = 80;
const MAX_MESSAGE_LENGTH = 1024;
/** Drop an unconfirmed local echo after this long — the node never indexed it. */
const ECHO_TTL_MS = 60_000;

interface SpaceChatProps {
  castHash: string;
  /**
   * Connected to this session's LiveKit room — new replies arrive as
   * `chatNewReplyTick` bumps over the data channel, so polling is skipped.
   */
  live: boolean;
}

/** Depth-first flatten of the reply tree into one chronological stream. */
function flattenReplies(root: ChatCast): ChatCast[] {
  const out: ChatCast[] = [];
  const walk = (cast: ChatCast) => {
    for (const reply of cast.direct_replies ?? []) {
      if (reply.is_spam) continue;
      out.push(reply);
      walk(reply);
    }
  };
  walk(root);
  return out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function timeAgo(iso: string): string {
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs) || deltaMs < 60_000) return "now";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

let echoIdSeq = 0;

export function SpaceChat({ castHash, live }: SpaceChatProps) {
  const { user } = useAuth();
  const chatNewReplyTick = useSpaceStore((s) => s.chatNewReplyTick);

  const [replies, setReplies] = useState<ChatCast[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Locally-sent messages not yet visible in the fetched thread (the node
  // indexing can lag a refetch) — rendered at the tail until confirmed.
  const [echoes, setEchoes] = useState<ChatCast[]>([]);

  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const suggestionListId = useId();
  const autocomplete = useComposerAutocomplete({
    text,
    onTextChange: setText,
    textareaRef,
    mode: "reply",
  });

  const loadThread = useCallback(async () => {
    try {
      const data = await fetchCastThread(castHash);
      const fetched = flattenReplies(data.conversation.cast);
      setReplies(fetched);
      setEchoes((prev) =>
        prev.filter(
          (echo) =>
            Date.now() - Date.parse(echo.timestamp) < ECHO_TTL_MS &&
            !fetched.some(
              (m) =>
                m.hash === echo.hash ||
                (m.author.fid === echo.author.fid &&
                  m.text.trim() === echo.text.trim()),
            ),
        ),
      );
    } catch {
      // Transient fetch failures just delay the next refresh.
    } finally {
      setIsLoading(false);
    }
  }, [castHash]);

  // Initial load + reload when the root cast changes.
  useEffect(() => {
    setIsLoading(true);
    setReplies([]);
    void loadThread();
  }, [loadThread]);

  // Live sessions: refetch when a new reply lands on the data channel.
  useEffect(() => {
    if (chatNewReplyTick === 0) return;
    void loadThread();
  }, [chatNewReplyTick, loadThread]);

  // Preview (not joined): no data channel, so poll.
  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => void loadThread(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [live, loadThread]);

  const messages = useMemo(() => [...replies, ...echoes], [replies, echoes]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <
      STICK_TO_BOTTOM_THRESHOLD_PX;
  }, []);

  // Keep the newest message in view unless the user scrolled up to read back.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, isLoading]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    setIsSending(true);
    setSendError(null);
    try {
      const { hash } = await publishChatReply(trimmed, castHash);
      setText("");
      autocomplete.dismiss();
      if (user) {
        echoIdSeq += 1;
        setEchoes((prev) => [
          ...prev,
          {
            // The real hash lets the refetch dedup retire this echo exactly.
            hash: hash ?? `echo-${echoIdSeq}`,
            author: {
              fid: user.fid,
              username: user.username,
              display_name: user.display_name,
              pfp_url: user.pfp_url,
            },
            text: trimmed,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
      stickToBottomRef.current = true;
      await loadThread();
    } catch (err) {
      setSendError(
        err instanceof ApiFetchError && err.detail
          ? err.detail
          : "Couldn't send — try again.",
      );
    } finally {
      setIsSending(false);
    }
  }, [text, isSending, castHash, user, loadThread, autocomplete.dismiss]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void handleSend();
    },
    [handleSend],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      autocomplete.handleKeyDown(e);
      if (e.defaultPrevented) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend, autocomplete.handleKeyDown],
  );

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-juke-border bg-juke-surface">
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="max-h-[420px] min-h-[160px] overflow-y-auto px-4 py-3"
      >
        {isLoading && messages.length === 0 ? (
          <div className="flex h-[136px] items-center justify-center">
            <Spinner />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-[136px] items-center justify-center">
            <p className="text-sm text-juke-text-on-dark-tertiary">
              No messages yet — say hi.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {messages.map((m) => (
              <li key={m.hash} className="flex gap-2.5">
                <Avatar
                  src={m.author.pfp_url}
                  name={m.author.display_name || m.author.username}
                  size="xs"
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-semibold text-juke-text-on-dark">
                      {m.author.display_name || `@${m.author.username}`}
                    </span>
                    <span className="shrink-0 text-[11px] text-juke-text-on-dark-tertiary">
                      {timeAgo(m.timestamp)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-snug text-juke-text-on-dark-secondary">
                    {m.text}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 border-t border-juke-border px-3 py-2.5"
      >
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply to this space…"
            rows={1}
            maxLength={MAX_MESSAGE_LENGTH}
            disabled={isSending}
            aria-label="Reply to this space"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls={
              autocomplete.results.length > 0 ? suggestionListId : undefined
            }
            aria-expanded={
              autocomplete.active !== null && autocomplete.results.length > 0
            }
            aria-activedescendant={
              autocomplete.results.length > 0
                ? `${suggestionListId}-option-${autocomplete.selectedIndex}`
                : undefined
            }
            className="max-h-24 w-full resize-none rounded-2xl border border-juke-border bg-juke-navy px-3.5 py-2 text-sm text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange focus:outline-none disabled:opacity-60"
          />

          {autocomplete.active !== null && autocomplete.results.length > 0 && (
            <SpaceChatSuggestions
              id={suggestionListId}
              rows={autocomplete.results}
              selectedIndex={autocomplete.selectedIndex}
              onHover={autocomplete.setSelectedIndex}
              onSelect={(row) => autocomplete.apply(rowInserted(row))}
            />
          )}
        </div>
        <button
          type="submit"
          disabled={!text.trim() || isSending}
          aria-label="Send message"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-juke-orange text-white transition-colors hover:bg-juke-orange-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden
          >
            <path d="M10 3.5a.9.9 0 0 1 .64.27l5.1 5.1a.9.9 0 1 1-1.28 1.27L10.9 6.58V15.6a.9.9 0 0 1-1.8 0V6.58l-3.56 3.56a.9.9 0 1 1-1.28-1.27l5.1-5.1A.9.9 0 0 1 10 3.5Z" />
          </svg>
        </button>
      </form>

      {sendError && (
        <p className="border-t border-juke-border px-4 py-2 text-xs text-red-300">
          {sendError}
        </p>
      )}
    </div>
  );
}

interface SpaceChatSuggestionsProps {
  id: string;
  rows: SuggestionRow[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (row: SuggestionRow) => void;
}

function SpaceChatSuggestions({
  id,
  rows,
  selectedIndex,
  onHover,
  onSelect,
}: SpaceChatSuggestionsProps) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Suggestions"
      className="absolute bottom-[calc(100%+0.375rem)] left-0 right-0 z-50 max-h-56 overflow-y-auto rounded-xl border border-juke-border bg-juke-surface py-1 shadow-2xl"
      onMouseDown={(event) => event.preventDefault()}
    >
      {rows.map((row, index) => (
        <li
          id={`${id}-option-${index}`}
          key={suggestionKey(row)}
          role="option"
          aria-selected={index === selectedIndex}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(row)}
          className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
            index === selectedIndex
              ? "bg-white/10 text-juke-text-on-dark"
              : "text-juke-text-on-dark-secondary hover:bg-white/5"
          }`}
        >
          <SuggestionContent row={row} />
        </li>
      ))}
    </ul>
  );
}

function suggestionKey(row: SuggestionRow): string {
  if (row.kind === "mention") return `mention-${row.fid}`;
  if (row.kind === "channel") return `channel-${row.id}`;
  return `emoji-${row.name}`;
}

function SuggestionContent({ row }: { row: SuggestionRow }) {
  if (row.kind === "emoji") {
    return (
      <>
        <span className="text-xl leading-none" aria-hidden>
          {row.emoji}
        </span>
        <span>:{row.name.replace(/ /g, "_")}:</span>
      </>
    );
  }

  const src = row.kind === "mention" ? row.pfp_url : row.image_url;
  const name =
    row.kind === "mention"
      ? row.display_name || row.username
      : row.name || row.id;
  return (
    <>
      <Avatar src={src} name={name} size="xs" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-juke-text-on-dark">{name}</span>{" "}
        <span className="text-juke-text-on-dark-secondary">
          {row.kind === "mention" ? `@${row.username}` : `/${row.id}`}
        </span>
      </span>
    </>
  );
}
