/**
 * Farcaster app-key (Ed25519) approval gate.
 *
 * Wraps the underlying snap-signer service (which manages the on-device
 * Ed25519 key + Neynar developer-managed registration) and exposes a
 * single `ensureApproved` operation. The signer is generic — it signs
 * JFS for any client.farcaster.xyz endpoint that accepts app-key auth
 * (Snap interactivity, audio-rooms writes, etc.), not snap-specific.
 *
 * Behavior:
 * - Force-refreshes status against the backend.
 * - If approved → returns { approved: true }.
 * - Else registers (or fetches the existing pending registration) and
 *   opens the Warpcast approval URL via Linking. Starts an AppState
 *   watcher that auto-refreshes status when the user returns. Returns
 *   { approved: false, approvalUrl }.
 *
 * Callers should NOT block their UI awaiting approval — render a CTA
 * that re-runs the original action once the watcher flips status.
 */

import { useCallback, useEffect, useRef } from "react";
import { AppState, AppStateStatus, Linking } from "react-native";
import {
  useSnapSignerStatus,
  type UseSnapSignerStatusResult,
} from "@/hooks/useSnapSignerStatus";
import { registerSnapSigner } from "@/services/snapSigner";

const APPROVAL_WATCH_MAX_MS = 5 * 60 * 1000;

export interface EnsureApprovedResult {
  approved: boolean;
  approvalUrl?: string | null;
}

export interface UseFarcasterAppKeyResult {
  status: UseSnapSignerStatusResult["status"];
  refresh: UseSnapSignerStatusResult["refresh"];
  ensureApproved: () => Promise<EnsureApprovedResult>;
}

export function useFarcasterAppKey(fid: number): UseFarcasterAppKeyResult {
  const { status, refresh } = useSnapSignerStatus(fid);
  const watcherCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      watcherCleanupRef.current?.();
      watcherCleanupRef.current = null;
    };
  }, []);

  const startApprovalWatch = useCallback(() => {
    watcherCleanupRef.current?.();
    watcherCleanupRef.current = null;

    let cancelled = false;

    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timeout);
      subscription.remove();
      if (watcherCleanupRef.current === cleanup) {
        watcherCleanupRef.current = null;
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      (next: AppStateStatus) => {
        if (cancelled || next !== "active") return;
        void refresh({ force: true }).then((result) => {
          if (cancelled) return;
          if (result === "approved") cleanup();
        });
      },
    );

    const timeout = setTimeout(cleanup, APPROVAL_WATCH_MAX_MS);
    watcherCleanupRef.current = cleanup;
  }, [refresh]);

  const ensureApproved = useCallback(async (): Promise<EnsureApprovedResult> => {
    if (!fid) return { approved: false };

    const latest = await refresh({ force: true });
    if (latest === "approved") return { approved: true };

    const result = await registerSnapSigner(fid);
    if (result.status === "approved") {
      await refresh({ force: true });
      return { approved: true };
    }

    if (result.approvalUrl) {
      await Linking.openURL(result.approvalUrl).catch(() => {});
    }
    startApprovalWatch();
    return { approved: false, approvalUrl: result.approvalUrl };
  }, [fid, refresh, startApprovalWatch]);

  return { status, refresh, ensureApproved };
}
