import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { Config } from "@/constants/config";
import { getTokens, saveTokens } from "@/services/storage";
import type {
  AuthUrlResponse,
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RoomCreateRequest,
  RoomCreateResponse,
  RoomGoLiveResponse,
  RoomListResponse,
  RoomDetailResponse,
  RoomChatTargetResponse,
  JoinResponse,
  RaiseHandRequest,
  RaiseHandResponse,
  PromoteResponse,
  BanRequest,
  BanResponse,
  TokenRefreshResponse,
  StatusResponse,
  RegisterAuthAddressResponse,
  AuthAddressStatusResponse,
  RegisterSnapSignerResponse,
  SnapSignerStatusResponse,
  RsvpResponse,
  CastCreateRequest,
  CastCreateResponse,
  ChannelFeedResponse,
  BookmarksFeedResponse,
  ChannelSearchResponse,
  BlockUserResponse,
  BlockedUsersResponse,
  CastSearchResponse,
  MiniappSearchResponse,
} from "@/types/api";

export const apiClient: AxiosInstance = axios.create({
  baseURL: Config.API_BASE_URL,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

// Request interceptor: attach JWT
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const tokens = await getTokens();
    if (tokens?.jwt) {
      config.headers.Authorization = `Bearer ${tokens.jwt}`;
    }
    return config;
  },
);

// Response interceptor: handle 401 with token refresh
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else if (token) resolve(token);
  });
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (__DEV__) {
      console.error(
        `[API] ${error.config?.method?.toUpperCase()} ${error.config?.url} → ${error.response?.status}`,
        error.response?.data,
      );
    }
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({
            resolve: (token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              resolve(apiClient(originalRequest));
            },
            reject,
          });
        });
      }
      originalRequest._retry = true;
      isRefreshing = true;
      try {
        const tokens = await getTokens();
        if (!tokens?.refreshToken) throw new Error("No refresh token");
        const { data } = await axios.post<LoginResponse>(
          `${Config.API_BASE_URL}/v1/auth/refresh`,
          { refresh_token: tokens.refreshToken },
          { headers: { Authorization: `Bearer ${tokens.jwt}` } },
        );
        await saveTokens(data.jwt, data.refresh_token);
        processQueue(null, data.jwt);
        originalRequest.headers.Authorization = `Bearer ${data.jwt}`;
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        throw refreshError;
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(error);
  },
);

// --- Auth ---
export const getAuthUrl = () =>
  apiClient
    .get<AuthUrlResponse>("/v1/auth/neynar-auth-url")
    .then((r) => r.data);

export const login = (body: LoginRequest) =>
  apiClient.post<LoginResponse>("/v1/auth/login", body).then((r) => r.data);

export const devLogin = () =>
  apiClient.post<LoginResponse>("/v1/auth/dev-login").then((r) => r.data);

export const refreshAuth = (body: RefreshRequest) =>
  apiClient.post<LoginResponse>("/v1/auth/refresh", body).then((r) => r.data);

// --- Rooms ---
export const listRooms = (params?: {
  status?: string;
  limit?: number;
  cursor?: string;
}) =>
  apiClient.get<RoomListResponse>("/v1/rooms", { params }).then((r) => r.data);

export const createRoom = (body: RoomCreateRequest) =>
  apiClient.post<RoomCreateResponse>("/v1/rooms", body).then((r) => r.data);

export const getRoom = (roomId: string) =>
  apiClient.get<RoomDetailResponse>(`/v1/rooms/${roomId}`).then((r) => r.data);

export const ensureRoomChatTarget = (roomId: string) =>
  apiClient
    .post<RoomChatTargetResponse>(`/v1/rooms/${roomId}/chat-target`)
    .then((r) => r.data);

export const startRoom = (roomId: string) =>
  apiClient
    .post<RoomGoLiveResponse>(`/v1/rooms/${roomId}/start`)
    .then((r) => r.data);

export const endRoom = (roomId: string) =>
  apiClient.delete<StatusResponse>(`/v1/rooms/${roomId}`).then((r) => r.data);

// --- RSVP ---
export const rsvpRoom = (roomId: string) =>
  apiClient.post<RsvpResponse>(`/v1/rooms/${roomId}/rsvp`).then((r) => r.data);

