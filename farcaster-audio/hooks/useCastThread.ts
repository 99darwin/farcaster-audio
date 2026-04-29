import { useState, useCallback } from "react";
import { fetchCastThread } from "@/services/neynar";
import type { NeynarCast, NeynarCastWithReplies } from "@/types/neynar";

interface ThreadState {
  rootCast: NeynarCast | null;
  replies: NeynarCastWithReplies[];
  isLoading: boolean;
  error: string | null;
}

function applyReaction<T extends NeynarCast>(
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
  replies: NeynarCastWithReplies[],
  hash: string,
  type: "like" | "recast",
  added: boolean,
  myFid: number,
): NeynarCastWithReplies[] {
  return replies.map((reply) => {
    let next: NeynarCastWithReplies =
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

export function useCastThread(castHash: string, viewerFid: number) {
  const [state, setState] = useState<ThreadState>({
    rootCast: null,
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
        rootCast: rootCast as NeynarCast,
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
        replies: updateReplyTree(s.replies, hash, type, added, myFid),
      }));
    },
    [],
  );

  return { ...state, fetch, updateCastReaction };
}
