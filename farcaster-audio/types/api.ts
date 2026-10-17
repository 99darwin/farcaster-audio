import { UserProfile } from "./user";
import { Room, Participant, ParticipantRole } from "./space";
import type { FarcasterCast, FarcasterFeedResponse } from "./farcaster";
import type { DirectCastAuthRequest } from "./messages";

// Auth
export interface LoginResponse {
  jwt: string;
  /**
   * Null when the server returns the refresh token as an HttpOnly cookie
   * (`use_cookie=true`). iOS does not opt into cookies, so this should
   * always be present in practice — storage layer treats null as an error.
   */
  refresh_token: string | null;
  expires_at: string;
  user: UserProfile;
}

export interface RefreshRequest {
  refresh_token: string;
}

// Hypersnap signer link + Protocol Auth (frozen contract:
// hypersnap-auth-contract.md §1–§2). Every hex value is 0x-prefixed lowercase,
// every timestamp unix seconds.

export type HexString = `0x${string}`;

/** A complete EIP-712 payload, signed as-is with `signTypedData`. */
export interface Eip712Payload {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignerPrepareRequest {
  fid: number;
  auth_address: HexString;
}

export interface ProtocolAuthChallenge {
  domain: string;
  uri: string;
  nonce: string;
  expires_at: number;
}

export interface SignerPrepareResponse {
  prepare_id: string;
  custody_address: HexString;
  signer_public_key: HexString;
  typed_data: {
    signer: Eip712Payload;
    auth_address: Eip712Payload;
  };
  protocol_auth: ProtocolAuthChallenge;
  expires_at: number;
}

export interface SignerRegisterRequest {
  prepare_id: string;
  signer_add_signature: HexString;
  auth_address_add_signature: HexString;
  protocol_auth_token: string;
  /** Custody-signed Direct Casts token request; both or neither. */
  dc_auth_request?: DirectCastAuthRequest;
  dc_auth_signature?: string;
}

export type SignerLinkStatus = "pending" | "submitted" | "approved" | "failed";

export interface SignerRegisterResponse {
  prepare_id: string;
  status: SignerLinkStatus;
}

export interface SignerStatusResponse {
  prepare_id: string;
  status: SignerLinkStatus;
  signer_tx_hash: HexString | null;
  auth_address_tx_hash: HexString | null;
  error: string | null;
  // No `login`: the server always sends null there (kept only for old
  // builds). After `approved`, sign in through `/v1/auth/protocol` with the
  // device auth address (`loginWithAuthAddressAfterLink`).
}

export interface ProtocolLoginRequest {
  token: string;
  use_cookie: boolean;
}

export interface SiwfNonceResponse {
  nonce: string;
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

export type ChannelFeedResponse = FarcasterFeedResponse;
export type BookmarksFeedResponse = FarcasterFeedResponse;

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
  casts: FarcasterCast[];
  next: { cursor: string | null };
  meta: CastSearchMeta;
}

// Auth Address
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
