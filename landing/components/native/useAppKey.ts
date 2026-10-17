"use client";

/**
 * React hook wrapping the app-key approval lifecycle for native spaces.
 *
 * `ensureApproved()` resolves true if the on-device Ed25519 app key is approved;
 * otherwise it registers the key and exposes the Farcaster `approval_url` (which
 * `ApproveAppKeyPrompt` renders as a QR code plus an "open link" fallback), polls
 * until the user approves, and resolves true/false. Web analog of mobile
 * `hooks/useFarcasterAppKey.ts`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureAppKeyApproved,
  pollUntilApproved,
  isSafeApprovalUrl,
} from "@/lib/native/appKeyApproval";
import type { AppKeyStatus } from "@/lib/native/appKeyApi";

export type AppKeyUiStatus = "unknown" | AppKeyStatus;

export interface UseAppKey {
  status: AppKeyUiStatus;
  approvalUrl: string | null;
  isApproving: boolean;
  /** Ensure approved: surfaces the approval URL + polls if needed. True once approved. */
  ensureApproved: () => Promise<boolean>;
}

export function useAppKey(fid: number | undefined): UseAppKey {
  const [status, setStatus] = useState<AppKeyUiStatus>("unknown");
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const ensureApproved = useCallback(async (): Promise<boolean> => {
    if (!fid) return false;

    const result = await ensureAppKeyApproved(fid);
    if (result.approved) {
      setStatus("approved");
      setApprovalUrl(null);
      return true;
    }

    const safeUrl = isSafeApprovalUrl(result.approvalUrl)
      ? result.approvalUrl
      : null;
    // Don't auto-open a tab: on desktop the user approves on their phone by
    // scanning the QR that `ApproveAppKeyPrompt` renders from this URL (with an
    // "open link" fallback for same-device approval). We just publish the URL
    // and poll until the backend reports the key approved.
    setApprovalUrl(safeUrl);
    setStatus("pending_approval");

    setIsApproving(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const approved = await pollUntilApproved(fid, { signal: controller.signal });
    setIsApproving(false);
    setStatus(approved ? "approved" : "pending_approval");
    return approved;
  }, [fid]);

  return { status, approvalUrl, isApproving, ensureApproved };
}
