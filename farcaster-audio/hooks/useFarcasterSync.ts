/**
 * DORMANT — no active call sites as of the backend-orchestrated
 * Farcaster-native spaces rollout. Native rooms are now minted
 * server-side by Juke's service FID and joined via Warpcast
 * deep-link, so no Mini App bearer is needed. Kept as a known-good
 * reference for the day Warpcast ships a sign-as-custody primitive.
 *
 * Hook that exposes the Farcaster-native bearer state to the rest of the
 * app and provides the entry points for syncing / revoking it.
 *
 * Surface:
 *   - `enabled`        — true iff a non-expired bearer is in Keychain.
 *   - `fid`            — fid associated with the cached bearer, or null.
 *   - `expiringSoon`   — bearer present but within the re-sync window.
 *   - `ensureBearer()` — returns the cached bearer if still valid, else null.
 *                        Consumers can branch on null to prompt re-sync.
 *   - `openMiniAppSync()` — open the Warpcast Mini App that mints a bearer.
 *   - `revoke()`       — clear Keychain + tell the backend (tolerates 404).
 *
 * Foreground transitions re-check expiry so `expiringSoon` flips
 * correctly when the user returns from background after many hours.
 */

import axios from "axios";
import { useCallback, useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Linking from "expo-linking";

import { apiClient } from "@/services/api";
import {
  clearFarcasterBearer,
  getFarcasterBearer,
  isExpiringSoon,
  type FarcasterBearer,
} from "@/services/farcasterBearer";
import { MINIAPP_SYNC_URL } from "@/constants/farcaster";

export interface UseFarcasterSync {
  /** Bearer is present and not expired. */
  enabled: boolean;
  /** FID for the cached bearer, or null when none. */
  fid: number | null;
  /** Bearer is present but within the re-sync window. */
  expiringSoon: boolean;
  /**
   * Returns the cached bearer if still valid, otherwise null. Triggers a
   * fresh read from SecureStore so callers can rely on it post-foreground.
   */
  ensureBearer: () => Promise<FarcasterBearer | null>;
  /** Open the Warpcast Mini App entry that mints a bearer. */
  openMiniAppSync: () => Promise<void>;
  /** Clear Keychain + notify backend. Tolerates 404 if endpoint not deployed. */
  revoke: () => Promise<void>;
}

interface BearerSnapshot {
  bearer: FarcasterBearer | null;
  expiringSoon: boolean;
}

const EMPTY_SNAPSHOT: BearerSnapshot = {
  bearer: null,
  expiringSoon: false,
};

function snapshotFor(bearer: FarcasterBearer | null): BearerSnapshot {
  if (!bearer) return EMPTY_SNAPSHOT;
  return { bearer, expiringSoon: isExpiringSoon(bearer) };
}

export function useFarcasterSync(): UseFarcasterSync {
  const [snapshot, setSnapshot] = useState<BearerSnapshot>(EMPTY_SNAPSHOT);

  const refresh = useCallback(async (): Promise<FarcasterBearer | null> => {
    const bearer = await getFarcasterBearer();
    setSnapshot(snapshotFor(bearer));
    return bearer;
  }, []);

  // Initial hydration.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bearer = await getFarcasterBearer();
      if (cancelled) return;
      setSnapshot(snapshotFor(bearer));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-check on foreground. Phones can be backgrounded for hours; the
  // bearer may have expired since the last render.
  useEffect(() => {
    const handle = (next: AppStateStatus) => {
      if (next !== "active") return;
      void refresh();
    };
    const sub = AppState.addEventListener("change", handle);
    return () => sub.remove();
  }, [refresh]);

  const ensureBearer = useCallback(
    (): Promise<FarcasterBearer | null> => refresh(),
    [refresh],
  );

  const openMiniAppSync = useCallback(async (): Promise<void> => {
    await Linking.openURL(MINIAPP_SYNC_URL);
  }, []);

  const revoke = useCallback(async (): Promise<void> => {
    // Always clear local first so a backend failure can't leave a stale
    // bearer in Keychain on the user's device.
    await clearFarcasterBearer();
    setSnapshot(EMPTY_SNAPSHOT);
    try {
      await apiClient.delete("/v1/farcaster-sync");
    } catch (error) {
      // Tolerate 404 — the backend endpoint may not be deployed yet.
      if (axios.isAxiosError(error) && error.response?.status === 404) return;
      // Any other error: swallow but warn. The local clear already succeeded
      // and the bearer is single-device, so the backend will eventually
      // reconcile when the bearer expires on its own.
      if (__DEV__) {
        console.warn(
          "[useFarcasterSync] revoke: backend call failed; local cleared",
        );
      }
    }
  }, []);

  return {
    enabled: snapshot.bearer !== null,
    fid: snapshot.bearer?.fid ?? null,
    expiringSoon: snapshot.expiringSoon,
    ensureBearer,
    openMiniAppSync,
    revoke,
  };
}
