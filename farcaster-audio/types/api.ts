import { UserProfile } from "./user";
import { Room, Participant, ParticipantRole } from "./space";
import type { NeynarCast, NeynarFeedResponse } from "./neynar";

// Auth
export interface LoginRequest {
  signer_uuid: string;
  fid: number;
}

export interface LoginResponse {
  jwt: string;
  refresh_token: string;
  expires_at: string;
  user: UserProfile;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface AuthUrlResponse {
  authorization_url: string;
}

// Rooms
export interface RoomCreateRequest {
  title: string;
  announce_cast?: boolean;
  scheduled_at?: string;
}

export interface RoomCreateResponse {
  room: Room;
  livekit_token: string | null;
  livekit_ws_url: string | null;
  expires_at?: string | null;
}

export interface RoomGoLiveResponse {
  room: Room;
  livekit_token: string;
  livekit_ws_url: string;
  expires_at?: string | null;
}

export interface RoomListResponse {
  rooms: Room[];
  next_cursor: string | null;
}

export interface RoomDetailResponse {
  room: Room;
  participants: Participant[];
  hand_queue: number[];
}

export type RoomChatTargetResponse = Room;

// Participants
export interface JoinResponse {
  livekit_token: string;
  livekit_ws_url: string;
  expires_at?: string | null;
  role: ParticipantRole;
  room: Room;
  participants: Participant[];
}

export interface RaiseHandRequest {
  raised: boolean;
}

export interface RaiseHandResponse {
  hand_raised: boolean;
  queue_position: number | null;
}

export interface PromoteResponse {
  fid: number;
  role: ParticipantRole;
}

export interface BanRequest {
  reason?: string;
  duration_hours?: number;
}

export interface BanResponse {
  fid: number;
  status: string;
  expires_at: string | null;
}

export interface TokenRefreshResponse {
  livekit_token: string;
  expires_at: string;
}

export interface StatusResponse {
  status: string;
}

export interface ErrorResponse {
  detail: string;
}

export interface RsvpResponse {
  status: string;
}

export interface BlockedUser {
  fid: number;
  username: string | null;
  display_name: string | null;
  pfp_url: string | null;
  blocked_at: string;
}

export interface BlockUserResponse {
  status: "blocked" | "unblocked";
  fid: number;
}

export interface BlockedUsersResponse {
  users: BlockedUser[];
}

// Feed
export interface CastCreateRequest {
  text: string;
  parent?: string;
  embeds?: string[];
  quote?: {
    fid: number;
    hash: string;
  };
  channel_id?: string;
}

export interface CastCreateResponse {
  cast?: {
    hash: string;
  };
  hash?: string;
}

export type ChannelFeedResponse = NeynarFeedResponse;
export type BookmarksFeedResponse = NeynarFeedResponse;

export interface ChannelSearchItem {
  id: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  follower_count: number | null;
}

export interface ChannelSearchResponse {
  channels: ChannelSearchItem[];
}

// --- Search ---
export interface MiniappResultAuthor {
  fid?: number;
  username?: string;
  display_name?: string;
  pfp_url?: string | null;
}

export interface MiniappResult {
  name: string;
  image_url: string | null;
  frames_url: string;
  author?: MiniappResultAuthor | null;
}

export interface MiniappSearchMeta {
  unsupported?: boolean;
}

export interface MiniappSearchResponse {
  frames: MiniappResult[];
  next: { cursor: string | null };
  meta?: MiniappSearchMeta;
}

export interface CastSearchParsed {
  author_username: string | null;
  author_fid: number | null;
  before: string | null;
  after: string | null;
  text: string;
}

export interface CastSearchMeta {
  parsed: CastSearchParsed;
  unknown_author: boolean;
}

export interface CastSearchResponse {
  casts: NeynarCast[];
  next: { cursor: string | null };
  meta: CastSearchMeta;
}

// Auth Address
export interface RegisterAuthAddressRequest {
  auth_address: string;
}

export interface RegisterAuthAddressResponse {
  auth_address: string;
  status: string;
  approval_url: string | null;
}

export interface AuthAddressStatusResponse {
  auth_address: string;
  status: string;
  fid: number | null;
}

// Snap Signer (Ed25519 developer-managed signer)
export interface RegisterSnapSignerResponse {
  public_key: string;
  status: string;
  approval_url: string | null;
}

export interface SnapSignerStatusResponse {
  public_key: string;
  status: string;
  fid: number | null;
}