export const unrsvpRoom = (roomId: string) =>
  apiClient
    .delete<RsvpResponse>(`/v1/rooms/${roomId}/rsvp`)
    .then((r) => r.data);

// --- Participants ---
export const joinRoom = (roomId: string) =>
  apiClient.post<JoinResponse>(`/v1/rooms/${roomId}/join`).then((r) => r.data);

export const leaveRoom = (roomId: string) =>
  apiClient
    .post<StatusResponse>(`/v1/rooms/${roomId}/leave`)
    .then((r) => r.data);

export const raiseHand = (roomId: string, body: RaiseHandRequest) =>
  apiClient
    .post<RaiseHandResponse>(`/v1/rooms/${roomId}/raise-hand`, body)
    .then((r) => r.data);

export const promoteParticipant = (roomId: string, fid: number) =>
  apiClient
    .post<PromoteResponse>(`/v1/rooms/${roomId}/participants/${fid}/promote`)
    .then((r) => r.data);

export const demoteParticipant = (roomId: string, fid: number) =>
  apiClient
    .post<PromoteResponse>(`/v1/rooms/${roomId}/participants/${fid}/demote`)
    .then((r) => r.data);

export const muteParticipant = (roomId: string, fid: number) =>
  apiClient
    .post<StatusResponse>(`/v1/rooms/${roomId}/participants/${fid}/mute`)
    .then((r) => r.data);

export const kickParticipant = (roomId: string, fid: number) =>
  apiClient
    .post<StatusResponse>(`/v1/rooms/${roomId}/participants/${fid}/kick`)
    .then((r) => r.data);

export const banParticipant = (roomId: string, fid: number, body: BanRequest) =>
  apiClient
    .post<BanResponse>(`/v1/rooms/${roomId}/participants/${fid}/ban`, body)
    .then((r) => r.data);

export const refreshRoomToken = (roomId: string) =>
  apiClient
    .post<TokenRefreshResponse>(`/v1/rooms/${roomId}/token`)
    .then((r) => r.data);

// --- Recording ---
export interface StartRecordingResponse {
  egress_id: string;
  status: string;
}

export interface StopRecordingResponse {
  status: string;
}

export const startRecording = (roomId: string) =>
  apiClient
    .post<StartRecordingResponse>(`/v1/rooms/${roomId}/recording/start`)
    .then((r) => r.data);

export const stopRecording = (roomId: string) =>
  apiClient
    .post<StopRecordingResponse>(`/v1/rooms/${roomId}/recording/stop`)
    .then((r) => r.data);

