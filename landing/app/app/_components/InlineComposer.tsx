"use client";

/**
 * InlineComposer — the top-of-feed quick composer on the Home timeline.
 *
 * Unlike {@link ComposeModal}, this holds its own local draft state (text +
 * attachments) rather than sharing composeStore, so opening the modal never
 * disturbs an in-progress inline draft and vice-versa. It is auth-gated
 * (renders nothing for anonymous/loading visitors) and, on publish, optimistically
 * prepends the new cast to the feed via `feedStore.prependCast()`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CastComposer,
  type PublishResult,
  type ScheduleResult,
} from "@/components/compose/CastComposer";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useFeedStore } from "@/lib/stores/feedStore";
import type { ComposeAttachment } from "@/lib/stores/composeStore";
import type { Cast } from "@/lib/api/types";

/** Revoke object URLs so we don't leak blob handles on reset. */
function revokeAll(attachments: ComposeAttachment[]): void {
  for (const attachment of attachments) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function InlineComposer() {
  const { status, user } = useAuth();
  const prependCast = useFeedStore((s) => s.prependCast);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest attachments for the publish handler (avoids a stale closure).
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const handleScheduled = useCallback((result: ScheduleResult) => {
    revokeAll(attachmentsRef.current);
    setText("");
    setAttachments([]);
    setToast(`Scheduled for ${result.confirmation}`);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4_000);
  }, []);

  const handlePublished = useCallback(
    (result: PublishResult) => {
      if (user) {
        // Shape embeds as `{ url, metadata }` records with the real content
        // type so CastCard's extractor renders the attached images optimistically
        // (it ignores bare URL strings). Falls back cleanly to text-only.
        const embeds = attachmentsRef.current
          .filter((a) => a.status === "uploaded" && a.url)
          .map((a) => ({
            url: a.url as string,
            metadata: { content_type: a.file?.type ?? "image/gif" },
          }));

        const optimistic: Cast = {
          hash: result.hash ?? `local-${Date.now()}`,
          author: {
            fid: user.fid,
            username: user.username,
            display_name: user.display_name,
            pfp_url: user.pfp_url,
          },
          text: result.text,
          timestamp: new Date().toISOString(),
          embeds,
          reactions: {
            likes_count: 0,
            recasts_count: 0,
            replies_count: 0,
            viewer_liked: false,
            viewer_recasted: false,
          },
          channel: null,
          parent_hash: null,
          viewer_bookmarked: false,
        };
        prependCast(optimistic);
      }

      // Reset the draft, revoking any live object URLs first.
      revokeAll(attachmentsRef.current);
      setText("");
      setAttachments([]);
    },
    [user, prependCast],
  );

  // Only authenticated users can post; hide the box entirely otherwise.
  if (status !== "authenticated") return null;

  return (
    <div className="border-b border-juke-border px-4 py-3">
      <CastComposer
        variant="inline"
        mode="cast"
        text={text}
        onTextChange={setText}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        onPublished={handlePublished}
        onScheduled={handleScheduled}
        placeholder="What's happening?"
      />
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-juke-border bg-juke-surface px-4 py-2 text-sm font-medium text-juke-text-on-dark shadow-2xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
