/**
 * Pure, framework-free helpers for the Juke web composer.
 *
 * Extracted from `app/app/_components/ComposeModal.tsx` so both the modal and
 * the inline feed composer (and their jest tests) share one source of truth for
 * cast length limits, image caps, payload construction, and the character
 * counter colour. Nothing here touches React, the DOM, or the network — it is
 * all deterministic and unit-testable under `lib/**\/__tests__`.
 */

import type { ComposeMode, ComposeTarget } from "@/lib/stores/composeStore";

// ---------------------------------------------------------------------------
// Limits (mirror the backend cast-length + embed caps).
// ---------------------------------------------------------------------------

/** Standard Farcaster cast length, in UTF-8 bytes (the protocol unit). */
export const CAST_LENGTH_DEFAULT = 1024;
/** Pro accounts get the long-form cap. */
export const CAST_LENGTH_PRO = 10000;
/** Image embeds allowed for a standard account. */
export const MAX_IMAGES_DEFAULT = 2;
/** Image embeds allowed for a Pro account. */
export const MAX_IMAGES_PRO = 4;
/** Remaining-byte count at/under which the counter turns "warning". */
export const CHAR_WARNING_THRESHOLD = 20;

/** Max cast length for the given account tier. */
export function castMaxLength(isPro: boolean): number {
  return isPro ? CAST_LENGTH_PRO : CAST_LENGTH_DEFAULT;
}

/** Max image attachments for the given account tier. */
export function maxImageCount(isPro: boolean): number {
  return isPro ? MAX_IMAGES_PRO : MAX_IMAGES_DEFAULT;
}

/**
 * UTF-8 byte length of `text`. Farcaster enforces cast length in bytes, not
 * characters, so the counter and over-limit checks count the protocol unit.
 * Lone surrogates count as 3 bytes (the U+FFFD replacement TextEncoder
 * emits). Hand-rolled so the same code runs unchanged in jest/node and the
 * mobile app keeps an identical implementation (Hermes has no TextEncoder).
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Cast payload construction (POST /v1/feed/cast body).
// ---------------------------------------------------------------------------

/** Local shape for the `POST /v1/feed/cast` body (mirrors backend schema). */
export interface CastCreateRequest {
  text: string;
  parent?: string;
  embeds?: string[];
  quote?: { fid: number; hash: string };
}

/**
 * Build the `POST /v1/feed/cast` payload for a compose action.
 *
 * - `reply` sets `parent` to the target hash.
 * - `quote` sets `{ fid, hash }` from the target author + hash.
 * - `embeds` are included only when at least one is present (already-uploaded
 *   remote URLs — callers must filter pending/errored attachments out first).
 *
 * Key order is stable (`text` → `parent` → `quote` → `embeds`) so the
 * serialized body is byte-identical to the pre-extraction ComposeModal.
 */
export function buildCastPayload(
  text: string,
  mode: ComposeMode,
  target: ComposeTarget | null | undefined,
  embeds: string[],
): CastCreateRequest {
  const payload: CastCreateRequest = { text: text.trim() };

  if (mode === "reply" && target) {
    payload.parent = target.hash;
  }
  if (mode === "quote" && target) {
    payload.quote = { fid: target.author.fid, hash: target.hash };
  }
  if (embeds.length > 0) {
    payload.embeds = embeds;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Thread payload construction (POST /v1/feed/cast/thread body).
// ---------------------------------------------------------------------------

/** Maximum segments the thread endpoint accepts in one request. */
export const THREAD_MAX_SEGMENTS = 10;

/** One composed thread segment: its text plus already-uploaded embed URLs. */
export interface ThreadSegmentDraft {
  text: string;
  embeds: string[];
}

/** Per-cast body inside `POST /v1/feed/cast/thread`. */
export interface ThreadCastRequest {
  text: string;
  quote?: { fid: number; hash: string };
  embeds?: string[];
}

/** Local shape for the `POST /v1/feed/cast/thread` body (mirrors backend schema). */
export interface ThreadCreateRequest {
  casts: ThreadCastRequest[];
  parent?: string;
}

/**
 * Build the `POST /v1/feed/cast/thread` payload for a multi-segment compose.
 *
 * - `reply` sets the top-level `parent` to the target hash (the whole thread
 *   hangs off that cast; the backend chains the rest).
 * - `quote` sets `{ fid, hash }` on the FIRST segment only (protocol rule).
 * - Per-cast `embeds` are included only when at least one is present
 *   (already-uploaded remote URLs — callers filter pending/errored first).
 * - `channel_id` is intentionally omitted — the web composer has no channel
 *   selection.
 *
 * Key order mirrors {@link buildCastPayload} (`text` → `quote` → `embeds` per
 * cast; `casts` → `parent` at the top level) for a stable serialized body.
 *
 * Segment-count bounds (2–10) are deliberately NOT enforced here: the
 * composer gates the UI at {@link THREAD_MAX_SEGMENTS} and the backend
 * validates the request.
 */
export function buildThreadPayload(
  segments: readonly ThreadSegmentDraft[],
  mode: ComposeMode,
  target: ComposeTarget | null | undefined,
): ThreadCreateRequest {
  const casts = segments.map((segment, index) => {
    const cast: ThreadCastRequest = { text: segment.text.trim() };
    if (index === 0 && mode === "quote" && target) {
      cast.quote = { fid: target.author.fid, hash: target.hash };
    }
    if (segment.embeds.length > 0) {
      cast.embeds = segment.embeds;
    }
    return cast;
  });

  const payload: ThreadCreateRequest = { casts };
  if (mode === "reply" && target) {
    payload.parent = target.hash;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Character counter colour.
// ---------------------------------------------------------------------------

export const COUNTER_COLOR_OVER = "text-red-400";
export const COUNTER_COLOR_WARNING = "text-juke-orange";
export const COUNTER_COLOR_DEFAULT = "text-juke-text-on-dark-secondary";

/**
 * Tailwind colour class for the remaining-character counter.
 *
 * Negative `remaining` (over the limit) → red; within the warning threshold →
 * orange; otherwise the muted default.
 */
export function counterColorClass(remaining: number): string {
  if (remaining < 0) return COUNTER_COLOR_OVER;
  if (remaining <= CHAR_WARNING_THRESHOLD) return COUNTER_COLOR_WARNING;
  return COUNTER_COLOR_DEFAULT;
}

// ---------------------------------------------------------------------------
// Attachment ids.
// ---------------------------------------------------------------------------

/** Stable local id for a pending attachment (not the remote URL). */
export function newAttachmentId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