export interface RecordingItem {
  room_id: string;
  title: string;
  recording_url: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface RecordingListResponse {
  recordings: RecordingItem[];
  next_cursor: string | null;
}

export const getUserRecordings = (fid: number, cursor?: string) =>
  apiClient
    .get<RecordingListResponse>(`/v1/users/${fid}/recordings`, {
      params: { cursor, limit: 20 },
    })
    .then((r) => r.data);

// --- Users ---
export interface UserSearchItem {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  bio?: string | null;
  follower_count?: number | null;
}

export interface UserSearchResponse {
  users: UserSearchItem[];
}

export const searchUsers = (
  q: string,
  limit = 5,
  options?: { signal?: AbortSignal },
) =>
  apiClient
    .get<UserSearchResponse>("/v1/users/search", {
      params: { q, limit },
      signal: options?.signal,
    })
    .then((r) => r.data);

export const getUserProfile = (fid: number) =>
  apiClient.get(`/v1/users/${fid}`).then((r) => r.data);

export const getUserByUsername = (username: string) =>
  apiClient
    .get(`/v1/users/by-username/${encodeURIComponent(username)}`)
    .then((r) => r.data);

export const getUserCasts = (
  fid: number,
  params?: { limit?: number; cursor?: string },
) => apiClient.get(`/v1/users/${fid}/casts`, { params }).then((r) => r.data);

export const followUser = (fid: number) =>
  apiClient.post(`/v1/users/${fid}/follow`).then((r) => r.data);

export const unfollowUser = (fid: number) =>
  apiClient.delete(`/v1/users/${fid}/follow`).then((r) => r.data);

export const blockUser = (fid: number, reason?: string) =>
  apiClient
    .post<BlockUserResponse>(`/v1/users/${fid}/block`, reason ? { reason } : {})
    .then((r) => r.data);

export const unblockUser = (fid: number) =>
  apiClient
    .delete<BlockUserResponse>(`/v1/users/${fid}/block`)
    .then((r) => r.data);

export const getBlockedUsers = () =>
  apiClient.get<BlockedUsersResponse>("/v1/users/blocked").then((r) => r.data);

// --- Feed / Channels ---
export const getChannelFeed = (
  channelId: string,
  params?: { limit?: number; cursor?: string },
) =>
  apiClient
    .get<ChannelFeedResponse>(
      `/v1/feed/channel/${encodeURIComponent(channelId)}`,
      { params },
    )
    .then((r) => r.data);

export const getBookmarkedCasts = (params?: {
  limit?: number;
  cursor?: string;
}) =>
  apiClient
    .get<BookmarksFeedResponse>("/v1/feed/bookmarks", { params })
    .then((r) => r.data);

export const searchChannels = (
  q: string,
  limit = 8,
  options?: { signal?: AbortSignal },
) =>
  apiClient
    .get<ChannelSearchResponse>("/v1/feed/channels/search", {
      params: { q, limit },
      signal: options?.signal,
    })
    .then((r) => r.data);

// --- Search (global) ---
export const searchCasts = (
  q: string,
  sort: "popular" | "recent" = "popular",
  cursor?: string,
  options?: { signal?: AbortSignal; limit?: number },
) =>
  apiClient
    .get<CastSearchResponse>("/v1/search/casts", {
      params: { q, sort, cursor, limit: options?.limit ?? 20 },
      signal: options?.signal,
    })
    .then((r) => r.data);

export const searchMiniapps = (
  q: string,
  cursor?: string,
  options?: { signal?: AbortSignal; limit?: number },
) =>
  apiClient
    .get<MiniappSearchResponse>("/v1/search/miniapps", {
      params: { q, cursor, limit: options?.limit ?? 12 },
      signal: options?.signal,
    })
    .then((r) => r.data);

export const publishCastToChannel = (
  body: CastCreateRequest,
): Promise<{ hash: string }> =>
  apiClient.post<CastCreateResponse>("/v1/feed/cast", body).then((r) => {
    const data = r.data;
    return data.cast ?? { hash: data.hash ?? "" };
  });

export const bookmarkCast = (castHash: string) =>
  apiClient.post(`/v1/feed/bookmarks/${castHash}`).then((r) => r.data);

export const removeBookmark = (castHash: string) =>
  apiClient.delete(`/v1/feed/bookmarks/${castHash}`).then((r) => r.data);

// --- Admin ---
export const adminListRooms = () =>
  apiClient.get<RoomListResponse>("/v1/admin/rooms").then((r) => r.data);

export const adminEndRoom = (roomId: string) =>
  apiClient
    .delete<StatusResponse>(`/v1/admin/rooms/${roomId}`)
    .then((r) => r.data);

export const adminKickParticipant = (roomId: string, fid: number) =>
  apiClient
    .delete<StatusResponse>(`/v1/admin/rooms/${roomId}/participants/${fid}`)
    .then((r) => r.data);

export const adminSetupWebhooks = () =>
  apiClient.post("/v1/admin/setup-webhooks").then((r) => r.data);

// --- OG Metadata ---
export interface OgMetadata {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
}

export const fetchOgMetadata = (url: string) =>
  apiClient
    .get<OgMetadata>("/v1/feed/og", { params: { url }, timeout: 10000 })
    .then((r) => r.data);

// --- Media ---
type MediaUploadResponse = {
  url: string;
  asset_url?: string;
  embed_url?: string;
  media_type?: "image" | "video";
};

export async function uploadImage(uri: string): Promise<string> {
  const ext = uri.split(".").pop()?.toLowerCase() ?? "jpg";
  const mimeType =
    ext === "png"
      ? "image/png"
      : ext === "gif"
        ? "image/gif"
        : ext === "webp"
          ? "image/webp"
          : "image/jpeg";
  const formData = new FormData();
  formData.append("file", {
    uri,
    type: mimeType,
    name: `upload.${ext}`,
  } as any);

  const { data } = await apiClient.post<MediaUploadResponse>(
    "/v1/media/upload",
    formData,
    {
      headers: { "Content-Type": undefined },
      timeout: 60000,
    },
  );
  return data.url;
}

export async function uploadVideo(uri: string): Promise<string> {
  const ext = uri.split(".").pop()?.toLowerCase() ?? "mp4";
  const mimeMap: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };
  const mimeType = mimeMap[ext] ?? "video/mp4";
  const formData = new FormData();
  formData.append("file", {
    uri,
    type: mimeType,
    name: `upload.${ext}`,
  } as any);

