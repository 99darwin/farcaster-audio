"use client";

/**
 * Thread replies, laid out the way X shows a conversation.
 *
 * Each top-level reply is a group: one reply path shown flat (no indentation),
 * joined avatar-to-avatar by a thread line, with groups separated by a rule.
 * Where the tree branches or runs past `MAX_INLINE_CHAIN`, a "Show more
 * replies" row opens that cast's own thread (see `selectReplyChain`). A
 * deep-linked `focusHash` is always kept on the inline path. Spam replies are
 * hoisted into a dismissible footer ("See N probable slop replies").
 *
 * All optimistic reaction/bookmark state lives on the thread page; this
 * component is presentational and forwards `Cast` to the page's handlers.
 */

import { useMemo, useState } from "react";
import { CastCard } from "@/components/ui/cast-card";
import { selectReplyChain, type CastNode } from "@/lib/thread/thread-tree";
import type { Cast } from "@/lib/api/types";

interface NodeHandlers {
  onLike: (cast: Cast) => void;
  onRecast: (cast: Cast) => void;
  onBookmark: (cast: Cast) => void;
  onReply: (cast: Cast) => void;
  onQuote: (cast: Cast) => void;
  onPress: (cast: Cast) => void;
  /**
   * Delete a reply. Only shown on CastCards where the reply author matches
   * `userFid`; pass both together to enable per-cast ownership gating.
   */
  onDelete?: (cast: Cast) => void;
  /** The authenticated user's FID — used to gate the delete menu. */
  userFid?: number;
}

/**
 * Optional keyboard-navigation hooks. j/k navigation covers root + top-level
 * replies only, so row props land on each group's wrapper.
 */
interface KeyboardNavProps {
  /** Hash of the reply currently selected by the feed focus ring, if any. */
  keyboardFocusHash?: string;
  /** Props (e.g. `data-feed-index`) to spread on a top-level reply's wrapper. */
  getRowProps?: (hash: string) => Record<string, unknown>;
}

interface ThreadedRepliesProps extends NodeHandlers, KeyboardNavProps {
  replies: CastNode[];
  focusHash?: string;
}

function ReplyGroup({
  reply,
  focusHash,
  keyboardFocusHash,
  getRowProps,
  ...handlers
}: NodeHandlers &
  KeyboardNavProps & {
    reply: CastNode;
    focusHash?: string;
  }) {
  const { chain, continueFrom } = useMemo(
    () => selectReplyChain(reply, { focusHash }),
    [reply, focusHash],
  );

  return (
    <div
      className="border-b border-juke-border"
      {...(getRowProps?.(reply.hash) ?? {})}
    >
      {chain.map((node, index) => (
        <div key={node.hash} id={`cast-${node.hash}`}>
          <CastCard
            cast={node}
            detail
            connectAbove={index > 0}
            connectBelow={index < chain.length - 1 || continueFrom !== null}
            focused={node.hash === focusHash || node.hash === keyboardFocusHash}
            onLike={handlers.onLike}
            onRecast={handlers.onRecast}
            onBookmark={handlers.onBookmark}
            onReply={handlers.onReply}
            onQuote={handlers.onQuote}
            onPress={handlers.onPress}
            onDelete={
              handlers.onDelete &&
              handlers.userFid !== undefined &&
              node.author.fid === handlers.userFid
                ? handlers.onDelete
                : undefined
            }
          />
        </div>
      ))}
      {continueFrom && (
        <ShowMoreReplies onClick={() => handlers.onPress(continueFrom)} />
      )}
    </div>
  );
}

/** X's "Show replies" row: a dotted continuation of the thread line. */
function ShowMoreReplies({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 px-4 pb-3 text-left text-[15px] text-juke-purple hover:underline"
    >
      <span aria-hidden className="flex w-10 shrink-0 flex-col items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-0.5 w-0.5 rounded-full bg-juke-text-on-dark-tertiary"
          />
        ))}
      </span>
      Show more replies
    </button>
  );
}

export function ThreadedReplies({
  replies,
  focusHash,
  keyboardFocusHash,
  getRowProps,
  ...handlers
}: ThreadedRepliesProps) {
  return (
    <div>
      {replies.map((reply) => (
        <ReplyGroup
          key={reply.hash}
          reply={reply}
          focusHash={focusHash}
          keyboardFocusHash={keyboardFocusHash}
          getRowProps={getRowProps}
          {...handlers}
        />
      ))}
    </div>
  );
}

interface ThreadSlopFooterProps extends NodeHandlers {
  spam: CastNode[];
  focusHash?: string;
}

export function ThreadSlopFooter({
  spam,
  focusHash,
  ...handlers
}: ThreadSlopFooterProps) {
  const [revealed, setRevealed] = useState(false);

  if (spam.length === 0) return null;

  if (!revealed) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className="flex min-h-11 w-full items-center px-4 py-3 text-sm italic text-juke-text-on-dark-secondary hover:text-juke-text-on-dark"
      >
        See {spam.length} probable slop {spam.length === 1 ? "reply" : "replies"}
      </button>
    );
  }

  return (
    <div className="opacity-50">
      {spam.map((reply) => (
        <ReplyGroup
          key={reply.hash}
          reply={reply}
          focusHash={focusHash}
          {...handlers}
        />
      ))}
    </div>
  );
}
