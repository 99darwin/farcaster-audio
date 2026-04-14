/**
 * Auth address management for miniapp signIn (SIWF).
 *
 * Generates a secp256k1 keypair on device, registers it as an auth address
 * via the backend + Neynar, and uses it to sign SIWF messages.
 */

import "@/utils/cryptoPolyfill";
import * as SecureStore from "expo-secure-store";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import * as api from "@/services/api";

const AUTH_ADDRESS_KEY_PREFIX = "auth_address_key_";
const AUTH_ADDRESS_STATUS_PREFIX = "auth_address_status_";

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
    if (!/^0x[0-9a-f]{64}$/i.test(existing)) {
      // Corrupted key — delete and regenerate
      await SecureStore.deleteItemAsync(storageKey);
    } else {
      const privateKey = existing as `0x${string}`;
      const account = privateKeyToAccount(privateKey);
      return { address: account.address, privateKey, isNew: false };
    }
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  await SecureStore.setItemAsync(storageKey, privateKey);
  return { address: account.address, privateKey, isNew: true };
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

  if (!/^0x[0-9a-f]{64}$/i.test(existing)) {
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
  if (!existing || !/^0x[0-9a-f]{64}$/i.test(existing)) return;
  try {
    const account = privateKeyToAccount(existing as `0x${string}`);
    await api.invalidateAuthAddress(account.address);
  } catch {
    // Best-effort.
  }
}

// --- Registration ---

/** Register an auth address with Neynar. Returns the approval URL. */
export async function registerAuthAddress(fid: number): Promise<{
  address: string;
  approvalUrl: string | null;
  status: string;
}> {
  const { address } = await getOrCreateAuthAddress(fid);

  const result = await api.registerAuthAddress(address);

  if (result.status === "approved") {
    await SecureStore.setItemAsync(
      `${AUTH_ADDRESS_STATUS_PREFIX}${fid}`,
      "approved",
    );
  }

  return {
    address: result.auth_address,
    approvalUrl: result.approval_url,
    status: result.status,
  };
}

// --- SIWF signing ---

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

  const storageKey = `${AUTH_ADDRESS_KEY_PREFIX}${fid}`;
  const privateKey = await SecureStore.getItemAsync(storageKey);
  if (!privateKey) {
    throw new Error("No auth address key found");
  }

  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
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
    issuedAt: new Date(),
    notBefore: options.notBefore ? new Date(options.notBefore) : undefined,
    expirationTime: options.expirationTime
      ? new Date(options.expirationTime)
      : new Date(Date.now() + 5 * 60 * 1000),
  });

  const signature = await account.signMessage({ message });

  return { signature, message };
}
