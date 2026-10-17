import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { Config } from "@/constants/config";
import { getTokens } from "@/services/storage";
import { refreshSession } from "@/services/authRefresh";
import { useAuthStore } from "@/stores/authStore";
import type { Room } from "@/types/space";
import type {
  LoginResponse,
  ProtocolLoginRequest,
  SignerPrepareRequest,
  SignerPrepareResponse,
  SignerRegisterRequest,
  SignerRegisterResponse,
  SignerStatusResponse,
  SiwfNonceResponse,
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

const PROTOCOL_LOGIN_PATH = "/v1/auth/protocol";
const SIWF_NONCE_PATH = "/v1/auth/siwf/nonce";
const REFRESH_PATH = "/v1/auth/refresh";
const DEV_LOGIN_PATH = "/v1/auth/dev-login";
const SIGNER_LINK_PATH_PREFIX = "/v1/auth/signer/";
const HTTP_FORBIDDEN = 403;
const SIGNER_NOT_LINKED_CODE = "signer_not_linked";
const SESSIONLESS_AUTH_PATHS: ReadonlySet<string> = new Set([
  PROTOCOL_LOGIN_PATH,
  SIWF_NONCE_PATH,
  REFRESH_PATH,
  DEV_LOGIN_PATH,
]);

/**
 * Sign-in / signer-link / refresh endpoints don't run on the session JWT, so
 * a 401 from them (e.g. `invalid_token` on a bad hqa1 token) says nothing
 * about the session. Refreshing on it would burn the one-time refresh token
 * and, if that refresh fails, log out a still-valid read-only session.
 */
export function isSessionlessAuthPath(url: string | undefined): boolean {
  if (!url) return false;
  return (
    SESSIONLESS_AUTH_PATHS.has(url) || url.startsWith(SIGNER_LINK_PATH_PREFIX)
  );
}

/**
 * A `403 signer_not_linked` on an authenticated request means the app signer
 * was revoked under an active session. The sign-in endpoint returns the same
 * code before any session exists, so it is excluded.
 */
function isSignerNotLinkedOnSession(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === HTTP_FORBIDDEN &&
    error.config?.url !== PROTOCOL_LOGIN_PATH &&
    getApiErrorCode(error) === SIGNER_NOT_LINKED_CODE
  );
}

// Response interceptor: handle 401 by routing through the shared refresh
// singleton. The singleton de-dupes concurrent refreshes between this
// interceptor and the proactive `useAuthRefresh` hook so we never burn the
// one-time refresh token on a race.
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (__DEV__) {
      console.error(
        `[API] ${error.config?.method?.toUpperCase()} ${error.config?.url} → ${error.response?.status}`,
        error.response?.data?.detail ?? error.response?.status,
      );
    }
    if (isSignerNotLinkedOnSession(error)) {
      void useAuthStore.getState().markSignerNotLinked();
    }
    const originalRequest = error.config;
    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isSessionlessAuthPath(originalRequest.url)
    ) {
      originalRequest._retry = true;
      try {
        const refreshed = await refreshSession();
        if (!refreshed) {
          // Session was invalidated mid-flight (user logged out, or no
          // refresh token to begin with) — bubble the original 401.
          return Promise.reject(error);
        }
        originalRequest.headers.Authorization = `Bearer ${refreshed.jwt}`;
        return apiClient(originalRequest);
      } catch {
        // Transient refresh error — let the original 401 propagate so the
        // caller's existing error handling fires; the next refresh tick will
        // try again.
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  },
);

// --- Auth ---
// Hypersnap Protocol Auth + on-chain signer link. Request/response shapes are
// the frozen auth contract; see types/api.ts. None of these bodies ever carry
// the recovery phrase — only public keys, signatures and the hqa1 token.

export const getSiwfNonce = () =>
  apiClient.post<SiwfNonceResponse>(SIWF_NONCE_PATH).then((r) => r.data);

export const protocolLogin = (body: ProtocolLoginRequest) =>
  apiClient.post<LoginResponse>(PROTOCOL_LOGIN_PATH, body).then((r) => r.data);

