import * as SecureStore from 'expo-secure-store';

const KEYS = {
  JWT: 'auth_jwt',
  REFRESH_TOKEN: 'auth_refresh_token',
  USER_PROFILE: 'user_profile',
} as const;

export interface StoredTokens {
  jwt: string;
  refreshToken: string;
}

// --- Tokens ---

export async function saveTokens(jwt: string, refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.JWT, jwt);
  await SecureStore.setItemAsync(KEYS.REFRESH_TOKEN, refreshToken);
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
}

export async function saveUserProfile(profile: StoredUserProfile): Promise<void> {
  await SecureStore.setItemAsync(KEYS.USER_PROFILE, JSON.stringify(profile));
}

export async function getUserProfile(): Promise<StoredUserProfile | null> {
  const data = await SecureStore.getItemAsync(KEYS.USER_PROFILE);
  if (!data) return null;
  const parsed = JSON.parse(data);
  return { ...parsed, is_pro: parsed.is_pro ?? false };
}

export async function clearUserProfile(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.USER_PROFILE);
}

// --- Clear All ---

export async function clearAll(): Promise<void> {
  await clearTokens();
  await clearUserProfile();
}
