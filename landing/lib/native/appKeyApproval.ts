/**
 * App-key approval lifecycle for Farcaster-native writes on web.
 *
 * Native audio-room writes require an Ed25519 app key the user has approved in
 * the Farcaster app. This module wraps: check cached/backend status → register
 * the pubkey (yielding a Farcaster `approval_url`) → poll until approved. Web
 * analog of mobile `hooks/useFarcasterAppKey.ts` + `services/snapSigner.ts`
 * status helpers, minus React.
 *
 * Surfacing the `approval_url` (as a QR code / link) is left to the caller.
 */

import { getAppKeyPublicKey } from "@/lib/native/appKey";
import {
  registerAppKey,
  getAppKeyStatus,
  type AppKeyStatus,
} from "@/lib/native/appKeyApi";
import {
  readApprovedCache,
  writeApprovedCache,
  clearApprovedCache,
} from "@/lib/native/appKeyStore";

/** Error thrown by native writes when the app key isn't approved yet. */
export class AppKeyNotApprovedError extends Error {
  constructor(readonly approvalUrl: string | null) {
    super("Farcaster app key not approved");
    this.name = "AppKeyNotApprovedError";
  }
}

/**
 * Guard the backend-supplied `approval_url` before we open it in a tab, render
 * it as a link, or QR-encode it. Requires an absolute `https:` URL — this
 * neutralises a `javascript:` href (which would execute in our origin) or an
 * `http:`/opaque URL, even though the value comes from our own backend. Defence
 * in depth for the one place an external string reaches a navigation sink.
 */
export function isSafeApprovalUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export type EnsureResult =
  | { approved: true }
  | { approved: false; approvalUrl: string | null };

function normalizeStatus(status: string): AppKeyStatus {
  if (status === "approved") return "approved";
  if (status === "pending_approval") return "pending_approval";
  return "none";
}

/**
 * Resolve the current approval status. Fast path returns from the IndexedDB
 * cache; `force` re-checks the backend (used while polling after approval).
 */
export async function getApprovalStatus(
  fid: number,
  opts: { force?: boolean } = {},
): Promise<AppKeyStatus> {
  if (!opts.force && (await readApprovedCache(fid))) return "approved";
  try {
    const publicKey = await getAppKeyPublicKey(fid);
    const { status } = await getAppKeyStatus(publicKey);
    const normalized = normalizeStatus(status);
    if (normalized === "approved") await writeApprovedCache(fid);
    else await clearApprovedCache(fid);
    return normalized;
  } catch {
    // 403 (unregistered / not ours) or network — treat as not-yet-approved.
    return "none";
  }
}

/**
 * Ensure the fid has an approved app key. If already approved, resolves
 * `{ approved: true }`. Otherwise registers the pubkey and resolves
 * `{ approved: false, approvalUrl }` — the caller surfaces the URL (QR / link)
 * and then calls `pollUntilApproved`.
 */
export async function ensureAppKeyApproved(fid: number): Promise<EnsureResult> {
  if (await readApprovedCache(fid)) return { approved: true };

  // Confirm against the backend before doing anything heavier.
  if ((await getApprovalStatus(fid, { force: true })) === "approved") {
    return { approved: true };
  }

  const publicKey = await getAppKeyPublicKey(fid);
  const result = await registerAppKey(publicKey);
  if (normalizeStatus(result.status) === "approved") {
    await writeApprovedCache(fid);
    return { approved: true };
  }
  return { approved: false, approvalUrl: result.approval_url };
}

/**
 * Poll the backend until the app key is approved or the window elapses.
 * Resolves true on approval, false on timeout/abort.
 */
export async function pollUntilApproved(
  fid: number,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return false;
    if ((await getApprovalStatus(fid, { force: true })) === "approved") {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