export const prepareSigner = (body: SignerPrepareRequest) =>
  apiClient
    .post<SignerPrepareResponse>("/v1/auth/signer/prepare", body)
    .then((r) => r.data);

export const registerSigner = (body: SignerRegisterRequest) =>
  apiClient
    .post<SignerRegisterResponse>("/v1/auth/signer/register", body)
    .then((r) => r.data);

export const getSignerStatus = (prepareId: string) =>
  apiClient
    .get<SignerStatusResponse>("/v1/auth/signer/status", {
      params: { prepare_id: prepareId },
    })
    .then((r) => r.data);

export const devLogin = () =>
  apiClient.post<LoginResponse>(DEV_LOGIN_PATH).then((r) => r.data);

export const refreshAuth = (body: RefreshRequest) =>
  apiClient.post<LoginResponse>(REFRESH_PATH, body).then((r) => r.data);

/**
 * Server-side session revocation. Best-effort — tolerates network errors so
 * the client-side logout always proceeds. The endpoint is idempotent.
 */
export const serverLogout = async (refreshToken: string | null) => {
  try {
    await apiClient.post(
      "/v1/auth/logout",
      refreshToken ? { refresh_token: refreshToken } : {},
      { timeout: 5000 },
    );
  } catch {
    // Swallow — we never want a flaky network to block local logout.
  }
};

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

// --- Farcaster-native room linkage ---
//
// `POST /v1/rooms/link-farcaster` registers a Farcaster-native space with
// Juke so it can show up in discovery, be linked to its root cast, and
// carry recordings / chat history later. The Juke `Room` row returned has
// `is_farcaster_native = true` and `farcaster_room_id` populated; all RPC
// for that room still goes directly to client.farcaster.xyz via
// `services/farcasterSpacesClient`.
export interface LinkFarcasterRoomRequest {
  farcaster_room_id: string;
  title: string;
  scheduled_at?: string | null;
  description?: string | null;
}

export const linkFarcasterRoom = (body: LinkFarcasterRoomRequest) =>
  apiClient
    .post<Room>("/v1/rooms/link-farcaster", body)
    .then((r) => r.data);

// --- Backend-orchestrated Farcaster-native room creation ---
//
// `POST /v1/rooms/native` spawns a Farcaster-native space.
//
// Two dispatch paths, picked by whether `user_jfs_bearer` is set:
//
// 1. User-FID path (preferred): the caller signs a JFS Bearer with
//    their on-device Ed25519 app key (audience
//    `https://client.farcaster.xyz`) — see `signFarcasterClientBearer`.
//    Backend forwards it upstream so the room is hosted by the user's
//    FID directly. Title is verbatim; no stage-invite dance.
// 2. Service-FID fallback: bearer omitted. Backend mints with Juke's
//    service FID and prefixes the upstream title with `@{username}: `
//    so Farcaster clients still attribute the room to the human host.
//    Kept for users who haven't approved an app key yet.
//
// Joining goes through `joinFarcasterNativeRoom` below — fully in-app,
// no Farcaster client bounce.
export interface CreateFarcasterNativeRoomRequest {
  title: string;
  description?: string;
  scheduled_at?: string;
  channel_key?: string;
  user_jfs_bearer?: string;
}

export const createFarcasterNativeRoom = (
  body: CreateFarcasterNativeRoomRequest,
) =>
  apiClient.post<Room>("/v1/rooms/native", body).then((r) => r.data);

// `POST /v1/rooms/{id}/end` ends a Farcaster-native room.
//
// Two host-mode paths picked server-side based on which bearer minted
// the upstream room:
//
//   * `user_fid` (default): the upstream room is hosted by the human
//     user's FID, so only the user's freshly-signed JFS bearer can
//     authorize Farcaster's `audio-room/end` — the service bearer 403s.
//     Caller MUST supply `user_jfs_bearer` in the body.
//   * `service_fid` (legacy fallback): the upstream room is hosted by
//     Juke's service FID, so Juke ends it server-side with the service
//     bearer. `user_jfs_bearer` is ignored on this path.
//
// Only the recorded `host_fid` may call this.
export interface EndFarcasterNativeRoomRequest {
  user_jfs_bearer?: string;
}

