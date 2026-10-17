"use client";

/**
 * useComposerAutocomplete — cursor-aware @mention / /channel / :emoji
 * autocomplete for the CastComposer textarea.
 *
 * Design choices:
 *  - Cursor is tracked by listening to keyup/click/select on the textarea
 *    element via a stable effect (listeners are set up once per ref change,
 *    avoiding the listener churn that would occur if text were a dep).
 *  - `text` and `mode` are kept in refs so the async `checkCursor` closure
 *    always reads the latest values without being recreated on each keystroke.
 *  - Remote searches (users, channels) are debounced 200 ms and cancelled via
 *    AbortController on every new cursor update.
 *  - Emoji data is lazily imported once and cached in module scope.
 *  - `/channel` autocomplete is suppressed when mode === "reply" (spec rule).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  extractToken,
  insertCompletion,
} from "@/lib/compose/token-autocomplete";
import {
  searchUsers,
  searchChannels,
  type UserSearchItem,
  type ChannelSearchItem,
} from "@/lib/api/search";
import type { ComposeMode } from "@/lib/stores/composeStore";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SuggestionKind = "mention" | "channel" | "emoji";

/** Stable identity for the exact token/query a result set belongs to. */
export function autocompleteContextKey(
  kind: SuggestionKind,
  match: { start: number; query: string },
): string {
  return `${kind}:${match.start}:${match.query}`;
}

/** Hide rows as soon as the active token differs from their source query. */
export function resultsForAutocompleteContext<T>(
  results: T[],
  resultsContextKey: string | null,
  activeContextKey: string | null,
): T[] {
  return resultsContextKey !== null &&
    resultsContextKey === activeContextKey
    ? results
    : [];
}

/** Prevent stale commits/submits while a replacement query is pending. */
export function shouldSuppressPendingAutocompleteKey(
  key: string,
  activeContextKey: string | null,
  resultsContextKey: string | null,
): boolean {
  return (
    (key === "Enter" || key === "Tab") &&
    activeContextKey !== null &&
    activeContextKey !== resultsContextKey
  );
}

export type SuggestionRow =
  | {
      kind: "mention";
      fid: number;
      username: string;
      display_name: string | null;
      pfp_url: string | null;
    }
  | {
      kind: "channel";
      id: string;
      name: string | null;
      image_url: string | null;
    }
  | { kind: "emoji"; emoji: string; name: string };

