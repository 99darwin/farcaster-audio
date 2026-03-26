import { create } from 'zustand';

interface ComposeStore {
  /** Incremented each time compose is requested from outside the screen */
  composeSignal: number;
  requestCompose: () => void;
}

export const useComposeStore = create<ComposeStore>((set) => ({
  composeSignal: 0,
  requestCompose: () => set((s) => ({ composeSignal: s.composeSignal + 1 })),
}));
