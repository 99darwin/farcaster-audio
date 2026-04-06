import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const PREFS_KEY = 'juke_prefs';

interface PrefsState {
  winampMode: boolean;
  setWinampMode: (enabled: boolean) => void;
  loadPrefs: () => Promise<void>;
}

export const usePrefsStore = create<PrefsState>((set, get) => ({
  winampMode: true,

  setWinampMode: async (enabled: boolean) => {
    set({ winampMode: enabled });
    const prefs = { winampMode: enabled };
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(prefs));
  },

  loadPrefs: async () => {
    try {
      const data = await SecureStore.getItemAsync(PREFS_KEY);
      if (data) {
        const prefs = JSON.parse(data);
        set({ winampMode: prefs.winampMode ?? true });
      }
    } catch {
      // Ignore — use defaults
    }
  },
}));
