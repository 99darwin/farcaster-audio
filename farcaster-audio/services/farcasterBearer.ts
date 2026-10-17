/**
 * DORMANT — no active call sites as of the backend-orchestrated
 * Farcaster-native spaces rollout. Kept as a known-good reference for
 * the day Warpcast ships a sign-as-custody primitive in the Mini App
 * SDK; until then, this file is unreachable from the active app.
 *
 * Storage for the Farcaster-native bearer token.
 *
 * SECURITY: there is intentionally NO deep-link ingestion path. The old
 * `juke://sync-complete#bearer=...` handler accepted a bearer from any
 * link with no state / pending-request / fid binding, so any web page
 * could plant an attacker-controlled bearer. That handler and its parser
 * are gone. A future flow that calls `setFarcasterBearer` MUST bind the
 * response to a single-use, short-lived random `state` held in
 * SecureStore and MUST verify the bearer's fid equals the logged-in
 * user's fid before storing it.
 *
 * Storage: Expo SecureStore (iOS Keychain / Android Keystore), keyed
 * `juke.farcaster.bearer.v2`. The `v1` key was only ever written by the
 * untrusted deep-link path, so anything under it is discarded unread.
 *
 * The secret is treated as opaque and never logged. Diagnostics use only
 * length / expiresAt.
 */

import * as SecureStore from "expo-secure-store";

import { BEARER_EXPIRING_SOON_HOURS } from "@/constants/farcaster";

export interface FarcasterBearer {
  /** Opaque bearer from client.farcaster.xyz. Never log this. */
  secret: string;
  /** Unix epoch milliseconds at which the bearer stops being valid. */
  expiresAt: number;
  /** Custody address (EVM) that minted the bearer. */
  custodyAddress: string;
  /** Farcaster ID associated with the bearer. */
  fid: number;
}

const STORAGE_KEY = "juke.farcaster.bearer.v2";
/**
 * Written only by the removed, unauthenticated `sync-complete` deep link,
 * so its contents may be attacker-planted. Purged, never read.
 */
const LEGACY_UNTRUSTED_STORAGE_KEY = "juke.farcaster.bearer.v1";

/**
 * SecureStore options. `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` keeps the
 * bearer readable after a cold reboot once the device has been unlocked
 * once (so the app can hydrate without forcing biometrics), and
 * `_THIS_DEVICE_ONLY` blocks iCloud Keychain sync — a compromised Apple
 * ID can't yield this secret. Android side: no biometric requirement —
 * this is a session credential, not a wallet key; gating each space-join
 * on Face ID would be a UX disaster.
 */
const SECURE_STORE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

/**
 * Hard limits on stored fields so a corrupted or oversized blob is
 * rejected rather than trusted. Real bearers fit comfortably under these
 * caps; tighten further only if telemetry says we should.
 */
const MAX_SECRET_LEN = 4096;
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

function isValidBearer(value: unknown): value is FarcasterBearer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.secret === "string" &&
    v.secret.length > 0 &&
    v.secret.length <= MAX_SECRET_LEN &&
    typeof v.expiresAt === "number" &&
    Number.isFinite(v.expiresAt) &&
    typeof v.custodyAddress === "string" &&
    EVM_ADDRESS_REGEX.test(v.custodyAddress) &&
    typeof v.fid === "number" &&
    Number.isFinite(v.fid) &&
    Number.isInteger(v.fid) &&
    v.fid > 0
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the cached bearer. Returns null if absent, malformed, or expired.
 * On malformed or expired data we eagerly clear storage so the app starts
 * from a clean slate next launch.
 */
export async function getFarcasterBearer(): Promise<FarcasterBearer | null> {
  await purgeLegacyUntrustedBearer();
  const raw = await SecureStore.getItemAsync(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (__DEV__) {
      console.warn("[farcasterBearer] malformed JSON in storage; clearing");
    }
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return null;
  }

  if (!isValidBearer(parsed)) {
    if (__DEV__) {
      console.warn("[farcasterBearer] invalid shape in storage; clearing");
    }
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return null;
  }

  if (parsed.expiresAt <= Date.now()) {
    if (__DEV__) {
      console.warn(
        `[farcasterBearer] expired bearer (expiresAt=${parsed.expiresAt}); clearing`,
      );
    }
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return null;
  }

  return parsed;
}

/** Idempotent; a no-op delete once the legacy key is gone. */
async function purgeLegacyUntrustedBearer(): Promise<void> {
  await SecureStore.deleteItemAsync(LEGACY_UNTRUSTED_STORAGE_KEY);
}

/**
 * Store a freshly-minted bearer. Overwrites any prior value. Callers must
 * have authenticated the bearer's origin (see the file header) first.
 */
export async function setFarcasterBearer(b: FarcasterBearer): Promise<void> {
  if (!isValidBearer(b)) {
    throw new Error("setFarcasterBearer: invalid bearer shape");
  }
  await SecureStore.setItemAsync(
    STORAGE_KEY,
    JSON.stringify(b),
    SECURE_STORE_OPTS,
  );
}

/** Wipe the bearer (logout / revoke). Safe to call when absent. */
export async function clearFarcasterBearer(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
  await SecureStore.deleteItemAsync(LEGACY_UNTRUSTED_STORAGE_KEY);
}

/** True if a non-expired bearer is stored. */
export async function hasFarcasterBearer(): Promise<boolean> {
  const b = await getFarcasterBearer();
  return b !== null;
}

/** Returns true if `expiresAt` is within `withinHours` of now. */
export function isExpiringSoon(
  b: FarcasterBearer,
  withinHours: number = BEARER_EXPIRING_SOON_HOURS,
): boolean {
  const windowMs = withinHours * 60 * 60 * 1000;
  return b.expiresAt - Date.now() <= windowMs;
}

/** Storage keys — exported for tests. */
export const __TEST_STORAGE_KEY__ = STORAGE_KEY;
export const __TEST_LEGACY_STORAGE_KEY__ = LEGACY_UNTRUSTED_STORAGE_KEY;
