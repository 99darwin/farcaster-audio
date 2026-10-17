/**
 * Everyday sign-in (auth contract §2): the device auth address — already in
 * KeyRegistry from the one-time phrase link — signs a short-lived Protocol
 * Auth token against a fresh server nonce. No phrase involved.
 */

import * as api from "@/services/api";
import { getAuthAddressAccount } from "@/services/authAddress";
import { signProtocolAuthToken } from "@/services/protocolAuth";
import type { LoginResponse } from "@/types/api";

const HTTP_FORBIDDEN = 403;

export type DeviceLoginErrorCode = "no_auth_address" | "signer_not_linked";

export class DeviceLoginError extends Error {
  constructor(readonly code: DeviceLoginErrorCode) {
    super(
      code === "no_auth_address"
        ? "This device hasn't been linked to that account yet."
        : "This device's key isn't linked to that account.",
    );
    this.name = "DeviceLoginError";
  }
}

/**
 * Log in as `fid` with this device's auth address.
 *
 * Throws `DeviceLoginError` when the phrase-link flow is required: either the
 * device has no auth address for the FID, or the backend answers
 * `403 signer_not_linked`. Any other failure propagates unchanged.
 */
export async function loginWithAuthAddress(
  fid: number,
): Promise<LoginResponse> {
  const account = await getAuthAddressAccount(fid);
  if (!account) throw new DeviceLoginError("no_auth_address");

  const { nonce } = await api.getSiwfNonce();
  const token = await signProtocolAuthToken({ signer: account, fid, nonce });
  try {
    return await api.protocolLogin({ token, use_cookie: false });
  } catch (error) {
    if (
      api.getApiErrorStatus(error) === HTTP_FORBIDDEN &&
      api.getApiErrorCode(error) === "signer_not_linked"
    ) {
      throw new DeviceLoginError("signer_not_linked");
    }
    throw error;
  }
}

/** RPC lag after approval: try for ~10s before giving up. */
export const POST_LINK_LOGIN_ATTEMPTS = 5;
export const POST_LINK_LOGIN_RETRY_DELAY_MS = 2_000;

/**
 * First login right after the phrase link is approved. The status poll never
 * hands out a session, so the freshly added auth address signs in like any
 * other day; `signer_not_linked` is retried briefly because the backend's
 * KeyRegistry read can trail the approval by a block or two.
 */
export async function loginWithAuthAddressAfterLink(
  fid: number,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<LoginResponse> {
  const attempts = Math.max(options.attempts ?? POST_LINK_LOGIN_ATTEMPTS, 1);
  const delayMs = options.delayMs ?? POST_LINK_LOGIN_RETRY_DELAY_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await loginWithAuthAddress(fid);
    } catch (error) {
      const isLagging =
        error instanceof DeviceLoginError && error.code === "signer_not_linked";
      if (!isLagging || attempt >= attempts) throw error;
    }
    await sleep(delayMs);
  }
}