export const endFarcasterNativeRoom = (
  roomId: string,
  body?: EndFarcasterNativeRoomRequest,
) =>
  apiClient
    .post<Room>(`/v1/rooms/${roomId}/end`, body ?? {})
    .then((r) => r.data);

// `POST /v1/rooms/{id}/native-start` takes a SCHEDULED Farcaster-native
// room LIVE. The backend calls Farcaster's `audio-room/start-scheduled`
// to flip the upstream room scheduled->live, flips the Juke row to
// `active`, and fires discovery + RSVP pushes. It allocates NO Juke
// LiveKit resources — the host then joins the now-live room exactly
// like joining any active Farcaster-native space (via
// `joinFarcasterNativeRoom`).
//
// Default user-FID host mode REQUIRES `user_jfs_bearer`: the upstream
// room is hosted by the human host's FID, so only their freshly-signed
// JFS bearer can authorize Farcaster's start-scheduled call. Only the
// recorded `host_fid` may call this.
//
// NOTE: the legacy Juke-hosted go-live endpoint is `POST
// /v1/rooms/{id}/start` (`startRoom`), which now REJECTS native rooms
// with HTTP 400.
export interface StartFarcasterNativeRoomRequest {
  user_jfs_bearer?: string;
}

export const startFarcasterNativeRoom = (
  roomId: string,
  body: StartFarcasterNativeRoomRequest,
) =>
  apiClient
    .post<Room>(`/v1/rooms/${roomId}/native-start`, body)
    .then((r) => r.data);

// `POST /v1/rooms/{id}/native-join` trades a user-signed JFS Bearer
// for upstream LiveKit signaling URL + token. The returned `ws_url`
// points at Farcaster's LiveKit project — Juke's LiveKit credentials
// are not used and not consumed. The caller connects directly via the
// existing LiveKit player so the room plays in-app without a deep-link
// bounce to the Farcaster client.
export interface JoinFarcasterNativeRoomRequest {
  user_jfs_bearer: string;
}

export interface JoinFarcasterNativeRoomResponse {
  ws_url: string;
  token: string;
}

export const joinFarcasterNativeRoom = (
  roomId: string,
  body: JoinFarcasterNativeRoomRequest,
) =>
  apiClient
    .post<JoinFarcasterNativeRoomResponse>(
      `/v1/rooms/${roomId}/native-join`,
      body,
    )
    .then((r) => r.data);

// Stage controls for Farcaster-native rooms. All three need the
// caller's own JFS bearer (signed on-device) — Juke's service bearer
// is rejected by Farcaster for user-FID hosted rooms. Backend
// cross-checks the JFS-claimed fid against the JWT fid (and the
// recorded room.host_fid for accept/remove).
export interface RaiseHandFarcasterNativeRequest {
  user_jfs_bearer: string;
  raised: boolean;
}

export const raiseHandFarcasterNative = (
  roomId: string,
  body: RaiseHandFarcasterNativeRequest,
) =>
  apiClient
    .post<StatusResponse>(`/v1/rooms/${roomId}/native-raise-hand`, body)
    .then((r) => r.data);

export interface StageActionFarcasterNativeRequest {
  user_jfs_bearer: string;
  target_fid: number;
}

export const acceptSpeakerFarcasterNative = (
  roomId: string,
  body: StageActionFarcasterNativeRequest,
) =>
  apiClient
    .post<StatusResponse>(`/v1/rooms/${roomId}/native-accept-speaker`, body)
    .then((r) => r.data);

export const removeSpeakerFarcasterNative = (
  roomId: string,
  body: StageActionFarcasterNativeRequest,
) =>
  apiClient
    .post<StatusResponse>(`/v1/rooms/${roomId}/native-remove-speaker`, body)
    .then((r) => r.data);

// Invitee responds to a host's promote-to-speaker invite. Same body
// shape for accept and decline — both just need the invitee's bearer.
// The backend cross-checks JFS fid == JWT fid (only the invitee
// can respond on their own behalf).
export interface StageInviteResponseFarcasterNativeRequest {
  user_jfs_bearer: string;
}

