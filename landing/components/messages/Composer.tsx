"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { MAX_MESSAGE_LENGTH, previewMetadata } from "@/lib/api/messages";
import type { Message, MessageUrlEmbed } from "@/lib/api/messages.types";
import { userLabel } from "@/lib/messages/format";
import { tokenizeCast } from "@/lib/text/tokenize-cast";
import {
  INLINE_TEXTAREA_MAX_VIEWPORT_FRACTION,
  useAutoGrowTextarea,
} from "@/components/compose/useAutoGrowTextarea";
import { cn } from "@/components/ui/cn";
import { UrlEmbedCard } from "./MessageEmbeds";
import { CloseIcon, ReplyIcon, SendIcon } from "./icons";

/** Show the character counter once this close to the limit. */
const COUNTER_VISIBLE_FROM = MAX_MESSAGE_LENGTH - 200;
/** Wait for typing to pause before asking for a link preview. */
const LINK_PREVIEW_DEBOUNCE_MS = 600;
/** `keyCode` some browsers report for keystrokes an IME is still composing. */
const IME_COMPOSING_KEY_CODE = 229;

export interface ComposerHandle {
  focus: () => void;
}

export interface ComposerSubmit {
  text: string;
  processMetadata: boolean;
}

export interface ComposerProps {
  draft: string;
  onDraftChange: (text: string) => void;
  replyTo: Message | null;
  onCancelReply: () => void;
  onSubmit: (input: ComposerSubmit) => void;
  /** ArrowUp in an empty composer moves focus into the message list. */
  onFocusLastMessage: () => void;
  disabledReason?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  ref?: Ref<ComposerHandle>;
}

function firstUrl(text: string): string | null {
  for (const segment of tokenizeCast(text)) {
    if (segment.type === "url") return segment.href;
  }
  return null;
}

/**
 * Message composer. Enter sends, Shift+Enter inserts a newline (IME
 * composition is respected), Escape cancels the reply, ArrowUp on an empty
 * composer focuses the newest message. Shows a debounced link preview for the
 * first URL, which the sender can dismiss (sent with `process_metadata: false`).
 */
export function Composer({
  draft,
  onDraftChange,
  replyTo,
  onCancelReply,
  onSubmit,
  onFocusLastMessage,
  disabledReason = null,
  placeholder = "Message",
  autoFocus = false,
  ref,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<{ url: string; embed: MessageUrlEmbed } | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);
  useAutoGrowTextarea(textareaRef, draft, INLINE_TEXTAREA_MAX_VIEWPORT_FRACTION);

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Focus the composer when a reply target is picked.
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus({ preventScroll: true });
  }, [replyTo]);

  const url = useMemo(() => firstUrl(draft), [draft]);
  useEffect(() => {
    if (!url || url === dismissedUrl) {
      setPreview(null);
      return;
    }
    if (preview?.url === url) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewMetadata(draft, controller.signal)
        .then((metadata) => {
          const embed = metadata.urls[0];
          setPreview(embed ? { url, embed } : null);
        })
        .catch(() => {
          // Previews are best-effort.
        });
    }, LINK_PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // Only re-run when the detected URL changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, dismissedUrl]);

  const length = draft.length;
  const isTooLong = length > MAX_MESSAGE_LENGTH;
  const isDisabled = Boolean(disabledReason);
  const canSend = !isDisabled && draft.trim().length > 0 && !isTooLong;

  const submit = () => {
    if (!canSend) return;
    onSubmit({ text: draft, processMetadata: !(url && url === dismissedUrl) });
    setPreview(null);
    setDismissedUrl(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === IME_COMPOSING_KEY_CODE) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && replyTo) {
      event.preventDefault();
      event.stopPropagation();
      onCancelReply();
    } else if (event.key === "ArrowUp" && draft.length === 0) {
      event.preventDefault();
      onFocusLastMessage();
    }
  };

  if (isDisabled) {
    return (
      <div className="border-t border-juke-border px-4 py-4 text-center text-sm text-juke-text-on-dark-secondary">
        {disabledReason}
      </div>
    );
  }

  return (
    <div className="border-t border-juke-border bg-juke-navy px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 md:px-4">
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-juke-surface px-3 py-2">
          <ReplyIcon className="h-4 w-4 shrink-0 text-juke-purple" />
          <div className="min-w-0 flex-1 border-l-2 border-juke-purple pl-2">
            <p className="truncate text-xs font-semibold text-juke-purple">
              Replying to {userLabel(replyTo.sender)}
            </p>
            <p className="truncate text-xs text-juke-text-on-dark-secondary">
              {replyTo.text || "Attachment"}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply (Escape)"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary hover:bg-juke-border hover:text-juke-text-on-dark"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {preview && (
        <div className="relative mb-2 w-fit max-w-full">
          <UrlEmbedCard embed={preview.embed} />
          <button
            type="button"
            onClick={() => setDismissedUrl(preview.url)}
            aria-label="Remove link preview"
            className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-juke-navy/90 text-juke-text-on-dark hover:bg-juke-navy"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={placeholder}
            aria-label="Message"
            aria-describedby={length >= COUNTER_VISIBLE_FROM ? "composer-counter" : undefined}
            aria-invalid={isTooLong || undefined}
            className={cn(
              "block w-full resize-none rounded-2xl border bg-juke-surface px-4 py-2.5 text-[15px] leading-snug text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:outline-none",
              isTooLong ? "border-red-400" : "border-juke-border focus:border-juke-orange",
            )}
          />
          {length >= COUNTER_VISIBLE_FROM && (
            <span
              id="composer-counter"
              className={cn(
                "pointer-events-none absolute bottom-1 right-3 text-[11px] tabular-nums",
                isTooLong ? "text-red-300" : "text-juke-text-on-dark-tertiary",
              )}
            >
              {length}/{MAX_MESSAGE_LENGTH}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send message"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-juke-orange text-white transition-colors hover:bg-juke-orange-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SendIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