  const { data } = await apiClient.post<MediaUploadResponse>(
    "/v1/media/upload",
    formData,
    {
      headers: { "Content-Type": undefined },
      timeout: 120000,
    },
  );
  return data.embed_url ?? data.url;
}

// --- Auth Address ---
export const registerAuthAddress = (authAddress: string) =>
  apiClient
    .post<RegisterAuthAddressResponse>("/v1/auth/auth-address", {
      auth_address: authAddress,
    })
    .then((r) => r.data);

export const getAuthAddressStatus = (address: string) =>
  apiClient
    .get<AuthAddressStatusResponse>("/v1/auth/auth-address/status", {
      params: { address },
    })
    .then((r) => r.data);

/**
 * Mark an auth address as revoked on the backend. Silently tolerates 404 so
 * the frontend can ship before the backend endpoint lands.
 */
export const invalidateAuthAddress = async (address: string): Promise<void> => {
  try {
    await apiClient.post("/v1/auth/auth-address/invalidate", { address });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return;
    throw error;
  }
};

// --- Snap Signer (Ed25519) ---
export const registerSnapSigner = (publicKey: string) =>
  apiClient
    .post<RegisterSnapSignerResponse>("/v1/snaps/register-signer", {
      public_key: publicKey,
    })
    .then((r) => r.data);

export const getSnapSignerStatus = (publicKey: string) =>
  apiClient
    .get<SnapSignerStatusResponse>("/v1/snaps/signer-status", {
      params: { public_key: publicKey },
    })
    .then((r) => r.data);

/**
 * Mark a snap signer as revoked on the backend. Silently tolerates 404 so
 * the frontend can ship before the backend endpoint lands.
 */
export const invalidateSnapSigner = async (
  publicKey: string,
): Promise<void> => {
  try {
    await apiClient.post("/v1/snaps/signer-invalidate", {
      public_key: publicKey,
    });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return;
    throw error;
  }
};

// --- Notifications ---
const inFlightNotifications = new Map<
  string,
  Promise<import("@/types/neynar").NotificationsResponse>
>();
export const getNotifications = (params?: {
  limit?: number;
  cursor?: string;
}): Promise<import("@/types/neynar").NotificationsResponse> => {
  const key = `${params?.limit ?? ""}:${params?.cursor ?? ""}`;
  const existing = inFlightNotifications.get(key);
  if (existing) return existing;
  const promise = apiClient
    .get<import("@/types/neynar").NotificationsResponse>("/v1/notifications", {
      params,
    })
    .then((r) => r.data)
    .finally(() => {
      inFlightNotifications.delete(key);
    });
  inFlightNotifications.set(key, promise);
  return promise;
};

// --- Push Notifications ---
export const registerPushToken = (body: {
  expo_push_token: string;
  device_id?: string;
}) => apiClient.post("/v1/push/token", body).then((r) => r.data);

export const unregisterPushToken = (body: { expo_push_token: string }) =>
  apiClient.delete("/v1/push/token", { data: body }).then((r) => r.data);

export const getNotificationPreferences = () =>
  apiClient.get("/v1/push/preferences").then((r) => r.data);

export const updateNotificationPreferences = (body: Record<string, boolean>) =>
  apiClient.patch("/v1/push/preferences", body).then((r) => r.data);

// Error helper
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.detail || error.message || "An error occurred";
  }
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}
