/**
 * X-style reply flattening for the thread screen. Pure (no React) so it can be
 * unit-tested; mirrors `selectReplyChain` in the web app's thread-tree.
 */

import type { FarcasterCastWithReplies } from "@/types/farcaster";

/** Casts shown inline per reply group before "Show more replies". */
export const MAX_INLINE_CHAIN = 3;

export interface ReplyChain {
  /** Casts rendered inline top-down, each a reply to the one before. */
  chain: FarcasterCastWithReplies[];
  /**
   * Topmost chain cast with replies left out (a branch, or past the cap);
   * "Show more replies" opens its thread. `null` when nothing is hidden.
   */
  continueFrom: FarcasterCastWithReplies | null;
}

/**
 * Returns true if `hash` matches `reply.hash` or any cast in its nested
 * `direct_replies` subtree.
 */
export function subtreeContainsHash(
  reply: FarcasterCastWithReplies,
  hash: string,
): boolean {
  if (reply.hash === hash) return true;
  return (reply.direct_replies ?? []).some((child) =>
    subtreeContainsHash(child, hash),
  );
}

/**
 * Pick the single reply path a group shows inline: follow the first reply at
 * each level, or the branch holding `focusHash`, which is always shown in
 * full regardless of `maxLength`.
 */
export function selectReplyChain(
  root: FarcasterCastWithReplies,
  {
    focusHash,
    maxLength = MAX_INLINE_CHAIN,
  }: { focusHash?: string; maxLength?: number } = {},
): ReplyChain {
  const chain = [root];
  let continueFrom: FarcasterCastWithReplies | null = null;
  let node = root;
  while ((node.direct_replies ?? []).length > 0) {
    const children = node.direct_replies ?? [];
    const focusBranch = focusHash
      ? children.find((reply) => subtreeContainsHash(reply, focusHash))
      : undefined;
    if (chain.length >= maxLength && !focusBranch) {
      continueFrom ??= node;
      break;
    }
    if (children.length > 1) continueFrom ??= node;
    node = focusBranch ?? children[0];
    chain.push(node);
  }
  return { chain, continueFrom };
}
