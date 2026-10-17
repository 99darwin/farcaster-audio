/**
 * Pure conversation-tree helpers for the web thread view (Stream C).
 *
 * Ported from mobile `components/feed/ThreadedReplies.tsx` and
 * `hooks/useCastThread.ts` (`updateReplyTree`). The web `Cast` shape is flat, so
 * we layer a recursive `replies` array (and a memoised `authorIsSpam` flag) on
 * top of it to form a `CastNode`. Every mutation helper preserves **structural
 * sharing**: subtrees that don't change keep their object (and array) identity,
 * so React can skip re-rendering untouched branches.
 *
 * This module is intentionally free of React/DOM so it can be unit-tested in the
 * node jest env under `lib/**\/__tests__`.
 */

import { normalizeCast, type RawCast } from "@/lib/api/users";
import type { Cast } from "@/lib/api/types";

/** A cast plus its nested reply subtree and a viewer-spam hint. */
export type CastNode = Cast & {
  replies: CastNode[];
  authorIsSpam?: boolean;
};

/**
 * Recursively adapt a raw v2 conversation cast (with `direct_replies`) into
 * a `CastNode`, reusing the canonical `normalizeCast` mapper for the flat
 * fields and surfacing `author.is_spam` as `authorIsSpam`.
 */
export function normalizeCastNode(raw: RawCast): CastNode {
  return {
    ...normalizeCast(raw),
    replies: (raw.direct_replies ?? []).map(normalizeCastNode),
    authorIsSpam: raw.author?.is_spam === true,
  };
}

/**
 * Apply `fn` to the node whose `hash` matches, anywhere in the tree, returning a
 * new forest that shares identity with the input for every untouched branch
 * (and returns the exact same array when nothing changed at all).
 */
export function updateTree(
  nodes: CastNode[],
  hash: string,
  fn: (node: CastNode) => CastNode,
): CastNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    let updated = node.hash === hash ? fn(node) : node;
    if (updated.replies.length > 0) {
      const updatedChildren = updateTree(updated.replies, hash, fn);
      if (updatedChildren !== updated.replies) {
        updated = { ...updated, replies: updatedChildren };
      }
    }
    if (updated !== node) changed = true;
    return updated;
  });
  return changed ? next : nodes;
}

/**
 * Split a forest into `clean` (kept, spam children pruned) and `spam` (authors
 * flagged `authorIsSpam`, hoisted to a flat list). A spam node takes its whole
 * subtree with it; a clean node keeps only its clean descendants.
 */
export function partitionSpamFromTree(nodes: CastNode[]): {
  clean: CastNode[];
  spam: CastNode[];
} {
  const clean: CastNode[] = [];
  const spam: CastNode[] = [];
  for (const node of nodes) {
    if (node.authorIsSpam === true) {
      spam.push(node);
      continue;
    }
    if (node.replies.length === 0) {
      clean.push(node);
      continue;
    }
    const childResult = partitionSpamFromTree(node.replies);
    clean.push({ ...node, replies: childResult.clean });
    spam.push(...childResult.spam);
  }
  return { clean, spam };
}

/**
 * Remove the node whose `hash` matches from anywhere in the forest, preserving
 * structural sharing for all untouched branches (same identity when nothing
 * changed). A matched node is dropped along with its entire subtree.
 */
export function removeFromTree(
  nodes: CastNode[],
  hash: string,
): CastNode[] {
  let changed = false;
  const next: CastNode[] = [];
  for (const node of nodes) {
    if (node.hash === hash) {
      changed = true;
      continue; // drop this node and its subtree
    }
    if (node.replies.length > 0) {
      const updatedChildren = removeFromTree(node.replies, hash);
      if (updatedChildren !== node.replies) {
        next.push({ ...node, replies: updatedChildren });
        changed = true;
        continue;
      }
    }
    next.push(node);
  }
  return changed ? next : nodes;
}

/**
 * Insert `node` as the first child of the node matching `parentHash`, anywhere
 * in the forest, and optimistically bump that parent's `replies_count`.
 * Preserves structural sharing for untouched branches.
 *
 * Idempotent: if a cast with `node.hash` is already present anywhere in the
 * forest (e.g. a duplicate publish event), the input is returned unchanged.
 * Returns the input array unchanged when `parentHash` is not found.
 */
export function insertReply(
  nodes: CastNode[],
  parentHash: string,
  node: CastNode,
): CastNode[] {
  // Dedup guard — never insert the same reply twice.
  if (nodes.some((n) => subtreeContainsHash(n, node.hash))) return nodes;

  function attach(list: CastNode[]): CastNode[] {
    let changed = false;
    const next = list.map((n) => {
      if (n.hash === parentHash) {
        changed = true;
        return {
          ...n,
          replies: [node, ...n.replies],
          reactions: {
            ...n.reactions,
            replies_count: n.reactions.replies_count + 1,
          },
        };
      }
      if (n.replies.length > 0) {
        const updatedChildren = attach(n.replies);
        if (updatedChildren !== n.replies) {
          changed = true;
          return { ...n, replies: updatedChildren };
        }
      }
      return n;
    });
    return changed ? next : list;
  }

  return attach(nodes);
}

/**
 * Returns true if `hash` matches `node.hash` or any cast in its nested
 * `replies` subtree.
 */
export function subtreeContainsHash(node: CastNode, hash: string): boolean {
  if (node.hash === hash) return true;
  for (const child of node.replies) {
    if (subtreeContainsHash(child, hash)) return true;
  }
  return false;
}

/**
 * Returns the index of the top-level node whose subtree contains `hash`, or -1
 * if no branch contains it.
 */
export function findTopLevelIndexContaining(
  nodes: CastNode[],
  hash: string,
): number {
  for (let i = 0; i < nodes.length; i++) {
    if (subtreeContainsHash(nodes[i], hash)) return i;
  }
  return -1;
}

/** Casts shown inline per reply group before "Show more replies" (X-style). */
export const MAX_INLINE_CHAIN = 3;

export interface ReplyChain {
  /** Casts rendered inline top-down, each a reply to the one before. */
  chain: CastNode[];
  /**
   * Topmost chain cast with replies left out (a branch, or past the cap);
   * "Show more replies" opens its thread. `null` when nothing is hidden.
   */
  continueFrom: CastNode | null;
}

/**
 * Pick the single reply path a group shows inline, the way X flattens a
 * conversation: follow the first reply at each level (or the branch holding
 * `focusHash`, which is always shown in full regardless of `maxLength`).
 */
export function selectReplyChain(
  root: CastNode,
  {
    focusHash,
    maxLength = MAX_INLINE_CHAIN,
  }: { focusHash?: string; maxLength?: number } = {},
): ReplyChain {
  const chain = [root];
  let continueFrom: CastNode | null = null;
  let node = root;
  while (node.replies.length > 0) {
    const focusBranch = focusHash
      ? node.replies.find((reply) => subtreeContainsHash(reply, focusHash))
      : undefined;
    if (chain.length >= maxLength && !focusBranch) {
      continueFrom ??= node;
      break;
    }
    if (node.replies.length > 1) continueFrom ??= node;
    node = focusBranch ?? node.replies[0];
    chain.push(node);
  }
  return { chain, continueFrom };
}
