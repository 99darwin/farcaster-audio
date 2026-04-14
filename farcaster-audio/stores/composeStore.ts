import { create } from "zustand";

export interface ComposeDraft {
  text?: string;
  embeds?: string[];
}

interface ComposeStore {
  /** Incremented each time compose is requested from outside the screen */
  composeSignal: number;
  /** Optional pre-filled content for the next compose open */
  draft: ComposeDraft | null;
  requestCompose: (draft?: ComposeDraft) => void;
  clearDraft: () => void;
}

export const useComposeStore = create<ComposeStore>((set) => ({
  composeSignal: 0,
  draft: null,
  requestCompose: (draft) =>
    set((s) => ({
      composeSignal: s.composeSignal + 1,
      draft: draft ?? null,
    })),
  clearDraft: () => set({ draft: null }),
}));
