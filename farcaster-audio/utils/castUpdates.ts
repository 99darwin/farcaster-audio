import type { FarcasterCast, FarcasterParentCast } from "@/types/farcaster";

type ReactionType = "like" | "recast";

/** Whether a reply's `parent_cast` is a full cast (renderable as a post). */
export function isFullCast(
  parent: FarcasterParentCast | FarcasterCast | null | undefined,
): parent is FarcasterCast {
  return !!parent && "reactions" in parent && !!parent.reactions;
}

/** The full parent rendered above `cast` in a feed conversation, if any. */
export function conversationParent(cast: FarcasterCast): FarcasterCast | null {
  return isFullCast(cast.parent_cast) ? cast.parent_cast : null;
}

/**
 * Apply `update` to every cast in `casts` with `hash` — top-level casts and
 * full parents rendered above them.
 */
function mapCastsByHash(
  casts: FarcasterCast[],
  hash: string,
  update: (cast: FarcasterCast) => FarcasterCast,
): FarcasterCast[] {
  return casts.map((cast) => {
    const parent = conversationParent(cast);
    const next = cast.hash === hash ? update(cast) : cast;
    if (parent?.hash !== hash) return next;
    return { ...next, parent_cast: update(parent) };
  });
}

function withReaction(
  cast: FarcasterCast,
  type: ReactionType,
  added: boolean,
  myFid: number,
): FarcasterCast {
  const reactions = { ...cast.reactions };
  const viewerContext = { liked: false, recasted: false, ...cast.viewer_context };
  if (type === "like") {
    reactions.likes_count = added
      ? reactions.likes_count + 1
      : Math.max(0, reactions.likes_count - 1);
    reactions.likes = added
      ? [...reactions.likes, { fid: myFid }]
      : reactions.likes.filter((l) => l.fid !== myFid);
    viewerContext.liked = added;
  } else {
    reactions.recasts_count = added
      ? reactions.recasts_count + 1
      : Math.max(0, reactions.recasts_count - 1);
    reactions.recasts = added
      ? [...reactions.recasts, { fid: myFid }]
      : reactions.recasts.filter((r) => r.fid !== myFid);
    viewerContext.recasted = added;
  }
  return { ...cast, reactions, viewer_context: viewerContext };
}

/** Optimistically set the viewer's like/recast on the cast with `hash`. */
export function updateCastReaction(
  casts: FarcasterCast[],
  {
    hash,
    type,
    added,
    myFid,
  }: { hash: string; type: ReactionType; added: boolean; myFid: number },
): FarcasterCast[] {
  return mapCastsByHash(casts, hash, (cast) =>
    withReaction(cast, type, added, myFid),
  );
}

/** Optimistically set the viewer's bookmark on the cast with `hash`. */
export function updateCastBookmark(
  casts: FarcasterCast[],
  hash: string,
  bookmarked: boolean,
): FarcasterCast[] {
  return mapCastsByHash(casts, hash, (cast) => ({
    ...cast,
    viewer_context: {
      liked: false,
      recasted: false,
      ...cast.viewer_context,
      bookmarked,
    },
  }));
}

/** Drop casts by `fid`, and conversations whose parent they wrote. */
export function removeCastsByAuthor(
  casts: FarcasterCast[],
  fid: number,
): FarcasterCast[] {
  return casts.filter(
    (cast) =>
      cast.author.fid !== fid && conversationParent(cast)?.author.fid !== fid,
  );
}

function shownHashes(cast: FarcasterCast): string[] {
  const parent = conversationParent(cast);
  return parent ? [cast.hash, parent.hash] : [cast.hash];
}

/**
 * Append a feed page, skipping casts already on screen — either as a post or
 * as the parent of a conversation — so a thread never renders twice.
 */
export function appendUniqueCasts(
  existing: FarcasterCast[],
  incoming: FarcasterCast[],
): FarcasterCast[] {
  const seen = new Set(existing.flatMap(shownHashes));
  const appended: FarcasterCast[] = [];
  for (const cast of incoming) {
    const hashes = shownHashes(cast);
    if (hashes.some((hash) => seen.has(hash))) continue;
    hashes.forEach((hash) => seen.add(hash));
    appended.push(cast);
  }
  return [...existing, ...appended];
}
