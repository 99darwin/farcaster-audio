"use client";

/**
 * ThreadSegmentEditor — one additional cast in a composed thread (segments
 * 2..n; segment 1 is the CastComposer's own controlled textarea).
 *
 * Each segment owns its OWN text and attachments (embeds are per-cast at the
 * protocol level), so the editor renders its own auto-growing textarea,
 * autocomplete popover, attachment chips, character counter, and a remove
 * button. All state lives in the parent CastComposer; this component is fully
 * controlled.
 *
 * Autocomplete runs in `reply` mode regardless of the composer mode: thread
 * continuation casts are protocol replies, so `/channel` is suppressed while
 * @mentions and :emoji still work.
 */

import { useCallback, useId, useRef } from "react";
import { cn } from "@/components/ui/cn";
import {
  counterColorClass,
  utf8ByteLength,
} from "@/lib/compose/composer-utils";
import type { ComposeAttachment } from "@/lib/stores/composeStore";
import { useComposerAutocomplete } from "./useComposerAutocomplete";
import { SuggestionPopover, rowInserted } from "./SuggestionPopover";
import { AttachmentChips } from "./AttachmentChips";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea";

/** Baseline height for a thread segment before auto-grow kicks in. */
const SEGMENT_MIN_ROWS = 2;

export interface ThreadSegmentEditorProps {
  /** Zero-based position within the thread (rendered one-based). */
  index: number;
  /** Total segments in the thread, for the "Cast n of m" label. */
  total: number;
  text: string;
  onTextChange: (text: string) => void;
  attachments: ComposeAttachment[];
  onRemoveAttachment: (id: string) => void;
  onRemoveSegment: () => void;
  /** Marks this segment as the target for the shared media/GIF buttons. */
  onActivate: () => void;
  /** Cmd/Ctrl+Enter — submits the whole thread. */
  onSubmitShortcut: () => void;
  maxLength: number;
  /** Grows up to this fraction of the viewport height, then scrolls. */
  maxViewportFraction: number;
  disabled: boolean;
  /** True when this segment is the target of the shared media/GIF buttons. */
  isActive: boolean;
}

export function ThreadSegmentEditor({
  index,
  total,
  text,
  onTextChange,
  attachments,
  onRemoveAttachment,
  onRemoveSegment,
  onActivate,
  onSubmitShortcut,
  maxLength,
  maxViewportFraction,
  disabled,
  isActive,
}: ThreadSegmentEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaId = useId();
  const mediaTargetHelpId = useId();

  const autocomplete = useComposerAutocomplete({
    text,
    onTextChange,
    textareaRef,
    mode: "reply",
  });

  useAutoGrowTextarea(textareaRef, text, maxViewportFraction);

  const remaining = maxLength - utf8ByteLength(text);
  const position = index + 1;

  const { handleKeyDown: handleAutocompleteKeyDown } = autocomplete;
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        onSubmitShortcut();
        return;
      }
      handleAutocompleteKeyDown(e);
    },
    [onSubmitShortcut, handleAutocompleteKeyDown],
  );

  return (
    <div className="relative mt-3 pl-5">
      {/* Thread rail connecting this segment to the one above. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-1.5 top-0 w-px bg-juke-border"
      />

      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-juke-text-on-dark-secondary">
          Cast {position} of {total}
        </span>
        <button
          type="button"
          onClick={onRemoveSegment}
          disabled={disabled}
          aria-label={`Remove cast ${position} from thread`}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-juke-navy/80 text-sm text-white hover:bg-juke-navy disabled:opacity-50"
        >
          ×
        </button>
      </div>

      <label htmlFor={textareaId} className="sr-only">
        Thread cast {position}
      </label>

      {/* Relative container so SuggestionPopover can be absolute top-full. */}
      <div className="relative">
        <textarea
          id={textareaId}
          ref={textareaRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onFocus={onActivate}
          onKeyDown={handleKeyDown}
          placeholder="Add another cast…"
          rows={SEGMENT_MIN_ROWS}
          disabled={disabled}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- a segment mounts only when the user just added it; focus follows the action
          autoFocus
          className={cn(
            "w-full resize-none rounded-xl border bg-juke-navy/40 p-3 text-juke-text-on-dark placeholder:text-juke-text-on-dark-secondary focus:border-juke-orange focus:outline-none disabled:opacity-50",
            // Persistent tint marks the media-button target even after focus
            // moves to an action button.
            isActive ? "border-juke-orange/50" : "border-juke-border",
          )}
          aria-autocomplete="list"
          aria-describedby={mediaTargetHelpId}
          aria-expanded={
            autocomplete.active !== null && autocomplete.results.length > 0
          }
        />

        <p id={mediaTargetHelpId} className="sr-only">
          While this cast is focused, the Add media and GIF buttons attach
          files to it.
        </p>

        {autocomplete.active !== null && autocomplete.results.length > 0 && (
          <SuggestionPopover
            rows={autocomplete.results}
            selectedIndex={autocomplete.selectedIndex}
            onHoverIndex={autocomplete.setSelectedIndex}
            onSelect={(row) => autocomplete.apply(rowInserted(row))}
            onDismiss={autocomplete.dismiss}
          />
        )}
      </div>

      <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />

      <div
        aria-live="polite"
        aria-label={`${remaining} bytes remaining in cast ${position}`}
        className={cn(
          "mt-1 text-right text-xs tabular-nums",
          counterColorClass(remaining),
        )}
      >
        {remaining}
      </div>
    </div>
  );
}
