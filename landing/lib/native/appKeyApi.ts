/**
 * Backend calls for registering / checking the on-device Ed25519 app key.
 * Mirrors mobile `api.registerSnapSigner` / `getSnapSignerStatus`. All are
 * JWT-gated via `apiFetch`.
 */

import { apiFetch } from "@/lib/api/client";

export type AppKeyStatus = "none" | "pending_approval" | "approved";

export interface RegisterAppKeyResponse {
  public_key: string;
  approval_url: string | null;
  status: AppKeyStatus | string;
}

export interface AppKeyStatusResponse {
  status: AppKeyStatus | string;
}

/** POST /v1/snaps/register-signer — authorize our pubkey for the FID. */
export function registerAppKey(
  publicKey: string,
): Promise<RegisterAppKeyResponse> {
  return apiFetch<RegisterAppKeyResponse>("/v1/snaps/register-signer", {
    method: "POST",
    body: { public_key: publicKey },
  });
}

/** GET /v1/snaps/signer-status?public_key=… — approval status for our pubkey. */
export function getAppKeyStatus(
  publicKey: string,
): Promise<AppKeyStatusResponse> {
  const q = new URLSearchParams({ public_key: publicKey });
  return apiFetch<AppKeyStatusResponse>(`/v1/snaps/signer-status?${q}`, {
    method: "GET",
  });
}

/** POST /v1/snaps/signer-invalidate — mark our signer revoked (best-effort). */
export async function invalidateAppKey(publicKey: string): Promise<void> {
  try {
    await apiFetch("/v1/snaps/signer-invalidate", {
      method: "POST",
      body: { public_key: publicKey },
    });
  } catch {
    // Best-effort — local state is cleared by the caller.
  }
}
