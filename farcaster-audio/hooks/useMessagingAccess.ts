/**
 * Decides whether the viewer can read/send Direct Casts (design §3.2/§3.3).
 *
 * Upstream accepts only a custody-minted token, which the backend stores
 * after the user signs one `generateToken` request with their recovery
 * phrase: at phrase link (`signSignerLink`) or later through the
 * "Enable messages" flow (`enable`). The client never sends a Farcaster
 * credential itself; it only reads `GET /v1/messages/status`:
 *
 *   token_status "active"              -> ready
 *   token_status "missing" | "expired" -> needs_enable
 *   any later 403 / WS 4403 token code -> needs_enable (store `accessError`)
 *
 * Status is cached once per fid in a tiny module store so every surface that
 * calls this hook (tab, thread, search, badge) shares one request.
 */

import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { useAuthStore } from "@/stores/authStore";
import { useMessageStore, type MessagingAccessError } from "@/stores/messageStore";
import {
  EnableMessagingError,
  enableMessaging,
  getMessagingStatus,
  type EnableMessagingErrorCode,
} from "@/services/messagesApi";
import { SignerLinkError, signMessagingToken } from "@/services/signerLink";
import type { MessagingTokenStatus } from "@/types/messages";

export type MessagingAccessState =
  /** Status not known yet; render a spinner. */
  | "checking"
  | "ready"
  /** No usable Direct Cast token: render the "Enable messages" flow. */
  | "needs_enable"
  /** Status probe failed or the server cannot read the token; offer retry. */
  | "error";

/** Why the viewer needs to enable (drives the gate copy). */
export type MessagingEnableReason = "missing" | "expired" | "rejected";

