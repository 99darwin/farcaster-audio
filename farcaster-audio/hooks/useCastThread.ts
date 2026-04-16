import { useState, useCallback } from "react";
import { fetchAncestorChain, fetchCastThread } from "@/services/neynar";
import type { NeynarCast, NeynarCastWithReplies } from "@/types/neynar";

interface ThreadState {
  rootCast: NeynarCast | null;
  ancestors: NeynarCast[];
  replies: NeynarCastWithReplies[];
  isLoading: boolean;
  error: string | null;
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
      // Render the focused cast + replies immediately; backfill ancestors after.
      setState({
        rootCast: rootCast as NeynarCast,
        ancestors: [],
        replies,
        isLoading: false,
        error: null,
      });
      if (rootCast.parent_hash) {
        const ancestors = await fetchAncestorChain(rootCast.parent_hash, 5);
        setState((s) => ({ ...s, ancestors }));
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load thread",
      }));
    }
  }, [castHash, viewerFid]);

  return { ...state, fetch };
}