export const acceptStageInviteFarcasterNative = (
  roomId: string,
  body: StageInviteResponseFarcasterNativeRequest,
) =>
  apiClient
    .post<StatusResponse>(
      `/v1/rooms/${roomId}/native-accept-stage-invite`,
      body,
    )
    .then((r) => r.data);

export const declineStageInviteFarcasterNative = (
  roomId: string,
  body: StageInviteResponseFarcasterNativeRequest,
) =>
  apiClient
    .post<StatusResponse>(
      `/v1/rooms/${roomId}/native-decline-stage-invite`,
      body,
    )
    .then((r) => r.data);

// Upsert a Juke `Room` mirror for an upstream-discovered Farcaster
// space so the in-app player can render and join it. Idempotent on
// `farcaster_room_id` — re-mirroring the same space returns the same
// `Room`. Used by the discovery rail to stop deep-linking out to the
// Farcaster client when the user taps a space Juke didn't create.
export interface MirrorNativeRoomRequest {
  farcaster_room_id: string;
  title?: string;
  state?: string;
  host_fid: number;
  host_username?: string | null;
  host_display_name?: string | null;
  host_pfp_url?: string | null;
  started_at?: string | null;
  scheduled_at?: string | null;
  /**
   * Upstream root cast hash for the space's FIP-2 conversation. When
   * supplied, the backend persists it as `Room.cast_hash` so Juke's
   * existing chat surface — which threads replies to a root cast —
   * lights up for native rooms without further wiring.
   */
  root_cast_hash?: string | null;
}

export const mirrorNativeRoom = (body: MirrorNativeRoomRequest) =>
  apiClient
    .post<Room>("/v1/rooms/native/mirror", body)
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
  // Segment UUID — populated on the multi-recording schema. Optional
  // so older backend builds (or rooms with only the legacy
  // single-recording row) still parse cleanly. When present, use this
  // as the playback / route key; otherwise fall back to room_id.
  id?: string;
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

// --- Farcaster-native audio space discovery (read-only proxy) ---
//
// Juke proxies Farcaster's `client.farcaster.xyz/v1/audio-room*` API behind
// `/v1/farcaster-spaces/*` so the mobile app never has to talk to Farcaster
// directly. These types mirror the backend Pydantic response shape
// (snake_case on the wire). List failures propagate so discovery stores can
// retain their last successful snapshot; a successful empty response remains
// distinguishable and intentionally clears the corresponding list.

export interface FarcasterNativeSpaceUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
}

export type FarcasterNativeSpaceState =
  | "scheduled"
  | "live"
  | "ended"
  | (string & {});

export interface FarcasterNativeSpace {
  /** UUID v4 or v7 (Farcaster issues lowercase v7). */
  id: string;
  title?: string;
  description?: string;
  host: FarcasterNativeSpaceUser;
  state: FarcasterNativeSpaceState;
  /** ISO timestamp set when the space transitions to `live`. */
  started_at?: string;
  /** ISO timestamp for scheduled spaces. */
  scheduled_at?: string;
  ended_at?: string;
  listener_count?: number;
  channel_key?: string;
  root_cast_hash?: string;
  root_cast_fid?: number;
}

const FARCASTER_SPACES_TIMEOUT_MS = 5000;

/**
 * List live or scheduled Farcaster-native audio spaces via the Juke proxy.
 *
 * Network and HTTP failures reject. Callers own graceful degradation because
 * they have the previous per-list snapshot needed to avoid UI flicker. A
 * successful response whose body is empty (or not an array) returns `[]`.
 *
 * Backend: `GET /v1/farcaster-spaces/{live|scheduled}?limit=N`.
 */