export interface AutocompleteState {
  active: SuggestionKind | null;
  query: string;
  results: SuggestionRow[];
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  apply: (inserted: string) => void;
  dismiss: () => void;
  /** Wire to the textarea's onKeyDown — intercepts arrow/enter/tab/escape. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export interface UseComposerAutocompleteOptions {
  text: string;
  onTextChange: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  mode: ComposeMode;
}

// ---------------------------------------------------------------------------
// Module-level emoji lazy-load cache
// ---------------------------------------------------------------------------

type EmojiModules = {
  data: typeof import("@/lib/compose/emoji-data");
  index: typeof import("@/lib/compose/emoji-index");
};

let emojiModulesPromise: Promise<EmojiModules> | null = null;

function getEmojiModules(): Promise<EmojiModules> {
  if (!emojiModulesPromise) {
    emojiModulesPromise = Promise.all([
      import("@/lib/compose/emoji-data"),
      import("@/lib/compose/emoji-index"),
    ]).then(([data, index]) => ({ data, index }));
  }
  return emojiModulesPromise;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 200;

export function useComposerAutocomplete({
  text,
  onTextChange,
  textareaRef,
  mode,
}: UseComposerAutocompleteOptions): AutocompleteState {
  const [active, setActive] = useState<SuggestionKind | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SuggestionRow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Refs so the stable cursor-check closure always reads current values.
  const textRef = useRef(text);
  textRef.current = text;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;

  // Token position stored for apply().
  const tokenStartRef = useRef(0);
  const cursorRef = useRef(0);
  const activeContextKeyRef = useRef<string | null>(null);
  const resultsContextKeyRef = useRef<string | null>(null);

  // Async bookkeeping.
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const dismiss = useCallback(() => {
    activeContextKeyRef.current = null;
    resultsContextKeyRef.current = null;
    setActive(null);
    setQuery("");
    setResults([]);
    setSelectedIndex(0);
  }, []);

  const apply = useCallback((inserted: string) => {
    const { text: newText, cursor: newCursor } = insertCompletion(
      textRef.current,
      tokenStartRef.current,
      cursorRef.current,
      inserted,
    );
    onTextChangeRef.current(newText);
    dismiss();
    // Restore caret after React's setState flush.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, [dismiss, textareaRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!active) return;
      if (
        shouldSuppressPendingAutocompleteKey(
          e.key,
          activeContextKeyRef.current,
          resultsContextKeyRef.current,
        )
      ) {
        e.preventDefault();
        return;
      }
      const currentResults = resultsForAutocompleteContext(
        results,
        resultsContextKeyRef.current,
        activeContextKeyRef.current,
      );
      switch (e.key) {
        case "ArrowDown":
          if (currentResults.length === 0) return;
          e.preventDefault();
          setSelectedIndex((i) =>
            Math.min(i + 1, currentResults.length - 1),
          );
          break;
        case "ArrowUp":
          if (currentResults.length === 0) return;
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
        case "Tab": {
          const row = currentResults[selectedIndex];
          if (!row) break;
          e.preventDefault();
          // Pass the trigger prefix for mention/channel so insertCompletion
          // replaces the full token correctly; emoji glyphs have no prefix.
          if (row.kind === "mention") apply("@" + row.username);
          else if (row.kind === "channel") apply("/" + row.id);
          else apply(row.emoji);
          break;
        }
        case "Escape":
          e.preventDefault();
          dismiss();
          break;
      }
    },
    [active, results, selectedIndex, apply, dismiss],
  );

  /** Core logic: given the current cursor position, compute the active token. */
  const checkCursor = useCallback(async (cursor: number) => {
    const currentText = textRef.current;
    const currentMode = modeRef.current;
    cursorRef.current = cursor;

    // Cancel any pending debounce + in-flight request.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();

    const activateContext = (
      kind: SuggestionKind,
      match: { start: number; query: string },
    ) => {
      const nextKey = autocompleteContextKey(kind, match);
      if (activeContextKeyRef.current !== nextKey) {
        activeContextKeyRef.current = nextKey;
        resultsContextKeyRef.current = null;
        if (mountedRef.current) setResults([]);
      }
      return nextKey;
    };

    // ── @mention ─────────────────────────────────────────────────────────────
    const mentionMatch = extractToken(currentText, cursor, "@");
    if (mentionMatch) {
      const contextKey = activateContext("mention", mentionMatch);
      tokenStartRef.current = mentionMatch.start;
      if (mountedRef.current) {
        setActive("mention");
        setQuery(mentionMatch.query);
        setSelectedIndex(0);
      }
      // Debounce remote search
      debounceRef.current = setTimeout(async () => {
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          const users = await searchUsers(mentionMatch.query || "a", {
            signal: ac.signal,
          });
          if (
            mountedRef.current &&
            !ac.signal.aborted &&
            activeContextKeyRef.current === contextKey
          ) {
            resultsContextKeyRef.current = contextKey;
            setResults(
              users.map(
                (u: UserSearchItem): SuggestionRow => ({
                  kind: "mention",
                  fid: u.fid,
                  username: u.username,
                  display_name: u.display_name,
                  pfp_url: u.pfp_url,
                }),
              ),
            );
          }
        } catch {
          if (
            mountedRef.current &&
            !ac.signal.aborted &&
            activeContextKeyRef.current === contextKey
          ) {
            resultsContextKeyRef.current = contextKey;
            setResults([]);
          }
        }
      }, DEBOUNCE_MS);
      return;
    }

    // ── /channel (suppressed in reply mode) ──────────────────────────────────
    if (currentMode !== "reply") {
      const channelMatch = extractToken(currentText, cursor, "/");
      if (channelMatch) {
        const contextKey = activateContext("channel", channelMatch);
        tokenStartRef.current = channelMatch.start;
        if (mountedRef.current) {
          setActive("channel");
          setQuery(channelMatch.query);
          setSelectedIndex(0);
        }
        debounceRef.current = setTimeout(async () => {
          const ac = new AbortController();
          abortRef.current = ac;
          try {
            const channels = await searchChannels(channelMatch.query || "a", {
              signal: ac.signal,
            });
            if (
              mountedRef.current &&
              !ac.signal.aborted &&
              activeContextKeyRef.current === contextKey
            ) {
              resultsContextKeyRef.current = contextKey;
              setResults(
                channels.map(
                  (c: ChannelSearchItem): SuggestionRow => ({
                    kind: "channel",
                    id: c.id,
                    name: c.name,
                    image_url: c.image_url,
                  }),
                ),
              );
            }
          } catch {
            if (
              mountedRef.current &&
              !ac.signal.aborted &&
              activeContextKeyRef.current === contextKey
            ) {
              resultsContextKeyRef.current = contextKey;
              setResults([]);
            }
          }
        }, DEBOUNCE_MS);
        return;
      }
    }

    // ── :emoji (requires ≥2 query chars, local search) ───────────────────────
    const emojiMatch = extractToken(currentText, cursor, ":");
    if (emojiMatch && emojiMatch.query.length >= 2) {
      const contextKey = activateContext("emoji", emojiMatch);
      tokenStartRef.current = emojiMatch.start;
      if (mountedRef.current) {
        setActive("emoji");
        setQuery(emojiMatch.query);
        setSelectedIndex(0);
      }
      // Pre-load modules (cached after first call) then search synchronously.
      try {
        const { data: emojiData, index: emojiIndex } = await getEmojiModules();
        if (
          mountedRef.current &&
          activeContextKeyRef.current === contextKey
        ) {
          resultsContextKeyRef.current = contextKey;
          setResults(
            emojiIndex
              .searchEmoji(emojiData.EMOJIS, emojiMatch.query)
              .map(
                (r): SuggestionRow => ({
                  kind: "emoji",
                  emoji: r.emoji,
                  name: r.name,
                }),
              ),
          );
        }
      } catch {
        if (
          mountedRef.current &&
          activeContextKeyRef.current === contextKey
        ) {
          resultsContextKeyRef.current = contextKey;
          setResults([]);
        }
      }
      return;
    }

    // ── No match — clear popover ──────────────────────────────────────────────
    // NOTE: `active` is intentionally NOT referenced here — this callback is
    // stable (deps=[]) so any `active` captured at creation would always be
    // the initial `null` value (stale closure). React batches duplicate
    // setState calls, so calling setActive(null) when already null is cheap.
    if (mountedRef.current) {
      activeContextKeyRef.current = null;
      resultsContextKeyRef.current = null;
      setActive(null);
      setResults([]);
    }
  }, []); // stable — reads all live values via refs

  // Cursor-move listeners: keyup/click/select fire for caret moves that do NOT
  // change the text (arrow keys, clicking to reposition, drag-select). Stable
  // effect — only re-runs if textareaRef.current changes (once per mount).
  //
  // `input` is deliberately NOT handled here — text changes are picked up by
  // the post-commit effect below instead. See that effect for why a native
  // `input` listener must never drive the autocomplete on a controlled input.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const onCursorChange = () => {
      textRef.current = el.value;
      void checkCursor(el.selectionStart ?? 0);
    };

    el.addEventListener("keyup", onCursorChange);
    el.addEventListener("click", onCursorChange);
    el.addEventListener("select", onCursorChange);

    return () => {
      el.removeEventListener("keyup", onCursorChange);
      el.removeEventListener("click", onCursorChange);
      el.removeEventListener("select", onCursorChange);
    };
  }, [textareaRef, checkCursor]);

  // Text-change autocomplete: re-evaluate the active token whenever the
  // controlled `text` changes (typing, paste, cut, drag-drop, autofill). All
  // of these flow through React's controlled value, so a post-commit effect
  // covers them uniformly.
  //
  // This MUST run from an effect, never a native `input` listener. A native
  // `input` handler runs synchronously inside the browser's input dispatch;
  // because `input` is a discrete event, the setState it triggers
  // (setActive/setResults) flushes synchronously and re-renders the controlled
  // <textarea value={text}>, resetting its DOM value to the pre-change `text`
  // BEFORE React's own delegated onChange fires. React then sees no value
  // change, never calls onChange, and `setText` never runs — silently breaking
  // typing entirely. Running after React commits the new value avoids that
  // reentrancy while still covering non-keyboard edits.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    void checkCursor(el.selectionStart ?? 0);
  }, [text, textareaRef, checkCursor]);

  const currentResults = resultsForAutocompleteContext(
    results,
    resultsContextKeyRef.current,
    activeContextKeyRef.current,
  );

  return {
    active,
    query,
    results: currentResults,
    selectedIndex,
    setSelectedIndex,
    apply,
    dismiss,
    handleKeyDown,
  };
}
