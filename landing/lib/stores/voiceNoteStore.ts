"use client";

/**
 * Voice-note store for the Juke web app — ported from mobile
 * `stores/voiceNoteStore.ts`, trimmed to what the web Home feed needs: the
 * personalised voice-note list (interleaved into the timeline) plus a single
 * "which note is playing" playback flag.
 *
 * Actual audio transport lives in `recording-audio-player.tsx` / the voice
 * detail page; this store only tracks list state + which note is active so the
 * feed can highlight the currently-playing row without re-fetching.
 */

import { create } from "zustand";
import type { VoiceNoteDetail } from "@/lib/voice-notes";

interface VoiceNoteStore {
  voiceNotes: VoiceNoteDetail[];
  cursor: string | null;
  loading: boolean;
  hasMore: boolean;
  /** id of the note currently playing, or null when nothing is playing. */
  playingId: string | null;

  setVoiceNotes: (notes: VoiceNoteDetail[], cursor: string | null) => void;
  appendVoiceNotes: (notes: VoiceNoteDetail[], cursor: string | null) => void;
  setLoading: (loading: boolean) => void;
  setPlaying: (id: string | null) => void;
  removeVoiceNote: (id: string) => void;
  removeAuthor: (fid: number) => void;
  reset: () => void;
}

const INITIAL = {
  voiceNotes: [] as VoiceNoteDetail[],
  cursor: null as string | null,
  loading: false,
  hasMore: true,
  playingId: null as string | null,
};

export const useVoiceNoteStore = create<VoiceNoteStore>((set) => ({
  ...INITIAL,

  setVoiceNotes: (voiceNotes, cursor) =>
    set({ voiceNotes, cursor, hasMore: cursor !== null, loading: false }),

  appendVoiceNotes: (newNotes, cursor) =>
    set((state) => ({
      voiceNotes: [...state.voiceNotes, ...newNotes],
      cursor,
      hasMore: cursor !== null,
      loading: false,
    })),

  setLoading: (loading) => set({ loading }),
  setPlaying: (playingId) => set({ playingId }),

  removeVoiceNote: (id) =>
    set((state) => ({
      voiceNotes: state.voiceNotes.filter((vn) => vn.voice_note.id !== id),
      playingId: state.playingId === id ? null : state.playingId,
    })),

  removeAuthor: (fid) =>
    set((state) => ({
      voiceNotes: state.voiceNotes.filter((vn) => vn.author.fid !== fid),
    })),

  reset: () => set({ ...INITIAL }),
}));
