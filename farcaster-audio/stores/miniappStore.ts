import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import * as Sentry from "@sentry/react-native";
import type {
  MiniAppConfig,
  MiniAppManifest,
  LocationContext,
} from "@/types/miniapp";

const ADDED_MINIAPPS_KEY = "added_miniapps";

export interface AddedMiniApp {
  domain: string;
  config: MiniAppConfig;
  addedAt: string;
  notificationsEnabled: boolean;
}

export interface ActiveMiniApp {
  url: string;
  domain: string;
  manifest: MiniAppManifest | null;
  config: MiniAppConfig | null;
  location?: LocationContext;
}

interface PrimaryButtonState {
  text: string;
  loading: boolean;
  disabled: boolean;
  hidden: boolean;
}

interface MiniAppStore {
  activeMiniApp: ActiveMiniApp | null;
  isMinimized: boolean;
  addedMiniApps: AddedMiniApp[];
  isSplashVisible: boolean;
  primaryButton: PrimaryButtonState | null;
  showAuthSetup: boolean;
  authSetupResolve: ((proceed: boolean) => void) | null;

  // Actions
  openMiniApp: (miniApp: ActiveMiniApp) => void;
  closeMiniApp: () => void;
  minimizeMiniApp: () => void;
  maximizeMiniApp: () => void;
  hideSplash: () => void;
  setPrimaryButton: (options: PrimaryButtonState) => void;
  addMiniApp: (domain: string, config: MiniAppConfig) => Promise<void>;
  removeMiniApp: (domain: string) => Promise<void>;
  isMiniAppAdded: (domain: string) => boolean;
  hydrateAddedMiniApps: () => Promise<void>;
  requestAuthSetup: () => Promise<boolean>;
  dismissAuthSetup: (proceed: boolean) => void;
}

export const useMiniAppStore = create<MiniAppStore>((set, get) => ({
  activeMiniApp: null,
  isMinimized: false,
  addedMiniApps: [],
  isSplashVisible: true,
  primaryButton: null,
  showAuthSetup: false,
  authSetupResolve: null,

  openMiniApp: (miniApp) => {
    set({
      activeMiniApp: miniApp,
      isMinimized: false,
      isSplashVisible: true,
      primaryButton: null,
    });
  },

  closeMiniApp: () => {
    set({
      activeMiniApp: null,
      isMinimized: false,
      isSplashVisible: true,
      primaryButton: null,
    });
  },

  minimizeMiniApp: () => {
    set({ isMinimized: true });
  },

  maximizeMiniApp: () => {
    set({ isMinimized: false });
  },

  hideSplash: () => {
    set({ isSplashVisible: false });
  },

  setPrimaryButton: (options) => {
    set({ primaryButton: options });
  },

  addMiniApp: async (domain, config) => {
    const existing = get().addedMiniApps;
    if (existing.some((a) => a.domain === domain)) return;

    const entry: AddedMiniApp = {
      domain,
      config,
      addedAt: new Date().toISOString(),
      notificationsEnabled: false,
    };
    const updated = [...existing, entry];
    set({ addedMiniApps: updated });
    await SecureStore.setItemAsync(ADDED_MINIAPPS_KEY, JSON.stringify(updated));
  },

  removeMiniApp: async (domain) => {
    const updated = get().addedMiniApps.filter((a) => a.domain !== domain);
    set({ addedMiniApps: updated });
    await SecureStore.setItemAsync(ADDED_MINIAPPS_KEY, JSON.stringify(updated));
  },

  isMiniAppAdded: (domain) => {
    return get().addedMiniApps.some((a) => a.domain === domain);
  },

  requestAuthSetup: () => {
    return new Promise<boolean>((resolve) => {
      set({ showAuthSetup: true, authSetupResolve: resolve });
    });
  },

  dismissAuthSetup: (proceed: boolean) => {
    const resolver = get().authSetupResolve;
    set({ showAuthSetup: false, authSetupResolve: null });
    resolver?.(proceed);
  },

  hydrateAddedMiniApps: async () => {
    try {
      const data = await SecureStore.getItemAsync(ADDED_MINIAPPS_KEY);
      if (data) {
        set({ addedMiniApps: JSON.parse(data) });
      }
    } catch (error) {
      Sentry.captureException(error, {
        tags: { context: "miniapp_hydration" },
      });
    }
  },
}));