export interface UseMessagingAccessResult {
  state: MessagingAccessState;
  enableReason: MessagingEnableReason | null;
  expiresAt: string | null;
  isEnabling: boolean;
  enableError: string | null;
  /** Sign the token request with `phrase` and store it. True on success. */
  enable: (phrase: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  clearEnableError: () => void;
}

interface TokenSnapshot {
  fid: number;
  tokenStatus: MessagingTokenStatus | null;
  expiresAt: string | null;
  /** The probe failed, or the server reported the token unreadable. */
  isUnavailable: boolean;
}

interface TokenStatusStore {
  snapshot: TokenSnapshot | null;
  inFlight: { fid: number; promise: Promise<void> } | null;
  setSnapshot: (snapshot: TokenSnapshot | null) => void;
}

/** Exported for tests (reset between cases). */
export const useMessagingTokenStore = create<TokenStatusStore>((set) => ({
  snapshot: null,
  inFlight: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));

// Signing out deletes the stored token server-side; drop the cached status
// so the next session re-probes instead of trusting a stale "active".
useAuthStore.subscribe((state, previous) => {
  if (previous.user && !state.user) {
    useMessagingTokenStore.setState({ snapshot: null, inFlight: null });
  }
});

const ENABLE_COPY: Record<EnableMessagingErrorCode, string> = {
  invalid_signature:
    "That phrase doesn't control this Farcaster account. Use the recovery phrase for this account.",
  invalid_auth_request: "Something went wrong preparing the request. Try again.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  unavailable: "Messages aren't available right now.",
  network: "You're offline. Check your connection.",
  upstream_error: "Farcaster is having trouble. Try again shortly.",
  unknown: "Something went wrong. Try again.",
};

/** User-facing copy for a failed enable. Never includes the phrase. */
export function describeEnableError(error: unknown): string {
  if (error instanceof SignerLinkError) return error.message;
  if (error instanceof EnableMessagingError) return ENABLE_COPY[error.code];
  return ENABLE_COPY.unknown;
}

async function loadTokenStatus(fid: number, force: boolean): Promise<void> {
  const store = useMessagingTokenStore.getState();
  if (!force && store.snapshot?.fid === fid) return;
  if (store.inFlight?.fid === fid) return store.inFlight.promise;

  const promise = (async () => {
    try {
      const status = await getMessagingStatus();
      if (!status.enabled) {
        useMessageStore.getState().setAvailability("unavailable");
      }
      useMessagingTokenStore.getState().setSnapshot({
        fid,
        tokenStatus: status.token_status,
        expiresAt: status.expires_at,
        isUnavailable: status.signer_status === "unavailable",
      });
    } catch {
      // Surfaced as the "error" state, whose retry calls `refresh`.
      useMessagingTokenStore.getState().setSnapshot({
        fid,
        tokenStatus: null,
        expiresAt: null,
        isUnavailable: true,
      });
    } finally {
      if (useMessagingTokenStore.getState().inFlight?.fid === fid) {
        useMessagingTokenStore.setState({ inFlight: null });
      }
    }
  })();
  useMessagingTokenStore.setState({ inFlight: { fid, promise } });
  return promise;
}

const REASON_BY_ACCESS_ERROR: Record<MessagingAccessError, MessagingEnableReason> = {
  token_missing: "missing",
  token_expired: "expired",
  token_rejected: "rejected",
};

const REASON_BY_TOKEN_STATUS: Partial<Record<MessagingTokenStatus, MessagingEnableReason>> = {
  missing: "missing",
  expired: "expired",
};

/** A live token error outranks the cached status. */
function reasonFor(
  accessError: MessagingAccessError | null,
  tokenStatus: MessagingTokenStatus | null,
): MessagingEnableReason | null {
  if (accessError) return REASON_BY_ACCESS_ERROR[accessError];
  if (!tokenStatus) return null;
  return REASON_BY_TOKEN_STATUS[tokenStatus] ?? null;
}

function accessStateFor(
  accessError: MessagingAccessError | null,
  snapshot: TokenSnapshot | null,
): MessagingAccessState {
  if (accessError) return "needs_enable";
  if (!snapshot) return "checking";
  // Checked before "active": the row can exist but fail to decrypt.
  if (snapshot.isUnavailable) return "error";
  return snapshot.tokenStatus === "active" ? "ready" : "needs_enable";
}

export function useMessagingAccess(): UseMessagingAccessResult {
  const fid = useAuthStore((s) => s.user?.fid) ?? 0;
  const custodyAddress = useAuthStore((s) => s.user?.custody_address) ?? "";
  const accessError = useMessageStore((s) => s.accessError);
  const setAccessError = useMessageStore((s) => s.setAccessError);
  const snapshot = useMessagingTokenStore((s) =>
    s.snapshot?.fid === fid ? s.snapshot : null,
  );
  const [isEnabling, setIsEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  useEffect(() => {
    if (!fid) return;
    void loadTokenStatus(fid, false);
  }, [fid]);

  const refresh = useCallback(async () => {
    if (!fid) return;
    await loadTokenStatus(fid, true);
  }, [fid]);

  const enable = useCallback(
    async (phrase: string): Promise<boolean> => {
      if (!fid || isEnabling) return false;
      setIsEnabling(true);
      setEnableError(null);
      try {
        const body = await signMessagingToken({ phrase, fid, custodyAddress });
        const result = await enableMessaging(body);
        useMessagingTokenStore.getState().setSnapshot({
          fid,
          tokenStatus: result.token_status,
          expiresAt: result.expires_at,
          isUnavailable: false,
        });
        setAccessError(null);
        return true;
      } catch (error) {
        setEnableError(describeEnableError(error));
        return false;
      } finally {
        setIsEnabling(false);
      }
    },
    [custodyAddress, fid, isEnabling, setAccessError],
  );

  const clearEnableError = useCallback(() => setEnableError(null), []);

  return {
    state: accessStateFor(accessError, snapshot),
    enableReason: reasonFor(accessError, snapshot?.tokenStatus ?? null),
    expiresAt: snapshot?.expiresAt ?? null,
    isEnabling,
    enableError,
    enable,
    refresh,
    clearEnableError,
  };
}
