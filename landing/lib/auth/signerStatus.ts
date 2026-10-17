/**
 * Read-only mode from `UserResponse.signer_status` (auth contract section 3):
 * anything other than `approved` means Juke can't post for the user, so the
 * web app runs read-only and offers the re-link flow.
 */

import type { UserResponse } from "@/lib/api/types";

/** Sign-in screen opened directly on the recovery-phrase link step. */
export const RELINK_PATH = "/app/login?relink=1";
export const RELINK_QUERY_PARAM = "relink";

/**
 * True when the signed-in user's app signer isn't approved. An absent field
 * (a backend that predates the contract) is unknown, not read-only — the
 * backend still rejects writes with `403 signer_not_linked` either way.
 */
export function isSignerReadOnly(user: UserResponse | null): boolean {
  if (!user || user.signer_status === undefined) return false;
  return user.signer_status !== "approved";
}

/** Whether the sign-in screen was asked for the re-link step. */
export function isRelinkRequest(searchParams: URLSearchParams): boolean {
  return searchParams.get(RELINK_QUERY_PARAM) === "1";
}
