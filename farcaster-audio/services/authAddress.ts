/**
 * Device auth address management.
 *
 * Generates a secp256k1 keypair on device and keeps it in SecureStore. The
 * address is added on-chain to KeyRegistry (keyType 2) during the one-time
 * recovery-phrase link, after which it signs Protocol Auth logins (see
 * `services/deviceLogin.ts`) and miniapp SIWF messages.
 */

import "@/utils/cryptoPolyfill";
import * as SecureStore from "expo-secure-store";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import * as api from "@/services/api";

const AUTH_ADDRESS_KEY_PREFIX = "auth_address_key_";
const AUTH_ADDRESS_STATUS_PREFIX = "auth_address_status_";
const PRIVATE_KEY_PATTERN = /^0x[0-9a-f]{64}$/i;
/**
 * The auth address key can log in as the user, so it must never migrate off
 * the device via iCloud Keychain or encrypted backups.
 */
const AUTH_ADDRESS_KEY_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// --- Key management ---

/** Get or create an auth address keypair for the given FID. */
export async function getOrCreateAuthAddress(fid: number): Promise<{
  address: `0x${string}`;
  privateKey: `0x${string}`;
  isNew: boolean;
}> {
  const storageKey = `${AUTH_ADDRESS_KEY_PREFIX}${fid}`;
  const existing = await SecureStore.getItemAsync(storageKey);

  if (existing) {
    if (!PRIVATE_KEY_PATTERN.test(existing)) {
      // Corrupted key — delete and regenerate
      await SecureStore.deleteItemAsync(storageKey);
    } else {
      const privateKey = existing as `0x${string}`;
      // Keys written before the Hypersnap migration used the backup-restorable
      // default accessibility; overwriting re-applies THIS_DEVICE_ONLY.
      await SecureStore.setItemAsync(
        storageKey,
        privateKey,
        AUTH_ADDRESS_KEY_OPTS,
      );
      const account = privateKeyToAccount(privateKey);
      return { address: account.address, privateKey, isNew: false };
    }
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  await SecureStore.setItemAsync(storageKey, privateKey, AUTH_ADDRESS_KEY_OPTS);
  return { address: account.address, privateKey, isNew: true };
}

/**
 * The existing auth address account for this FID, or null when the device
 * has none (or it is corrupted). Never creates a key: a fresh key is only
 * useful once it has been linked through the recovery-phrase flow.
 */
export async function getAuthAddressAccount(
  fid: number,
): Promise<PrivateKeyAccount | null> {
  const existing = await SecureStore.getItemAsync(
    `${AUTH_ADDRESS_KEY_PREFIX}${fid}`,
  );
  if (!existing || !PRIVATE_KEY_PATTERN.test(existing)) return null;
  return privateKeyToAccount(existing as `0x${string}`);
}

/**
 * Record that this FID's auth address is in KeyRegistry. Called after the
 * on-chain link is approved so miniapp signIn skips its approval round-trip.
 */
export async function markAuthAddressApproved(fid: number): Promise<void> {
  await SecureStore.setItemAsync(
    `${AUTH_ADDRESS_STATUS_PREFIX}${fid}`,
    "approved",
    AUTH_ADDRESS_KEY_OPTS,
  );
}

export type AuthAddressStatus = "none" | "pending_approval" | "approved";

/**
 * Check if an auth address is registered and approved for this FID.
 *
 * Fast path: persisted `approved` is returned without any network call.
 * The cache is only cleared explicitly via `invalidateAuthAddress` after a
 * signing failure surfaces revocation. Pass `{ force: true }` to bypass the
 * cache (used by AppState-driven post-approval confirmation).
 */
export async function getAuthAddressStatus(
  fid: number,
  opts: { force?: boolean } = {},
): Promise<AuthAddressStatus> {
  if (!opts.force) {
    const cached = await SecureStore.getItemAsync(
      `${AUTH_ADDRESS_STATUS_PREFIX}${fid}`,
    );
    if (cached === "approved") return "approved";
  }

  // Check if we even have a key
  const storageKey = `${AUTH_ADDRESS_KEY_PREFIX}${fid}`;
  const existing = await SecureStore.getItemAsync(storageKey);
  if (!existing) return "none";

  if (!PRIVATE_KEY_PATTERN.test(existing)) {
    await SecureStore.deleteItemAsync(storageKey);
    return "none";
  }

  // Check with backend
  const account = privateKeyToAccount(existing as `0x${string}`);
  try {
    const result = await api.getAuthAddressStatus(account.address);
    if (result.status === "approved") {
      await SecureStore.setItemAsync(
        `${AUTH_ADDRESS_STATUS_PREFIX}${fid}`,
        "approved",
        AUTH_ADDRESS_KEY_OPTS,
      );
      return "approved";
    }
    await SecureStore.deleteItemAsync(`${AUTH_ADDRESS_STATUS_PREFIX}${fid}`);
    return result.status === "pending_approval" ? "pending_approval" : "none";
  } catch {
    return "none";
  }
}

/**
 * Clear the locally cached auth address status and notify the backend.
 * Invoked after a signing failure that looks like revocation. Silently
 * tolerates a missing backend endpoint (404).
 */
export async function invalidateAuthAddress(fid: number): Promise<void> {
  await SecureStore.deleteItemAsync(`${AUTH_ADDRESS_STATUS_PREFIX}${fid}`);
  const storageKey = `${AUTH_ADDRESS_KEY_PREFIX}${fid}`;
  const existing = await SecureStore.getItemAsync(storageKey);
  if (!existing || !PRIVATE_KEY_PATTERN.test(existing)) return;
  try {
    const account = privateKeyToAccount(existing as `0x${string}`);
    await api.invalidateAuthAddress(account.address);
  } catch {
    // Best-effort.
  }
}

// --- SIWF signing ---

const SIWF_DEFAULT_VALIDITY_MS = 5 * 60 * 1000;
/**
 * Upper bound on how long a mini-app-requested SIWF signature stays valid.
 * Without it a page could ask for an `expirationTime` years out and replay
 * the signed message as a long-lived login token.
 */
export const SIWF_MAX_VALIDITY_MS = 10 * 60 * 1000;

function parseSiwfDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${field}`);
  }
  return date;
}

/**
 * Clamp the mini-app-supplied validity window: expiration is capped at
 * now + SIWF_MAX_VALIDITY_MS (never extended), and must be in the future;
 * notBefore must parse, may not sit beyond the cap, and may not follow the
 * expiration.
 */
export function resolveSiwfValidityWindow(
  { notBefore, expirationTime }: { notBefore?: string; expirationTime?: string },
  now: Date = new Date(),
): { notBefore: Date | undefined; expirationTime: Date } {
  const nowMs = now.getTime();
  const maxExpirationMs = nowMs + SIWF_MAX_VALIDITY_MS;

  const requestedExpirationMs = expirationTime
    ? parseSiwfDate(expirationTime, "expirationTime").getTime()
    : nowMs + SIWF_DEFAULT_VALIDITY_MS;
  if (requestedExpirationMs <= nowMs) {
    throw new Error("expirationTime is in the past");
  }
  const expirationMs = Math.min(requestedExpirationMs, maxExpirationMs);

  if (!notBefore) {
    return { notBefore: undefined, expirationTime: new Date(expirationMs) };
  }
  const notBeforeMs = parseSiwfDate(notBefore, "notBefore").getTime();
  if (notBeforeMs > maxExpirationMs) {
    throw new Error("notBefore is too far in the future");
  }
  if (notBeforeMs >= expirationMs) {
    throw new Error("notBefore must precede expirationTime");
  }
  return {
    notBefore: new Date(notBeforeMs),
    expirationTime: new Date(expirationMs),
  };
}

/** Sign a SIWF message for miniapp signIn(). */
export async function signSiwfMessage(
  fid: number,
  options: {
    nonce: string;
    domain: string;
    uri?: string;
    notBefore?: string;
    expirationTime?: string;
  },
): Promise<{ signature: string; message: string }> {
  if (!fid || fid <= 0) {
    throw new Error("Invalid FID");
  }

  // Validate nonce is present and reasonable length
  if (
    !options.nonce ||
    options.nonce.length < 8 ||
    options.nonce.length > 256
  ) {
    throw new Error("Invalid nonce format");
  }

  const now = new Date();
  const validity = resolveSiwfValidityWindow(
    { notBefore: options.notBefore, expirationTime: options.expirationTime },
    now,
  );

  const storageKey = `${AUTH_ADDRESS_KEY_PREFIX}${fid}`;
  const privateKey = await SecureStore.getItemAsync(storageKey);
  if (!privateKey) {
    throw new Error("No auth address key found");
  }

  if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error("Corrupted auth address key");
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const message = createSiweMessage({
    address: account.address,
    chainId: 10,
    domain: options.domain,
    nonce: options.nonce,
    uri: options.uri ?? `https://${options.domain}`,
    version: "1",
    statement: "Farcaster Auth",
    resources: [`farcaster://fid/${fid}`],
    issuedAt: now,
    notBefore: validity.notBefore,
    expirationTime: validity.expirationTime,
  });

  const signature = await account.signMessage({ message });

  return { signature, message };
}
