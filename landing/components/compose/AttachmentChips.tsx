"use client";

/**
 * AttachmentChips — the composer's attachment preview grid (images, GIFs,
 * videos) with per-chip upload spinner / error overlay / remove button.
 *
 * Extracted verbatim from `CastComposer` so the primary segment and each
 * thread segment ({@link ThreadSegmentEditor}) render attachments identically.
 * Purely presentational: upload lifecycle and removal live in the caller.
 */

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/cn";
import type { ComposeAttachment } from "@/lib/stores/composeStore";

export interface AttachmentChipsProps {
  attachments: ComposeAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((a) => (
        <div
          key={a.id}
          className="relative h-24 w-24 overflow-hidden rounded-xl border border-juke-border bg-juke-navy/40"
        >
          {a.kind === "video" ? (
            // Muted, controls-less object-URL preview (mirrors image chip).
            // eslint-disable-next-line jsx-a11y/media-has-caption -- user's own transient local preview; no caption source
            <video
              src={a.previewUrl}
              muted
              playsInline
              preload="metadata"
              className={cn(
                "h-full w-full object-cover",
                a.status !== "uploaded" && "opacity-50",
              )}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL or Giphy preview URL
            <img
              src={a.previewUrl}
              alt={a.kind === "gif" ? "GIF preview" : (a.file?.name ?? "Attachment")}
              className={cn(
                "h-full w-full object-cover",
                a.status !== "uploaded" && "opacity-50",
              )}
            />
          )}
          {a.status === "uploading" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner
                size="sm"
                label={a.kind === "video" ? "Uploading video" : "Uploading image"}
              />
            </div>
          )}
          {a.status === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-red-950/60 p-1 text-center text-[10px] text-red-200">
              {a.error ?? "Failed"}
            </div>
          )}
          {a.kind === "gif" && a.status === "uploaded" && (
            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] font-bold uppercase tracking-wide text-white">
              GIF
            </span>
          )}
          {a.kind === "video" && a.status === "uploaded" && (
            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] font-bold uppercase tracking-wide text-white">
              Video
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            aria-label={`Remove ${a.kind === "gif" ? "GIF" : (a.file?.name ?? "attachment")}`}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-juke-navy/80 text-sm text-white hover:bg-juke-navy"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
