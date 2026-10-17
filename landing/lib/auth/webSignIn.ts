/**
 * Orchestrates the two web sign-in paths on top of `protocolLogin.ts` and the
 * browser auth-address store. UI components call these and render progress;
 * they never touch keys, tokens or the network directly.
 */

import type { LoginResponse } from "@/lib/api/types";
import type { AuthAddressStore } from "@/lib/auth/authAddressStore";
import {
  AuthRequestError,
  pollSignerLinkUntilApproved,
  prepareSignerLink,
  registerSignerLink,
  signInWithAuthAddress,
  signInWithAuthAddressAfterLink,
  signSignerLink,
  type AuthApiOptions,
} from "@/lib/auth/protocolLogin";

export type LinkProgress =
  | "preparing"
  | "signing"
  | "submitting"
  | "pending"
  | "submitted"
  | "approved";

/** Returning browser: sign in with the stored auth address. */
export async function signInReturningBrowser(
  params: { fid: number; store: AuthAddressStore },
  options?: AuthApiOptions,
): Promise<LoginResponse> {
  const account = await params.store.load(params.fid);
  return signInWithAuthAddress({ fid: params.fid, account }, options);
}

/**
 * First link: authorise this browser's auth address (and Juke's app signer)
 * with the recovery phrase, then sign in.
 *
 * `takeRecoveryPhrase` is called once, only after `prepare` succeeds, and the
 * value is handed straight to `signSignerLink`; nothing here keeps it.
 */
export async function linkBrowserWithRecoveryPhrase(
  params: {
    fid: number;
    store: AuthAddressStore;
    takeRecoveryPhrase: () => string;
    onProgress?: (progress: LinkProgress) => void;
    signal?: AbortSignal;
  },
  options?: AuthApiOptions,
): Promise<LoginResponse> {
  const { fid, store, onProgress } = params;
  const account = await store.loadOrCreate(fid);

  onProgress?.("preparing");
  let prepare;
  try {
    prepare = await prepareSignerLink({ fid, authAddress: account.address }, options);
  } catch (err) {
    if (err instanceof AuthRequestError && err.code === "already_linked") {
      // Already on-chain for this browser — no phrase needed after all.
      params.takeRecoveryPhrase();
      return signInWithAuthAddress({ fid, account }, options);
    }
    throw err;
  }

  onProgress?.("signing");
  const signed = await signSignerLink({
    fid,
    authAddress: account.address,
    recoveryPhrase: params.takeRecoveryPhrase(),
    prepare,
  });

  onProgress?.("submitting");
  try {
    await registerSignerLink(
      {
        prepare_id: prepare.prepare_id,
        signer_add_signature: signed.signerAddSignature,
        auth_address_add_signature: signed.authAddressAddSignature,
        protocol_auth_token: signed.protocolAuthToken,
        ...signed.messagingToken,
      },
      options,
    );
  } catch (err) {
    // An idempotent retry of the same prepare — keep polling its status.
    if (!(err instanceof AuthRequestError && err.code === "already_submitted")) {
      throw err;
    }
  }

  await pollSignerLinkUntilApproved(prepare.prepare_id, {
    ...options,
    signal: params.signal,
    onStatus: (next) => {
      if (next === "pending" || next === "submitted" || next === "approved") {
        onProgress?.(next);
      }
    },
  });

  // The status poll never hands out a session: the now-linked auth address
  // signs in through `/v1/auth/protocol` (which also sets the refresh cookie).
  return signInWithAuthAddressAfterLink(
    { fid, account },
    { ...options, signal: params.signal },
  );
}

// ---------------------------------------------------------------------------
// Last-used FID — a non-secret convenience so returning users get one button.
// ---------------------------------------------------------------------------

const LAST_FID_KEY = "juke:last-fid";

export function readLastFid(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_FID_KEY);
    const fid = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(fid) && fid > 0 ? fid : null;
  } catch {
    return null;
  }
}

export function writeLastFid(fid: number | null): void {
  try {
    if (fid === null) window.localStorage.removeItem(LAST_FID_KEY);
    else window.localStorage.setItem(LAST_FID_KEY, String(fid));
  } catch {
    // Storage blocked — the user just types their FID next time.
  }
}
