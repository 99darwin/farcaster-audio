import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const PREFS_KEY = "juke_prefs";

export type AppearancePref = "system" | "light" | "dark";

interface PrefsState {
  winampMode: boolean;
  appearancePref: AppearancePref;
  setWinampMode: (enabled: boolean) => Promise<void>;
  setAppearancePref: (pref: AppearancePref) => Promise<void>;
  loadPrefs: () => Promise<void>;
}

interface PersistedPrefs {
  winampMode?: boolean;
  appearancePref?: AppearancePref;
}

async function persist(state: PersistedPrefs) {
  await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(state));
}

export const usePrefsStore = create<PrefsState>((set, get) => ({
  winampMode: false,
  appearancePref: "system",

  setWinampMode: async (enabled: boolean) => {
    set({ winampMode: enabled });
    await persist({
      winampMode: enabled,
      appearancePref: get().appearancePref,
    });
  },

  setAppearancePref: async (pref: AppearancePref) => {
    set({ appearancePref: pref });
    await persist({
      winampMode: get().winampMode,
      appearancePref: pref,
    });
  },

  loadPrefs: async () => {
    try {
      const data = await SecureStore.getItemAsync(PREFS_KEY);
      if (!data) return;
      const prefs: PersistedPrefs = JSON.parse(data);
      set({
        winampMode: prefs.winampMode ?? false,
        appearancePref: prefs.appearancePref ?? "system",
      });
    } catch {
      // Ignore — use defaults
    }
  },
}));
