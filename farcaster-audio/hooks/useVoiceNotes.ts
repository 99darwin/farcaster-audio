import { useCallback } from "react";
import { useVoiceNoteStore } from "@/stores/voiceNoteStore";
import { useAuthStore } from "@/stores/authStore";
import * as voiceNotesApi from "@/services/voiceNotes";

export function useVoiceNotes() {
  const {
    voiceNotes,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    cursor,
    setVoiceNotes,
    appendVoiceNotes,
    setLoading,
    setRefreshing,
    setError,
    updateReaction,
    removeVoiceNote,
  } = useVoiceNoteStore();
  const user = useAuthStore((s) => s.user);

  const fetch = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await voiceNotesApi.getVoiceNoteFeed();
      setVoiceNotes(data.voice_notes, data.next_cursor);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch voice notes",
      );
    }
  }, [user, setLoading, setVoiceNotes, setError]);

  const fetchMore = useCallback(async () => {
    if (!user || !hasMore || isLoading || !cursor) return;
    setLoading(true);
    try {
      const data = await voiceNotesApi.getVoiceNoteFeed(20, cursor);
      appendVoiceNotes(data.voice_notes, data.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    }
  }, [
    user,
    hasMore,
    isLoading,
    cursor,
    appendVoiceNotes,
    setLoading,
    setError,
  ]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const data = await voiceNotesApi.getVoiceNoteFeed();
      setVoiceNotes(data.voice_notes, data.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh");
    }
  }, [user, setRefreshing, setVoiceNotes, setError]);

  const handleLike = useCallback(
    async (voiceNoteId: string, isLiked: boolean) => {
      updateReaction(voiceNoteId, "like", !isLiked);
      try {
        if (isLiked) {
          await voiceNotesApi.removeReaction(voiceNoteId, "like");
        } else {
          await voiceNotesApi.addReaction(voiceNoteId, "like");
        }
      } catch {
        updateReaction(voiceNoteId, "like", isLiked);
      }
    },
    [updateReaction],
  );

  const handleRecast = useCallback(
    async (voiceNoteId: string, isRecasted: boolean) => {
      updateReaction(voiceNoteId, "recast", !isRecasted);
      try {
        if (isRecasted) {
          await voiceNotesApi.removeReaction(voiceNoteId, "recast");
        } else {
          await voiceNotesApi.addReaction(voiceNoteId, "recast");
        }
      } catch {
        updateReaction(voiceNoteId, "recast", isRecasted);
      }
    },
    [updateReaction],
  );

  const handleDelete = useCallback(
    async (voiceNoteId: string) => {
      try {
        await voiceNotesApi.deleteVoiceNote(voiceNoteId);
        removeVoiceNote(voiceNoteId);
      } catch {
        // TODO: show error toast
      }
    },
    [removeVoiceNote],
  );

  return {
    voiceNotes,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    fetch,
    fetchMore,
    refresh,
    handleLike,
    handleRecast,
    handleDelete,
  };
}
