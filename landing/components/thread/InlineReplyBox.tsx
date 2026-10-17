"use client";

/**
 * InlineReplyBox — the reply composer that sits directly under the root cast on
 * a thread page. Like {@link InlineComposer} it holds its own local draft state
 * (never sharing composeStore) and, on publish, optimistically hands a freshly
 * built `CastNode` back to the page which prepends it to the reply tree.
 *
 * Auth-gated: renders nothing for anonymous/loading visitors.
 */

import { useCallback, useRef, useState } from "react";
import { CastComposer, type PublishResult } from "@/components/compose/CastComposer";
import { useAuth } from "@/lib/auth/AuthProvider";
import type { ComposeAttachment, ComposeTarget } from "@/lib/stores/composeStore";
import type { Cast } from "@/lib/api/types";
import type { CastNode } from "@/lib/thread/thread-tree";

/** Revoke object URLs so we don't leak blob handles on reset. */
function revokeAll(attachments: ComposeAttachment[]): void {
  for (const attachment of attachments) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

interface InlineReplyBoxProps {
  /** The cast being replied to (thread root). */
  root: Cast;
  /** Receives the optimistic reply node for insertion at the top of the tree. */
  onReplyPublished: (node: CastNode) => void;
}

export function InlineReplyBox({ root, onReplyPublished }: InlineReplyBoxProps) {
  const { status, user } = useAuth();

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const target: ComposeTarget = { hash: root.hash, author: root.author };

  const handlePublished = useCallback(
    (result: PublishResult) => {
      if (user) {
        const embeds = attachmentsRef.current
          .filter((a) => a.status === "uploaded" && a.url)
          .map((a) => ({
            url: a.url as string,
            // `file` is absent for hosted attachments (e.g. GIFs); the extractor
            // falls back to the URL extension when the content type is unknown.
            metadata: { content_type: a.file?.type ?? "" },
          }));

        const optimistic: CastNode = {
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
          parent_hash: root.hash,
          viewer_bookmarked: false,
          replies: [],
          authorIsSpam: false,
        };
        onReplyPublished(optimistic);
      }

      revokeAll(attachmentsRef.current);
      setText("");
      setAttachments([]);
    },
    [user, root.hash, onReplyPublished],
  );

  if (status !== "authenticated") return null;

  return (
    <div className="border-b border-juke-border px-4 py-3">
      <CastComposer
        variant="inline"
        mode="reply"
        target={target}
        text={text}
        onTextChange={setText}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        onPublished={handlePublished}
        placeholder="Post your reply…"
      />
    </div>
  );
}