export async function fetchFarcasterNativeSpaces(args: {
  status: "live" | "scheduled";
  limit?: number;
}): Promise<FarcasterNativeSpace[]> {
  const { status, limit = 30 } = args;
  const res = await apiClient.get<FarcasterNativeSpace[]>(
    `/v1/farcaster-spaces/${status}`,
    { params: { limit }, timeout: FARCASTER_SPACES_TIMEOUT_MS },
  );
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Fetch a single Farcaster-native space snapshot by upstream room id.
 *
 * Used by the cast-embed renderer to populate the Space card without
 * depending on the dead Mini-App custody bearer (which the old
 * `farcasterSpacesClient.fetchAudioRoom` required). Backend proxies via
 * Juke's service-FID bearer; returns `null` on 404 / 5xx / network
 * error so the caller can fall back to the generic OG card.
 *
 * Backend: `GET /v1/farcaster-spaces/{id}`.
 */
export async function fetchFarcasterNativeSpace(
  id: string,
): Promise<FarcasterNativeSpace | null> {
  try {
    const res = await apiClient.get<FarcasterNativeSpace>(
      `/v1/farcaster-spaces/${encodeURIComponent(id)}`,
      { timeout: FARCASTER_SPACES_TIMEOUT_MS },
    );
    return res.data ?? null;
  } catch {
    return null;
  }
}

export interface FarcasterPendingStageInvite {
  role:
    | "host"
    | "cohost"
    | "speaker"
    | "listener"
    | "speaker_invited"
    | (string & {});
  inviter_fid?: number | null;
}

export interface FarcasterNativeSpaceParticipant {
  user: FarcasterNativeSpaceUser;
  role: "host" | "cohost" | "speaker" | "listener" | (string & {});
  hand_raised?: boolean | null;
  joined_at?: string | null;
  pending_invite?: FarcasterPendingStageInvite | null;
}

/**
 * Fetch the upstream participant list for a Farcaster-native space.
 *
 * Used by the in-app player to hydrate display names + PFPs on the
 * speakers/listeners list — LiveKit participant metadata from
 * Farcaster's upstream doesn't carry these fields, so without this
 * we render initials only. Returns `[]` on any failure so the player
 * degrades to LiveKit-only state rather than crashing.
 *
 * Backend: `GET /v1/farcaster-spaces/{id}/participants`.
 */
export async function fetchFarcasterNativeSpaceParticipants(
  id: string,
): Promise<FarcasterNativeSpaceParticipant[]> {
  try {
    const res = await apiClient.get<FarcasterNativeSpaceParticipant[]>(
      `/v1/farcaster-spaces/${encodeURIComponent(id)}/participants`,
      { timeout: FARCASTER_SPACES_TIMEOUT_MS },
    );
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

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

export const adminStopRecording = (roomId: string) =>
  apiClient
    .post<StatusResponse>(`/v1/admin/rooms/${roomId}/recording/stop`)
    .then((r) => r.data);

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
  Promise<import("@/types/farcaster").NotificationsResponse>
>();
export const getNotifications = (params?: {
  limit?: number;
  cursor?: string;
}): Promise<import("@/types/farcaster").NotificationsResponse> => {
  const key = `${params?.limit ?? ""}:${params?.cursor ?? ""}`;
  const existing = inFlightNotifications.get(key);
  if (existing) return existing;
  const promise = apiClient
    .get<
      import("@/types/farcaster").NotificationsResponse
    >("/v1/notifications", { params })
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

/**
 * Machine-readable error code from a backend error response, e.g.
 * `signer_not_linked`. Accepts FastAPI's `{detail: "code"}` as well as
 * `{detail: {code}}` / `{detail: {error}}` / `{error}` envelopes, so callers
 * don't depend on which one the auth router settles on.
 */
export function getApiErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const nested = detail as Record<string, unknown>;
    if (typeof nested.code === "string") return nested.code;
    if (typeof nested.error === "string") return nested.error;
  }
  if (typeof record.code === "string") return record.code;
  if (typeof record.error === "string") return record.error;
  return null;
}

/** HTTP status of a backend error response, or null for non-HTTP failures. */
export function getApiErrorStatus(error: unknown): number | null {
  if (!axios.isAxiosError(error)) return null;
  return error.response?.status ?? null;
}

// Error helper
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.detail || error.message || "An error occurred";
  }
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}
