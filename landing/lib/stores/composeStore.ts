"use client";

/**
 * Compose intent store for the Juke web app (`juke.audio/app`).
 *
 * Ported from mobile `stores/composeStore.ts`, but adapted to the web
 * composer: instead of a bare "signal" counter, this store IS the compose
 * surface's source of truth — `open`, `mode`, `target`, `text`, and pending
 * image `attachments`. Any screen (feed reply, cast thread, quote button)
 * opens the composer by calling {@link useComposeStore.getState}().openCompose
 * (or the `openCompose` selector) with an intent; the mounted `ComposeModal`
 * renders whatever the store holds.
 *
 * Client-only: it holds `File` handles and object URLs for local previews, so
 * it must never run on the server.
 */

import { create } from "zustand";
import type { Cast, FarcasterAuthor } from "@/lib/api/types";

export type ComposeMode = "cast" | "reply" | "quote";

/** The cast a reply/quote is anchored to. Unused for a top-level `cast`. */
export interface ComposeTarget {
  hash: string;
  author: FarcasterAuthor;
}

export type AttachmentStatus = "uploading" | "uploaded" | "error";

/** A pending image/video attachment and its upload lifecycle. */
export interface ComposeAttachment {
  /** Stable local id (not the remote URL). */
  id: string;
  /**
   * The local `File` object. Absent for GIF attachments sourced from Giphy
   * (those arrive as already-hosted URLs, not user-selected files).
   */
  file?: File;
  /**
   * Local object URL (`URL.createObjectURL(file)`) for image/video uploads, or
   * a Giphy preview URL for GIF attachments. Always present.
   */
  previewUrl: string;
  status: AttachmentStatus;
  /** Remote URL once uploaded; set immediately for GIFs. */
  url?: string;
  /**
   * Distinguishes uploaded images, uploaded videos, and Giphy GIFs. Defaults to
   * "image". A "video" attachment is singular and mutually exclusive with the
   * others (mobile parity).
   */
  kind?: "image" | "gif" | "video";
  /** Human-readable failure reason when `status === "error"`. */
  error?: string;
}

/** Intent passed by other screens to open the composer pre-configured. */
export interface ComposeIntent {
  mode?: ComposeMode;
  target?: ComposeTarget;
  text?: string;
}

/**
 * How long after publishing a compose event is still considered fresh enough
 * to apply as an optimistic update. Events older than this on mount are ignored
 * so a stale reply/cast never re-applies to a freshly loaded feed or thread.
 */
export const OPTIMISTIC_REPLY_WINDOW_MS = 30_000;

/**
 * The last cast/reply/quote successfully published through the shared
 * {@link ComposeModal}. Acts as a one-shot event bus so mounted surfaces (the
 * thread view, the home feed) can apply an optimistic update instantly instead
 * of waiting for a refetch. `at` is a monotonic timestamp used by consumers to
 * dedup and to ignore stale events on a fresh mount.
 */
export interface LastPublished {
  mode: ComposeMode;
  /** The cast a reply/quote was anchored to; null for a top-level cast. */
  target: ComposeTarget | null;
  /** An optimistic `Cast` built from the auth user + returned hash. */
  cast: Cast;
  at: number;
}

interface ComposeState {
  open: boolean;
  mode: ComposeMode;
  target: ComposeTarget | null;
  text: string;
  attachments: ComposeAttachment[];
  /**
   * Last successful publish. Additive event field — deliberately NOT part of
   * `INITIAL`, so `reset()`/`openCompose()` never clear it; consumers dedup via
   * its `at` timestamp.
   */
  lastPublished: LastPublished | null;

  /** Open the composer. Resets prior draft state, then applies the intent. */
  openCompose: (intent?: ComposeIntent) => void;
  /** Record a successful publish so mounted surfaces can update optimistically. */
  setLastPublished: (published: LastPublished) => void;
  setText: (text: string) => void;
  /** Replace the whole attachment list (used by the controlled CastComposer). */
  setAttachments: (attachments: ComposeAttachment[]) => void;
  addAttachment: (attachment: ComposeAttachment) => void;
  updateAttachment: (
    id: string,
    patch: Partial<Omit<ComposeAttachment, "id">>,
  ) => void;
  removeAttachment: (id: string) => void;
  /** Close the composer but keep the draft (e.g. transient dismissal). */
  close: () => void;
  /** Close and clear everything, revoking any live object URLs. */
  reset: () => void;
}

const INITIAL: Pick<
  ComposeState,
  "open" | "mode" | "target" | "text" | "attachments"
> = {
  open: false,
  mode: "cast",
  target: null,
  text: "",
  attachments: [],
};

/** Revoke object URLs so we don't leak blob handles on reset. */
function revokeAll(attachments: ComposeAttachment[]): void {
  for (const attachment of attachments) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export const useComposeStore = create<ComposeState>((set, get) => ({
  ...INITIAL,
  lastPublished: null,

  setLastPublished: (published) => set({ lastPublished: published }),

  openCompose: (intent) => {
    revokeAll(get().attachments);
    set({
      open: true,
      mode: intent?.mode ?? "cast",
      target: intent?.target ?? null,
      text: intent?.text ?? "",
      attachments: [],
    });
  },

  setText: (text) => set({ text }),

  setAttachments: (attachments) => set({ attachments }),

  addAttachment: (attachment) =>
    set((s) => ({ attachments: [...s.attachments, attachment] })),

  updateAttachment: (id, patch) =>
    set((s) => ({
      attachments: s.attachments.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    })),

  removeAttachment: (id) =>
    set((s) => {
      const target = s.attachments.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return { attachments: s.attachments.filter((a) => a.id !== id) };
    }),

  close: () => set({ open: false }),

  reset: () => {
    revokeAll(get().attachments);
    set({ ...INITIAL });
  },
}));

/**
 * Imperative helper for non-React callers (e.g. event handlers outside the
 * component tree). React components can also use the `openCompose` selector.
 */
export function openCompose(intent?: ComposeIntent): void {
  useComposeStore.getState().openCompose(intent);
}
