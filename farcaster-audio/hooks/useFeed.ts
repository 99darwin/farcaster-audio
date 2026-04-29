import { useCallback, useMemo } from "react";
import { useFeedStore } from "@/stores/feedStore";
import { useAuthStore } from "@/stores/authStore";
import { useVoiceNoteStore } from "@/stores/voiceNoteStore";
import {
  fetchFollowingFeed,
  likeCast,
  recastCast,
  removeLike,
  removeRecast,
  publishCast,
} from "@/services/neynar";
import * as voiceNotesApi from "@/services/voiceNotes";
import type { FeedItem } from "@/types/voiceNote";

/**
 * Merge casts and voice notes into a single timeline sorted by recency.
 * Voice notes are interleaved every ~4 casts to avoid clustering.
 */
function mergeFeedItems(
  castItems: FeedItem[],
  vnItems: FeedItem[],
): FeedItem[] {
  if (vnItems.length === 0) return castItems;
  if (castItems.length === 0) return vnItems;

  const merged: FeedItem[] = [];
  let vnIdx = 0;
  const VN_INTERVAL = 4; // Insert a voice note every N casts

  for (let i = 0; i < castItems.length; i++) {
    merged.push(castItems[i]);
    // After every VN_INTERVAL casts, insert a voice note if available
    if ((i + 1) % VN_INTERVAL === 0 && vnIdx < vnItems.length) {
      merged.push(vnItems[vnIdx]);
      vnIdx++;
    }
  }

  // Append remaining voice notes
  while (vnIdx < vnItems.length) {
    merged.push(vnItems[vnIdx]);
    vnIdx++;
  }

  return merged;
}

export function useFeed() {
  const { casts, isLoading, isRefreshing, hasMore, error, cursor } =
    useFeedStore();
  const {
    setCasts,
    appendCasts,
    setLoading,
    setRefreshing,
    setError,
    updateCastReaction,
  } = useFeedStore();
  const voiceNotes = useVoiceNoteStore((s) => s.voiceNotes);
  const vnSetVoiceNotes = useVoiceNoteStore((s) => s.setVoiceNotes);
  const vnSetLoading = useVoiceNoteStore((s) => s.setLoading);
  const vnUpdateReaction = useVoiceNoteStore((s) => s.updateReaction);
  const vnRemoveVoiceNote = useVoiceNoteStore((s) => s.removeVoiceNote);
  const user = useAuthStore((s) => s.user);

  // Build merged feed items
  const feedItems = useMemo<FeedItem[]>(() => {
    const castItems: FeedItem[] = casts.map((c) => ({ type: "cast", data: c }));
    const vnItems: FeedItem[] = voiceNotes.map((vn) => ({
      type: "voice_note",
      data: vn,
    }));
    return mergeFeedItems(castItems, vnItems);
  }, [casts, voiceNotes]);

  const fetch = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    vnSetLoading(true);
    try {
      const [feedData, vnData] = await Promise.all([
        fetchFollowingFeed(),
        voiceNotesApi
          .getVoiceNoteFeed()
          .catch(() => ({ voice_notes: [], next_cursor: null })),
      ]);
      setCasts(feedData.casts, feedData.next.cursor);
      vnSetVoiceNotes(vnData.voice_notes, vnData.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch feed");
    }
  }, [user, setCasts, setLoading, setError, vnSetVoiceNotes, vnSetLoading]);

  const fetchMore = useCallback(async () => {
    if (!user || !hasMore || isLoading || !cursor) return;
    setLoading(true);
    try {
      const data = await fetchFollowingFeed(25, cursor);
      appendCasts(data.casts, data.next.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    }
  }, [user, hasMore, isLoading, cursor, appendCasts, setLoading, setError]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const [feedData, vnData] = await Promise.all([
        fetchFollowingFeed(),
        voiceNotesApi
          .getVoiceNoteFeed()
          .catch(() => ({ voice_notes: [], next_cursor: null })),
      ]);
      setCasts(feedData.casts, feedData.next.cursor);
      vnSetVoiceNotes(vnData.voice_notes, vnData.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh feed");
    }
  }, [user, setCasts, setRefreshing, setError, vnSetVoiceNotes]);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      if (!user) return;
      updateCastReaction(castHash, "like", !isLiked, user.fid);
      try {
        if (isLiked) {
          await removeLike(castHash);
        } else {
          await likeCast(castHash);
        }
      } catch {
        updateCastReaction(castHash, "like", isLiked, user.fid);
      }
    },
    [user, updateCastReaction],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      if (!user) return;
      updateCastReaction(castHash, "recast", !isRecasted, user.fid);
      try {
        if (isRecasted) {
          await removeRecast(castHash);
        } else {
          await recastCast(castHash);
        }
      } catch {
        updateCastReaction(castHash, "recast", isRecasted, user.fid);
      }
    },
    [user, updateCastReaction],
  );

  const handleVoiceNoteLike = useCallback(
    async (voiceNoteId: string, isLiked: boolean) => {
      vnUpdateReaction(voiceNoteId, "like", !isLiked);
      try {
        if (isLiked) {
          await voiceNotesApi.removeReaction(voiceNoteId, "like");
        } else {
          await voiceNotesApi.addReaction(voiceNoteId, "like");
        }
      } catch {
        vnUpdateReaction(voiceNoteId, "like", isLiked);
      }
    },
    [vnUpdateReaction],
  );

  const handleVoiceNoteRecast = useCallback(
    async (voiceNoteId: string, isRecasted: boolean) => {
      vnUpdateReaction(voiceNoteId, "recast", !isRecasted);
      try {
        if (isRecasted) {
          await voiceNotesApi.removeReaction(voiceNoteId, "recast");
        } else {
          await voiceNotesApi.addReaction(voiceNoteId, "recast");
        }
      } catch {
        vnUpdateReaction(voiceNoteId, "recast", isRecasted);
      }
    },
    [vnUpdateReaction],
  );

  const handleVoiceNoteDelete = useCallback(
    async (voiceNoteId: string) => {
      try {
        await voiceNotesApi.deleteVoiceNote(voiceNoteId);
        vnRemoveVoiceNote(voiceNoteId);
      } catch {}
    },
    [vnRemoveVoiceNote],
  );

  const handlePublishCast = useCallback(
    async (
      text: string,
      parentHash?: string,
      imageUris?: string[],
      quote?: { fid: number; hash: string },
    ): Promise<{ hash: string } | void> => {
      const result = await publishCast(
        text,
        parentHash,
        imageUris && imageUris.length > 0 ? imageUris : undefined,
        quote,
      );
      await refresh();
      return result;
    },
    [refresh],
  );

  return {
    casts,
    feedItems,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    fetch,
    fetchMore,
    refresh,
    handleLike,
    handleRecast,
    handleVoiceNoteLike,
    handleVoiceNoteRecast,
    handleVoiceNoteDelete,
    handlePublishCast,
  };
}
