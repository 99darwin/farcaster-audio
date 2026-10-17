import * as SecureStore from "expo-secure-store";
import type { SignerStatus } from "@/types/user";

/**
 * Keychain accessibility for all stored credentials. `_THIS_DEVICE_ONLY`
 * prevents items from migrating via iCloud Keychain / encrypted backups, so
 * a compromised Apple ID does not yield the user's tokens or signer keys.
 */
const SECURE_STORE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const KEYS = {
  JWT: "auth_jwt",
  REFRESH_TOKEN: "auth_refresh_token",
  EXPIRES_AT: "auth_expires_at",
  USER_PROFILE: "user_profile",
} as const;

export interface StoredTokens {
  jwt: string;
  refreshToken: string;
  expiresAt: string | null;
}

// --- Tokens ---

export async function saveTokens(
  jwt: string,
  refreshToken: string | null,
  expiresAt?: string | null,
): Promise<void> {
  // Guard against partial writes: if the refresh token is missing (cookie
  // mode response, which iOS never opts into), we never want a half-written
  // session in Keychain — JWT present, refresh missing — to survive across
  // launches. Throw before any setItem call.
  if (!refreshToken) {
    throw new Error("saveTokens: refresh_token is required");
  }
  await SecureStore.setItemAsync(KEYS.JWT, jwt, SECURE_STORE_OPTS);
  await SecureStore.setItemAsync(
    KEYS.REFRESH_TOKEN,
    refreshToken,
    SECURE_STORE_OPTS,
  );
  if (expiresAt) {
    await SecureStore.setItemAsync(
      KEYS.EXPIRES_AT,
      expiresAt,
      SECURE_STORE_OPTS,
    );
  } else {
    await SecureStore.deleteItemAsync(KEYS.EXPIRES_AT);
  }
}

export async function getTokens(): Promise<StoredTokens | null> {
  const jwt = await SecureStore.getItemAsync(KEYS.JWT);
  const refreshToken = await SecureStore.getItemAsync(KEYS.REFRESH_TOKEN);
  if (!jwt || !refreshToken) return null;
  const expiresAt = await SecureStore.getItemAsync(KEYS.EXPIRES_AT);
  return { jwt, refreshToken, expiresAt };
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.JWT);
  await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN);
  await SecureStore.deleteItemAsync(KEYS.EXPIRES_AT);
}

// --- User Profile ---

export interface StoredUserProfile {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  custody_address: string;
  is_pro: boolean;
  is_admin: boolean;
  signer_status?: SignerStatus;
}

export async function saveUserProfile(
  profile: StoredUserProfile,
): Promise<void> {
  await SecureStore.setItemAsync(
    KEYS.USER_PROFILE,
    JSON.stringify(profile),
    SECURE_STORE_OPTS,
  );
}

export async function getUserProfile(): Promise<StoredUserProfile | null> {
  const data = await SecureStore.getItemAsync(KEYS.USER_PROFILE);
  if (!data) return null;
  const parsed = JSON.parse(data);
  return {
    ...parsed,
    is_pro: parsed.is_pro ?? false,
    is_admin: parsed.is_admin ?? false,
  };
}

export async function clearUserProfile(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.USER_PROFILE);
}

// --- Push Token ---

const PUSH_TOKEN_KEY = "push_token";

export async function savePushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token, SECURE_STORE_OPTS);
}

export async function getPushToken(): Promise<string | null> {
  return SecureStore.getItemAsync(PUSH_TOKEN_KEY);
}

export async function clearPushToken(): Promise<void> {
  await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
}

// --- Notification Timestamp ---

const LAST_SEEN_NOTIFICATION_KEY = "last_seen_notification_ts";

export async function getLastSeenNotificationTimestamp(): Promise<
  string | null
> {
  return SecureStore.getItemAsync(LAST_SEEN_NOTIFICATION_KEY);
}

export async function saveLastSeenNotificationTimestamp(
  timestamp: string,
): Promise<void> {
  await SecureStore.setItemAsync(
    LAST_SEEN_NOTIFICATION_KEY,
    timestamp,
    SECURE_STORE_OPTS,
  );
}

// --- Last linked FID ---
// Remembered across logout (deliberately not part of `clearAll`) so a device
// that already holds an on-chain auth address can sign back in with one tap.
// An FID is public, so this holds nothing sensitive.

const LAST_LINKED_FID_KEY = "last_linked_fid";

export async function saveLastLinkedFid(fid: number): Promise<void> {
  await SecureStore.setItemAsync(
    LAST_LINKED_FID_KEY,
    String(fid),
    SECURE_STORE_OPTS,
  );
}

export async function getLastLinkedFid(): Promise<number | null> {
  const raw = await SecureStore.getItemAsync(LAST_LINKED_FID_KEY);
  if (!raw) return null;
  const fid = Number(raw);
  return Number.isSafeInteger(fid) && fid > 0 ? fid : null;
}

// --- Clear All ---

export async function clearAll(): Promise<void> {
  await clearTokens();
  await clearUserProfile();
}
