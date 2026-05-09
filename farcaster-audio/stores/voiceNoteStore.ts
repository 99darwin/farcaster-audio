import { create } from "zustand";
import type { VoiceNoteDetail } from "@/types/voiceNote";

interface VoiceNoteStore {
  voiceNotes: VoiceNoteDetail[];
  cursor: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  error: string | null;

  // Actions
  setVoiceNotes: (notes: VoiceNoteDetail[], cursor: string | null) => void;
  appendVoiceNotes: (notes: VoiceNoteDetail[], cursor: string | null) => void;
  prependVoiceNote: (note: VoiceNoteDetail) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setError: (error: string | null) => void;
  updateVoiceNote: (id: string, updates: Partial<VoiceNoteDetail>) => void;
  updateReaction: (id: string, type: "like" | "recast", added: boolean) => void;
  removeVoiceNote: (id: string) => void;
  removeAuthor: (fid: number) => void;
  reset: () => void;
}

export const useVoiceNoteStore = create<VoiceNoteStore>((set) => ({
  voiceNotes: [],
  cursor: null,
  isLoading: false,
  isRefreshing: false,
  hasMore: true,
  error: null,

  setVoiceNotes: (voiceNotes, cursor) =>
    set({
      voiceNotes,
      cursor,
      hasMore: cursor !== null,
      isLoading: false,
      isRefreshing: false,
      error: null,
    }),

  appendVoiceNotes: (newNotes, cursor) =>
    set((state) => ({
      voiceNotes: [...state.voiceNotes, ...newNotes],
      cursor,
      hasMore: cursor !== null,
      isLoading: false,
      error: null,
    })),

  prependVoiceNote: (note) =>
    set((state) => ({ voiceNotes: [note, ...state.voiceNotes] })),

  setLoading: (isLoading) => set({ isLoading }),
  setRefreshing: (isRefreshing) => set({ isRefreshing }),
  setError: (error) => set({ error, isLoading: false, isRefreshing: false }),

  updateVoiceNote: (id, updates) =>
    set((state) => ({
      voiceNotes: state.voiceNotes.map((vn) =>
        vn.voice_note.id === id ? { ...vn, ...updates } : vn,
      ),
    })),

  updateReaction: (id, type, added) =>
    set((state) => ({
      voiceNotes: state.voiceNotes.map((vn) => {
        if (vn.voice_note.id !== id) return vn;
        const counts = { ...vn.reaction_counts };
        const viewer = [...vn.viewer_reactions];
        if (added) {
          counts[type] = (counts[type] || 0) + 1;
          if (!viewer.includes(type)) viewer.push(type);
        } else {
          counts[type] = Math.max(0, (counts[type] || 0) - 1);
          const idx = viewer.indexOf(type);
          if (idx !== -1) viewer.splice(idx, 1);
        }
        return { ...vn, reaction_counts: counts, viewer_reactions: viewer };
      }),
    })),

  removeVoiceNote: (id) =>
    set((state) => ({
      voiceNotes: state.voiceNotes.filter((vn) => vn.voice_note.id !== id),
    })),

  removeAuthor: (fid) =>
    set((state) => ({
      voiceNotes: state.voiceNotes.filter((vn) => vn.author.fid !== fid),
    })),

  reset: () =>
    set({
      voiceNotes: [],
      cursor: null,
      isLoading: false,
      isRefreshing: false,
      hasMore: true,
      error: null,
    }),
}));
