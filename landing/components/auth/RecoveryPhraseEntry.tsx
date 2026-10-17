"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { countRecoveryPhraseWords } from "@/lib/auth/protocolLogin";
import {
  getRecoveryPhraseFieldAttributes,
  supportsTextMasking,
} from "@/lib/auth/recoveryPhraseField";

const VALID_PHRASE_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export const PRIMARY_BUTTON =
  "inline-flex h-11 w-full items-center justify-center rounded-full bg-juke-orange px-5 text-sm font-semibold text-white transition hover:bg-juke-orange-hover disabled:cursor-not-allowed disabled:opacity-50";
export const SECONDARY_BUTTON =
  "inline-flex h-10 w-full items-center justify-center rounded-full border border-white/15 px-5 text-sm font-medium text-juke-text-on-dark-secondary transition hover:border-white/30 hover:text-white";
export const INPUT =
  "mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 text-sm text-white outline-none transition placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange";

export interface RecoveryPhraseEntryProps {
  title: ReactNode;
  description: ReactNode;
  submitLabel: string;
  /** Non-null while working: disables the field and replaces the submit label. */
  busyLabel: string | null;
  footer?: ReactNode;
  onSubmit: (takeRecoveryPhrase: () => string) => void;
  onCancel: () => void;
}

/**
 * One-time recovery-phrase entry. The phrase lives only in this input's DOM
 * value (uncontrolled — never React state, a store or storage). It is read
 * once by `take()` at signing time, which also wipes the field, and the field
 * is wiped again on unmount. Deliberately not a `<form>` or password field, so
 * browser password managers never offer to save it; see
 * `recoveryPhraseField.ts`.
 */
export function RecoveryPhraseEntry({
  title,
  description,
  submitLabel,
  busyLabel,
  footer,
  onSubmit,
  onCancel,
}: RecoveryPhraseEntryProps) {
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [isRevealed, setIsRevealed] = useState(false);
  const [canMask, setCanMask] = useState(true);
  const isBusy = busyLabel !== null;
  const canSubmit = !isBusy && VALID_PHRASE_WORD_COUNTS.has(wordCount);
  const { className: maskClass, ...fieldAttributes } =
    getRecoveryPhraseFieldAttributes(isRevealed);

  useEffect(() => {
    setCanMask(supportsTextMasking());
    const field = fieldRef.current;
    return () => {
      if (field) field.value = "";
    };
  }, []);

  function take(): string {
    const field = fieldRef.current;
    const phrase = field?.value ?? "";
    if (field) field.value = "";
    setWordCount(0);
    return phrase;
  }

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit(take);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    handleSubmit();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 text-sm text-juke-text-on-dark-secondary">
        <p className="font-medium text-juke-text-on-dark">{title}</p>
        <p>{description}</p>
      </div>

      <label className="block">
        <span className="sr-only">Recovery phrase</span>
        <input
          ref={fieldRef}
          {...fieldAttributes}
          disabled={isBusy}
          onInput={(e) =>
            setWordCount(countRecoveryPhraseWords(e.currentTarget.value))
          }
          onKeyDown={handleKeyDown}
          placeholder="word1 word2 word3 …"
          className={`${INPUT} font-mono ${maskClass}`}
        />
      </label>

      <div className="flex items-center justify-between text-xs text-juke-text-on-dark-tertiary">
        <span>{wordCount} words</span>
        {canMask ? (
          <button
            type="button"
            onClick={() => setIsRevealed((value) => !value)}
            className="underline-offset-2 hover:underline"
          >
            {isRevealed ? "Hide" : "Show"}
          </button>
        ) : (
          <span>This browser can&apos;t mask the phrase. Check no one can see your screen.</span>
        )}
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className={PRIMARY_BUTTON}
      >
        {busyLabel ?? submitLabel}
      </button>
      <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
        Cancel
      </button>
      {footer && (
        <p className="text-center text-xs text-juke-text-on-dark-tertiary">{footer}</p>
      )}
    </div>
  );
}
