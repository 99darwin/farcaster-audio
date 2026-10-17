"use client";

/**
 * ComposeModal — the single, app-wide compose surface for casts, replies, and
 * quotes on `juke.audio/app`.
 *
 * It is mounted once (in `app/app/providers.tsx`) and driven entirely by
 * `composeStore`: any screen opens it with `openCompose({ mode, target, text })`.
 * Since the extraction of {@link CastComposer}, this is a thin shell: it owns
 * the Modal chrome, the reply/quote context header, and the success toast, and
 * maps composeStore state/actions into the controlled composer's props. The
 * text-entry, upload, char-count, auth-gate, and submit logic all live in
 * `CastComposer` and are shared with the inline feed composer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Avatar } from "@/components/ui/avatar";
import {
  CastComposer,
  type PublishResult,
  type ScheduleResult,
} from "@/components/compose/CastComposer";
import {
  useComposeStore,
  type ComposeMode,
} from "@/lib/stores/composeStore";
import { useAuth } from "@/lib/auth/AuthProvider";
import type { Cast } from "@/lib/api/types";

const TOAST_DURATION_MS = 3200;

const MODE_TITLE: Record<ComposeMode, string> = {
  cast: "New cast",
  reply: "Reply",
  quote: "Quote cast",
};

export function ComposeModal() {
  const { user } = useAuth();
  const open = useComposeStore((s) => s.open);
  const mode = useComposeStore((s) => s.mode);
  const target = useComposeStore((s) => s.target);
  const text = useComposeStore((s) => s.text);
  const attachments = useComposeStore((s) => s.attachments);
  const setText = useComposeStore((s) => s.setText);
  const setAttachments = useComposeStore((s) => s.setAttachments);
  const setLastPublished = useComposeStore((s) => s.setLastPublished);
  const reset = useComposeStore((s) => s.reset);

  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  const handleClose = useCallback(() => {
    if (submitting) return;
    reset();
  }, [reset, submitting]);

  const handlePublished = useCallback(
    (result: PublishResult) => {
      // Record an optimistic Cast so mounted surfaces (thread view, home feed)
      // can reflect the publish instantly — mobile parity. Built the same way
      // as InlineReplyBox's optimistic node, minus the tree-only fields.
      if (user) {
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
          // Only URLs are known here; the extractor falls back to the URL
          // extension when the content type is unknown.
          embeds: result.embeds.map((url) => ({
            url,
            metadata: { content_type: "" },
          })),
          reactions: {
            likes_count: 0,
            recasts_count: 0,
            replies_count: 0,
            viewer_liked: false,
            viewer_recasted: false,
          },
          channel: null,
          parent_hash: result.mode === "reply" ? (target?.hash ?? null) : null,
          viewer_bookmarked: false,
        };
        setLastPublished({
          mode: result.mode,
          target,
          cast: optimistic,
          at: Date.now(),
        });
      }

      reset();
      showToast(
        (result.segmentCount ?? 1) > 1 || result.continuedThread
          ? "Thread posted"
          : result.mode === "reply"
            ? "Reply posted"
            : "Cast published",
      );
    },
    [user, target, setLastPublished, reset, showToast],
  );

  const handleScheduled = useCallback(
    (result: ScheduleResult) => {
      // Scheduling consumes the draft but deliberately does not emit an
      // optimistic feed event: the cast does not exist on Farcaster yet.
      reset();
      showToast(`Scheduled for ${result.confirmation}`);
    },
    [reset, showToast],
  );

  return (
    <>
      {/* Height-capped flex column: the CastComposer's content region scrolls
          internally while its action bar (and this header) stay reachable,
          however long the thread / attachment list grows. */}
      <Modal
        open={open}
        onClose={handleClose}
        title={MODE_TITLE[mode]}
        className="flex max-h-[85vh] flex-col"
      >
        {/* Reply / quote context header */}
        {target && (mode === "reply" || mode === "quote") && (
          <div className="mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-juke-border bg-juke-navy/40 p-3">
            <Avatar
              src={target.author.pfp_url}
              name={target.author.display_name || target.author.username}
              size="sm"
            />
            <div className="min-w-0 text-sm">
              <span className="text-juke-text-on-dark-secondary">
                {mode === "reply" ? "Replying to " : "Quoting "}
              </span>
              <span className="font-semibold text-juke-text-on-dark">
                @{target.author.username}
              </span>
            </div>
          </div>
        )}

        <CastComposer
          variant="modal"
          mode={mode}
          target={target}
          text={text}
          onTextChange={setText}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onPublished={handlePublished}
          onScheduled={handleScheduled}
          onCancel={handleClose}
          onSubmittingChange={setSubmitting}
          autoFocus
          isCancelled={() => !useComposeStore.getState().open}
        />
      </Modal>

      {/* Success toast — rendered outside the Modal so it outlives the close. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-juke-border bg-juke-surface px-4 py-2 text-sm font-medium text-juke-text-on-dark shadow-2xl"
        >
          {toast}
        </div>
      )}
    </>
  );
}
