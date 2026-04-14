import * as SecureStore from "expo-secure-store";

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
  USER_PROFILE: "user_profile",
} as const;

export interface StoredTokens {
  jwt: string;
  refreshToken: string;
}

// --- Tokens ---

export async function saveTokens(
  jwt: string,
  refreshToken: string,
): Promise<void> {
  await SecureStore.setItemAsync(KEYS.JWT, jwt, SECURE_STORE_OPTS);
  await SecureStore.setItemAsync(
    KEYS.REFRESH_TOKEN,
    refreshToken,
    SECURE_STORE_OPTS,
  );
}

export async function getTokens(): Promise<StoredTokens | null> {
  const jwt = await SecureStore.getItemAsync(KEYS.JWT);
  const refreshToken = await SecureStore.getItemAsync(KEYS.REFRESH_TOKEN);
  if (!jwt || !refreshToken) return null;
  return { jwt, refreshToken };
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.JWT);
  await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN);
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

// --- Clear All ---

export async function clearAll(): Promise<void> {
  await clearTokens();
  await clearUserProfile();
}
