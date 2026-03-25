import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { Config } from '@/constants/config';
import { getTokens, saveTokens } from '@/services/storage';
import type {
  AuthUrlResponse,
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RoomCreateRequest,
  RoomCreateResponse,
  RoomListResponse,
  RoomDetailResponse,
  JoinResponse,
  RaiseHandRequest,
  RaiseHandResponse,
  PromoteResponse,
  BanRequest,
  BanResponse,
  TokenRefreshResponse,
  StatusResponse,
} from '@/types/api';

const apiClient: AxiosInstance = axios.create({
  baseURL: Config.API_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor: attach JWT
apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const tokens = await getTokens();
  if (tokens?.jwt) {
    config.headers.Authorization = `Bearer ${tokens.jwt}`;
  }
  return config;
});

// Response interceptor: handle 401 with token refresh
let isRefreshing = false;
let failedQueue: Array<{ resolve: (token: string) => void; reject: (error: unknown) => void }> = [];

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
      console.error(`[API] ${error.config?.method?.toUpperCase()} ${error.config?.url} → ${error.response?.status}`, error.response?.data);
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
        if (!tokens?.refreshToken) throw new Error('No refresh token');
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
  apiClient.get<AuthUrlResponse>('/v1/auth/neynar-auth-url').then((r) => r.data);

export const login = (body: LoginRequest) =>
  apiClient.post<LoginResponse>('/v1/auth/login', body).then((r) => r.data);

export const devLogin = () =>
  apiClient.post<LoginResponse>('/v1/auth/dev-login').then((r) => r.data);

export const refreshAuth = (body: RefreshRequest) =>
  apiClient.post<LoginResponse>('/v1/auth/refresh', body).then((r) => r.data);

// --- Rooms ---
export const listRooms = (params?: { status?: string; limit?: number; cursor?: string }) =>
  apiClient.get<RoomListResponse>('/v1/rooms', { params }).then((r) => r.data);

export const createRoom = (body: RoomCreateRequest) =>
  apiClient.post<RoomCreateResponse>('/v1/rooms', body).then((r) => r.data);

export const getRoom = (roomId: string) =>
  apiClient.get<RoomDetailResponse>(`/v1/rooms/${roomId}`).then((r) => r.data);

export const endRoom = (roomId: string) =>
  apiClient.delete<StatusResponse>(`/v1/rooms/${roomId}`).then((r) => r.data);

// --- Participants ---
export const joinRoom = (roomId: string) =>
  apiClient.post<JoinResponse>(`/v1/rooms/${roomId}/join`).then((r) => r.data);

export const leaveRoom = (roomId: string) =>
  apiClient.post<StatusResponse>(`/v1/rooms/${roomId}/leave`).then((r) => r.data);

export const raiseHand = (roomId: string, body: RaiseHandRequest) =>
  apiClient.post<RaiseHandResponse>(`/v1/rooms/${roomId}/raise-hand`, body).then((r) => r.data);

export const promoteParticipant = (roomId: string, fid: number) =>
  apiClient.post<PromoteResponse>(`/v1/rooms/${roomId}/participants/${fid}/promote`).then((r) => r.data);

export const demoteParticipant = (roomId: string, fid: number) =>
  apiClient.post<PromoteResponse>(`/v1/rooms/${roomId}/participants/${fid}/demote`).then((r) => r.data);

export const muteParticipant = (roomId: string, fid: number) =>
  apiClient.post<StatusResponse>(`/v1/rooms/${roomId}/participants/${fid}/mute`).then((r) => r.data);

export const kickParticipant = (roomId: string, fid: number) =>
  apiClient.post<StatusResponse>(`/v1/rooms/${roomId}/participants/${fid}/kick`).then((r) => r.data);

export const banParticipant = (roomId: string, fid: number, body: BanRequest) =>
  apiClient.post<BanResponse>(`/v1/rooms/${roomId}/participants/${fid}/ban`, body).then((r) => r.data);

export const refreshRoomToken = (roomId: string) =>
  apiClient.post<TokenRefreshResponse>(`/v1/rooms/${roomId}/token`).then((r) => r.data);

// --- Users ---
export const getUserProfile = (fid: number) =>
  apiClient.get(`/v1/users/${fid}`).then((r) => r.data);

export const getUserByUsername = (username: string) =>
  apiClient.get(`/v1/users/by-username/${encodeURIComponent(username)}`).then((r) => r.data);

export const getUserCasts = (fid: number, params?: { limit?: number; cursor?: string }) =>
  apiClient.get(`/v1/users/${fid}/casts`, { params }).then((r) => r.data);

export const followUser = (fid: number) =>
  apiClient.post(`/v1/users/${fid}/follow`).then((r) => r.data);

export const unfollowUser = (fid: number) =>
  apiClient.delete(`/v1/users/${fid}/follow`).then((r) => r.data);

// --- Media ---
export async function uploadImage(uri: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', {
    uri,
    type: 'image/jpeg',
    name: 'upload.jpg',
  } as any);

  const { data } = await apiClient.post<{ url: string }>('/v1/media/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
  return data.url;
}

// --- Notifications ---
export const getNotifications = (params?: { limit?: number; cursor?: string }) =>
  apiClient.get<import('@/types/neynar').NotificationsResponse>('/v1/notifications', { params }).then((r) => r.data);

// Error helper
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.detail || error.message || 'An error occurred';
  }
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred';
}
