import { create } from "zustand";

interface AudioPlayerStore {
  activeVoiceNoteId: string | null;
  activeAudioUrl: string | null;
  activeDurationMs: number;
  setActive: (id: string, url: string, durationMs: number) => void;
  clearActive: () => void;
}

export const useAudioPlayerStore = create<AudioPlayerStore>((set) => ({
  activeVoiceNoteId: null,
  activeAudioUrl: null,
  activeDurationMs: 0,
  setActive: (id, url, durationMs) =>
    set({
      activeVoiceNoteId: id,
      activeAudioUrl: url,
      activeDurationMs: durationMs,
    }),
  clearActive: () =>
    set({ activeVoiceNoteId: null, activeAudioUrl: null, activeDurationMs: 0 }),
}));
