"use client";

/**
 * useDraftAutosave — two-tier draft persistence for the CastComposer.
 *
 * Tier 1 (always): localStorage written synchronously on every text change.
 *   Key: `juke:compose-draft:{mode}` (one slot per compose mode).
 *   This gives immediate "draft restored" UX even with no network.
 *
 * Tier 2 (modal variant only): debounced (2 s idle) server sync via
 *   /v1/drafts CRUD.  A `draft_id` ref tracks the live server draft so
 *   subsequent saves update (PATCH) rather than duplicate (POST).
 *
 * On publish / explicit clear: localStorage key is removed and the server
 * draft (if any) is deleted.  Network errors during sync are swallowed —
 * typing must never be interrupted.
 *
 * On mount: if the controlled `text` is empty, any localStorage draft is
 * restored via `onTextChange`.
 */

import {
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  createDraft,
  updateDraft,
  deleteDraft,
  type DraftPayload,
} from "@/lib/api/drafts";
import type { ComposeMode, ComposeTarget } from "@/lib/stores/composeStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseDraftAutosaveOptions {
  /** Scopes the localStorage key and the server draft payload. */
  mode: ComposeMode;
  /**
   * Controls which tier is active:
   *   "modal"  — both localStorage + server sync.
   *   "inline" — localStorage only.
   */
  variant: "modal" | "inline";
  /** Current composer text (controlled by parent). */
  text: string;
  /** Update the parent's text (used to restore a draft on mount). */
  onTextChange: (text: string) => void;
  /** The reply/quote target, used to populate the server draft payload. */
  target?: ComposeTarget | null;
}

export interface UseDraftAutosaveReturn {
  /**
   * Call after a successful publish or an explicit "discard" action.
   * Removes localStorage entry and deletes the server draft.
   */
  clearDraft: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lsKey(mode: ComposeMode): string {
  return `juke:compose-draft:${mode}`;
}

function lsRead(mode: ComposeMode): string | null {
  try {
    return localStorage.getItem(lsKey(mode));
  } catch {
    return null;
  }
}

function lsWrite(mode: ComposeMode, text: string): void {
  try {
    if (text.trim()) {
      localStorage.setItem(lsKey(mode), text);
    } else {
      localStorage.removeItem(lsKey(mode));
    }
  } catch {
    // Storage quota exceeded — silently ignore.
  }
}

function lsClear(mode: ComposeMode): void {
  try {
    localStorage.removeItem(lsKey(mode));
  } catch {
    // Silently ignore
  }
}

const SERVER_DEBOUNCE_MS = 2000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDraftAutosave({
  mode,
  variant,
  text,
  onTextChange,
  target,
}: UseDraftAutosaveOptions): UseDraftAutosaveReturn {
  const draftIdRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Refs so stable callbacks always read current values.
  const textRef = useRef(text);
  textRef.current = text;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const targetRef = useRef(target);
  targetRef.current = target;
  const variantRef = useRef(variant);
  variantRef.current = variant;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Mount: restore localStorage draft when composer starts empty ──────────
  useEffect(() => {
    // Guard: only restore when the composer is currently empty; if the parent
    // pre-populated text (e.g., a quote or a pre-filled reply) don't clobber it.
    if (textRef.current.trim()) return;

    const saved = lsRead(mode);
    if (!saved || !saved.trim()) return;

    // Clamp to a safe maximum length so that a bloated / tampered localStorage
    // value (e.g., from an unrelated XSS elsewhere on the domain) cannot cause
    // the composer to silently exceed the server-side limit.
    const MAX_SAFE_RESTORE = 2000; // well above any castMaxLength
    const clamped = saved.slice(0, MAX_SAFE_RESTORE);
    onTextChange(clamped);

    // Intentionally runs only on mount (mode/onTextChange are stable in practice).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync text changes ─────────────────────────────────────────────────────
  useEffect(() => {
    // Tier 1: always write to localStorage synchronously.
    lsWrite(mode, text);

    // Tier 2: modal only — debounced server sync.
    if (variant !== "modal") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!text.trim()) {
      // Empty text — don't create/update a server draft; do cancel pending sync.
      return;
    }

    debounceRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      const currentText = textRef.current;
      const currentMode = modeRef.current;
      const currentTarget = targetRef.current;
      if (!currentText.trim()) return;

      const payload: DraftPayload = {
        text: currentText,
        parent_cast_hash: currentTarget?.hash ?? null,
        post_to_farcaster: true,
      };

      try {
        const existingId = draftIdRef.current;
        if (existingId) {
          const updated = await updateDraft(existingId, payload);
          if (mountedRef.current) draftIdRef.current = updated.id;
        } else {
          const created = await createDraft({ ...payload, text: currentText });
          if (mountedRef.current) draftIdRef.current = created.id;
        }
      } catch {
        // Network error — silently ignore, localStorage still has the draft.
        // Reset draft_id so next sync retries a POST.
        draftIdRef.current = null;
      }
    }, SERVER_DEBOUNCE_MS);
  }, [text, mode, variant]);

  // ── clearDraft ────────────────────────────────────────────────────────────
  const clearDraft = useCallback(() => {
    const currentMode = modeRef.current;
    lsClear(currentMode);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const existingId = draftIdRef.current;
    draftIdRef.current = null;

    if (existingId && variantRef.current === "modal") {
      // Fire-and-forget — don't block the UI.
      void deleteDraft(existingId).catch(() => {
        // Silently ignore — server draft may already be gone.
      });
    }
  }, []);

  return { clearDraft };
}
