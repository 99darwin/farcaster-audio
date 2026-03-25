import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

interface OTAUpdateState {
  isUpdateAvailable: boolean;
  isDownloading: boolean;
  isRestarting: boolean;
}

export function useOTAUpdate() {
  const [state, setState] = useState<OTAUpdateState>({
    isUpdateAvailable: false,
    isDownloading: false,
    isRestarting: false,
  });
  const hasCheckedRef = useRef(false);

  const checkForUpdate = useCallback(async () => {
    if (__DEV__) return;
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) {
        const download = await Updates.fetchUpdateAsync();
        if (download.isNew) {
          setState((s) => ({ ...s, isUpdateAvailable: true }));
        }
      }
    } catch {
      // Silent fail — update check is best-effort
    }
  }, []);

  const applyUpdate = useCallback(async () => {
    setState((s) => ({ ...s, isRestarting: true }));
    await Updates.reloadAsync();
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => ({ ...s, isUpdateAvailable: false }));
  }, []);

  // Check on mount
  useEffect(() => {
    if (!hasCheckedRef.current) {
      hasCheckedRef.current = true;
      checkForUpdate();
    }
  }, [checkForUpdate]);

  // Check when app comes back to foreground
  useEffect(() => {
    const handleAppState = (next: AppStateStatus) => {
      if (next === 'active') {
        checkForUpdate();
      }
    };
    const subscription = AppState.addEventListener('change', handleAppState);
    return () => subscription.remove();
  }, [checkForUpdate]);

  return {
    ...state,
    applyUpdate,
    dismiss,
  };
}
