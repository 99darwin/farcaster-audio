"use client";

/**
 * SuggestionPopover — autocomplete dropdown that appears below the composer
 * textarea.
 *
 * Renders one of three row types depending on `active`:
 *   "mention" → Avatar + display name + @username
 *   "channel" → channel image + /id
 *   "emoji"   → glyph + :name:
 *
 * Keyboard navigation (ArrowUp/Down, Enter/Tab, Escape) is handled upstream
 * in `useComposerAutocomplete.handleKeyDown`, which calls `preventDefault`
 * before global shortcut handlers see the event.  This component only handles
 * pointer events and hover-to-select.
 *
 * The popover is rendered in a `relative` container wrapping the textarea so
 * `absolute top-full` positions it flush below the input.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui/cn";
import type { SuggestionRow } from "./useComposerAutocomplete";

interface SuggestionPopoverProps {
  rows: SuggestionRow[];
  selectedIndex: number;
  onHoverIndex: (i: number) => void;
  onSelect: (row: SuggestionRow) => void;
  onDismiss: () => void;
}

/**
 * Returns the full replacement string for a given suggestion row.
 * Includes the trigger character for mention (@) and channel (/) so that
 * `insertCompletion` — which replaces the whole token — produces the correct
 * output. Emoji rows use the raw glyph with no colon prefix.
 */
function rowInserted(row: SuggestionRow): string {
  if (row.kind === "mention") return "@" + row.username;
  if (row.kind === "channel") return "/" + row.id;
  return row.emoji;
}

export function SuggestionPopover({
  rows,
  selectedIndex,
  onHoverIndex,
  onSelect,
  onDismiss,
}: SuggestionPopoverProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // Scroll the selected item into view when keyboard navigation changes it.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (rows.length === 0) return null;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard handled upstream
    <div
      className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-juke-border bg-juke-surface shadow-2xl"
      // Prevent the textarea from losing focus when clicking a row.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        // Dismiss if clicking the popover container but not a row.
        if (e.target === e.currentTarget) onDismiss();
      }}
      role="listbox"
      aria-label="Suggestions"
    >
      <ul ref={listRef} className="max-h-56 overflow-y-auto py-1">
        {rows.map((row, i) => (
          <li
            key={rowKey(row)}
            role="option"
            aria-selected={i === selectedIndex}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm transition-colors",
              i === selectedIndex
                ? "bg-white/10 text-juke-text-on-dark"
                : "text-juke-text-on-dark-secondary hover:bg-white/5",
            )}
            onMouseEnter={() => onHoverIndex(i)}
            onClick={() => onSelect(row)}
          >
            <RowContent row={row} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function rowKey(row: SuggestionRow): string {
  if (row.kind === "mention") return `mention-${row.fid}`;
  if (row.kind === "channel") return `channel-${row.id}`;
  return `emoji-${row.name}`;
}

function RowContent({ row }: { row: SuggestionRow }) {
  if (row.kind === "mention") {
    const displayName = row.display_name || row.username;
    return (
      <>
        <MiniAvatar src={row.pfp_url} name={displayName} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-juke-text-on-dark">
            {displayName}
          </span>{" "}
          <span className="text-juke-text-on-dark-secondary">
            @{row.username}
          </span>
        </span>
      </>
    );
  }

  if (row.kind === "channel") {
    return (
      <>
        <MiniAvatar src={row.image_url} name={row.id} square />
        <span className="min-w-0 flex-1 truncate font-medium">
          /{row.id}
          {row.name && row.name !== row.id && (
            <span className="ml-1.5 font-normal text-juke-text-on-dark-secondary">
              {row.name}
            </span>
          )}
        </span>
      </>
    );
  }

  // emoji
  return (
    <>
      <span className="text-xl leading-none" aria-hidden="true">
        {row.emoji}
      </span>
      <span className="min-w-0 flex-1 truncate">
        :{row.name.replace(/ /g, "_")}:
      </span>
    </>
  );
}

interface MiniAvatarProps {
  src: string | null | undefined;
  name: string;
  square?: boolean;
}

function MiniAvatar({ src, name, square = false }: MiniAvatarProps) {
  const base = cn(
    "h-7 w-7 shrink-0 overflow-hidden object-cover",
    square ? "rounded-md" : "rounded-full",
  );
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  if (src && /^https:\/\//i.test(src)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- popover thumbnails from varied remote hosts
      <img src={src} alt={name} referrerPolicy="no-referrer" className={base} />
    );
  }

  return (
    <div
      aria-label={name}
      className={cn(
        base,
        "flex items-center justify-center bg-juke-navy text-[11px] font-bold text-juke-text-on-dark",
      )}
    >
      {initial}
    </div>
  );
}

// Re-export for CastComposer wiring convenience.
export { rowInserted };
