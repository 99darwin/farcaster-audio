"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EmojiEntry } from "@/lib/compose/emoji-data";
import { searchEmoji } from "@/lib/compose/emoji-index";
import { Spinner } from "@/components/ui/spinner";

/** Emojis shown before the user types a query (dataset order). */
const BROWSE_LIMIT = 96;
const SEARCH_LIMIT = 48;

let datasetPromise: Promise<ReadonlyArray<EmojiEntry>> | null = null;

/** The emoji dataset is large; load it only when a picker opens. */
function loadEmojiDataset(): Promise<ReadonlyArray<EmojiEntry>> {
  datasetPromise ??= import("@/lib/compose/emoji-data").then((m) => m.EMOJIS);
  return datasetPromise;
}

export interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  autoFocus?: boolean;
}

/** Searchable emoji grid (shares the composer's emoji dataset and ranking). */
export function EmojiPicker({ onPick, autoFocus = true }: EmojiPickerProps) {
  const [dataset, setDataset] = useState<ReadonlyArray<EmojiEntry> | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadEmojiDataset().then((data) => {
      if (!cancelled) setDataset(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const results = useMemo(() => {
    if (!dataset) return [];
    const trimmed = query.trim();
    if (trimmed.length >= 2) return searchEmoji(dataset, trimmed, SEARCH_LIMIT);
    return dataset.slice(0, BROWSE_LIMIT).map(([emoji, name]) => ({ emoji, name }));
  }, [dataset, query]);

  return (
    <div className="w-[17.5rem] max-w-full">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search emoji"
        aria-label="Search emoji"
        className="mb-2 w-full rounded-lg border border-juke-border bg-juke-navy px-3 py-1.5 text-sm text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange focus:outline-none"
      />
      {!dataset ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner size="sm" label="Loading emoji" />
        </div>
      ) : results.length === 0 ? (
        <p className="py-8 text-center text-xs text-juke-text-on-dark-tertiary">No emoji found</p>
      ) : (
        <div
          role="listbox"
          aria-label="Emoji"
          className="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto"
        >
          {results.map(({ emoji, name }) => (
            <button
              key={emoji}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={name}
              title={name}
              onClick={() => onPick(emoji)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors hover:bg-juke-border"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
