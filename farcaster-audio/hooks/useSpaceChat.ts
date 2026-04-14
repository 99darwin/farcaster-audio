import { useEffect, useCallback } from "react";
import { useCastThread } from "@/hooks/useCastThread";
import { useSpaceStore } from "@/stores/spaceStore";

export function useSpaceChat(castHash: string | null, viewerFid: number) {
  const hasCastThread = castHash != null;
  const thread = useCastThread(castHash ?? "", viewerFid);
  const chatNewReplyTick = useSpaceStore((s) => s.chatNewReplyTick);

  // Fetch on mount
  useEffect(() => {
    if (!hasCastThread) return;
    thread.fetch();
  }, [hasCastThread]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh when a new reply notification arrives via LiveKit data channel
  useEffect(() => {
    if (!hasCastThread || chatNewReplyTick === 0) return;
    thread.fetch();
  }, [chatNewReplyTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshThread = useCallback(async () => {
    if (!hasCastThread) return;
    await thread.fetch();
  }, [hasCastThread, thread.fetch]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasCastThread) {
    return {
      hasCastThread: false as const,
      rootCast: null,
      replies: [],
      isLoading: false,
      error: null,
      refreshThread,
    };
  }

  return {
    hasCastThread: true as const,
    rootCast: thread.rootCast,
    replies: thread.replies,
    isLoading: thread.isLoading,
    error: thread.error,
    refreshThread,
  };
}
