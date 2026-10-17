import { useState, useCallback } from "react";
import { fetchCastThread } from "@/services/feed";
import type {
  FarcasterCast,
  FarcasterCastWithReplies,
} from "@/types/farcaster";

interface ThreadState {
  rootCast: FarcasterCast | null;
  /** Casts above `rootCast` in its conversation, oldest first. */
  ancestors: FarcasterCast[];
  replies: FarcasterCastWithReplies[];
  isLoading: boolean;
  error: string | null;
}

function applyReaction<T extends FarcasterCast>(
  cast: T,
  type: "like" | "recast",
  added: boolean,
  myFid: number,
): T {
  const reactions = { ...cast.reactions };
  const viewerContext = {
    liked: false,
    recasted: false,
    ...cast.viewer_context,
  };
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

function updateReplyTree(
  replies: FarcasterCastWithReplies[],
  hash: string,
  type: "like" | "recast",
  added: boolean,
  myFid: number,
): FarcasterCastWithReplies[] {
  return replies.map((reply) => {
    let next: FarcasterCastWithReplies =
      reply.hash === hash ? applyReaction(reply, type, added, myFid) : reply;
    if (next.direct_replies?.length) {
      const updatedChildren = updateReplyTree(
        next.direct_replies,
        hash,
        type,
        added,
        myFid,
      );
      if (updatedChildren !== next.direct_replies) {
        next = { ...next, direct_replies: updatedChildren };
      }
    }
    return next;
  });
}

function applyBookmark<T extends FarcasterCast>(
  cast: T,
  bookmarked: boolean,
): T {
  return {
    ...cast,
    viewer_context: {
      liked: false,
      recasted: false,
      ...cast.viewer_context,
      bookmarked,
    },
  };
}

function updateReplyTreeBookmark(
  replies: FarcasterCastWithReplies[],
  hash: string,
  bookmarked: boolean,
): FarcasterCastWithReplies[] {
  return replies.map((reply) => {
    let next: FarcasterCastWithReplies =
      reply.hash === hash ? applyBookmark(reply, bookmarked) : reply;
    if (next.direct_replies?.length) {
      next = {
        ...next,
        direct_replies: updateReplyTreeBookmark(
          next.direct_replies,
          hash,
          bookmarked,
        ),
      };
    }
    return next;
  });
}

export function useCastThread(castHash: string, viewerFid: number) {
  const [state, setState] = useState<ThreadState>({
    rootCast: null,
    ancestors: [],
    replies: [],
    isLoading: false,
    error: null,
  });

  const fetch = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const data = await fetchCastThread(castHash, viewerFid);
      const conversation = data.conversation?.cast;
      if (!conversation) {
        setState((s) => ({ ...s, isLoading: false, error: "Cast not found" }));
        return;
      }
      const replies = conversation.direct_replies ?? [];
      // Strip direct_replies from root to avoid duplication
      const { direct_replies: _, ...rootCast } = conversation;
      setState({
        rootCast: rootCast as FarcasterCast,
        ancestors: data.conversation.chronological_parent_casts ?? [],
        replies,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load thread",
      }));
    }
  }, [castHash, viewerFid]);

  const updateCastReaction = useCallback(
    (hash: string, type: "like" | "recast", added: boolean, myFid: number) => {
      setState((s) => ({
        ...s,
        rootCast:
          s.rootCast && s.rootCast.hash === hash
            ? applyReaction(s.rootCast, type, added, myFid)
            : s.rootCast,
        ancestors: s.ancestors.map((cast) =>
          cast.hash === hash ? applyReaction(cast, type, added, myFid) : cast,
        ),
        replies: updateReplyTree(s.replies, hash, type, added, myFid),
      }));
    },
    [],
  );

  const updateCastBookmark = useCallback((hash: string, bookmarked: boolean) => {
    setState((s) => ({
      ...s,
      rootCast:
        s.rootCast && s.rootCast.hash === hash
          ? applyBookmark(s.rootCast, bookmarked)
          : s.rootCast,
      ancestors: s.ancestors.map((cast) =>
        cast.hash === hash ? applyBookmark(cast, bookmarked) : cast,
      ),
      replies: updateReplyTreeBookmark(s.replies, hash, bookmarked),
    }));
  }, []);

  return { ...state, fetch, updateCastReaction, updateCastBookmark };
}
