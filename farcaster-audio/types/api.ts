import { UserProfile } from "./user";
import { Room, Participant, ParticipantRole } from "./space";

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
