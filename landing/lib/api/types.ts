/**
 * Shared API types for the Juke web app (`juke.audio/app`).
 *
 * These mirror the backend Pydantic schemas (snake_case on the wire) so every
 * workstream shares one source of truth. Auth/user shapes come from
 * `backend/app/schemas/auth.py`; space shapes are re-exported from
 * `lib/spaces.ts` (already the canonical definitions used by the public
 * `/space/[id]` and `/miniapp` pages) so we never fork them.
 */

import type { DirectCastAuthRequest } from "@/lib/api/messages.types";

// ---------------------------------------------------------------------------
// Auth / session (backend/app/schemas/auth.py)
// ---------------------------------------------------------------------------

export interface UserResponse {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  custody_address: string | null;
  is_pro: boolean;
  is_admin: boolean;
  /**
   * App-signer state (auth contract section 3). Anything but `approved` means
   * the account is read-only until it is re-linked. Optional only while the
   * backend rolls out; absent is treated as unknown.
   */
  signer_status?: SignerStatus;
}

export type SignerStatus = "none" | "pending" | "approved" | "revoked";

/**
 * Response from POST /v1/auth/protocol, /siwf/login, and /refresh.
 *
 * When the request used `use_cookie: true` the server omits `refresh_token`
 * from the body and instead sets the HttpOnly `juke_refresh` cookie — the web
 * app always uses cookie mode, so `refresh_token` is expected to be null here.
 */
export interface LoginResponse {
  jwt: string;
  refresh_token: string | null;
  /** ISO 8601 timestamp for the JWT `exp`. */
  expires_at: string;
  user: UserResponse;
}

/** Body for POST /v1/auth/protocol — Protocol Auth (`hqa1`) login. */
export interface ProtocolLoginRequest {
  token: string;
  use_cookie: boolean;
}

/** An EIP-712 payload ready for `signTypedData` (KeyGateway `Add`). */
export interface Eip712Payload {
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Body for POST /v1/auth/signer/prepare. */
export interface SignerPrepareRequest {
  fid: number;
  auth_address: string;
}

/** 200 from POST /v1/auth/signer/prepare (frozen auth contract, section 1). */
export interface SignerPrepareResponse {
  prepare_id: string;
  custody_address: string;
  signer_public_key: string;
  typed_data: {
    signer: Eip712Payload;
    auth_address: Eip712Payload;
  };
  protocol_auth: {
    domain: string;
    uri: string;
    nonce: string;
    /** Unix seconds. */
    expires_at: number;
  };
  /** Unix seconds. */
  expires_at: number;
}

/** Body for POST /v1/auth/signer/register. */
export interface SignerRegisterRequest {
  prepare_id: string;
  signer_add_signature: string;
  auth_address_add_signature: string;
  protocol_auth_token: string;
  /** Custody-signed Direct Cast token request. Sent with its signature or not at all. */
  dc_auth_request?: DirectCastAuthRequest;
  dc_auth_signature?: string;
}

export type SignerLinkStatus = "pending" | "submitted" | "approved" | "failed";

/** 202 from POST /v1/auth/signer/register. */
export interface SignerRegisterResponse {
  prepare_id: string;
  status: SignerLinkStatus;
}

/** GET /v1/auth/signer/status?prepare_id=… */
export interface SignerStatusResponse {
  prepare_id: string;
  status: SignerLinkStatus;
  signer_tx_hash: string | null;
  auth_address_tx_hash: string | null;
  error: string | null;
  // No `login`: the server always sends null there (kept only for old app
  // builds). After `approved`, sign in through `/v1/auth/protocol`.
}

/** POST /v1/auth/siwf/nonce — also the nonce source for Protocol Auth. */
export interface NonceResponse {
  nonce: string;
}

// ---------------------------------------------------------------------------
// Space / room types — re-exported from the canonical definitions in
// lib/spaces.ts so the space workstream and the rest of the app agree.
// ---------------------------------------------------------------------------

export type {
  Space,
  SpaceUser,
  SpaceParticipant,
  SpaceListResponse,
  SpaceDetailResponse,
  JoinSpaceResponse,
  RsvpSummary,
} from "@/lib/spaces";

// ---------------------------------------------------------------------------
// Farcaster social feed (backend/app/routers/feed.py, users.py)
// ---------------------------------------------------------------------------

export interface FarcasterAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface CastReactions {
  likes_count: number;
  recasts_count: number;
  replies_count: number;
  /** Whether the current viewer has liked / recast this cast. */
  viewer_liked?: boolean;
  viewer_recasted?: boolean;
}

/**
 * Compact preview of the cast a reply responds to. The feed endpoints attach
 * it (backend `services/parent_casts.py`) because Hypersnap replies carry only
 * `parent_hash`, which would render a reply with no context.
 */
export interface ParentCast {
  hash: string;
  author: FarcasterAuthor;
  text: string;
  timestamp: string;
}

export interface Cast {
  hash: string;
  author: FarcasterAuthor;
  text: string;
  timestamp: string;
  /**
   * Raw v2 embed records, preserved verbatim from the API so the CastCard
   * can render the full mobile decision tree (images, video, OG/link cards,
   * mini-app frames, quoted casts). Narrowed defensively at the render site —
   * see `lib/api/types` embed interfaces + `components/ui/embeds.tsx`.
   */
  embeds?: unknown[];
  reactions: CastReactions;
  channel?: { id: string; name: string; image_url?: string | null } | null;
  parent_hash?: string | null;
  parent_cast?: ParentCast | null;
  viewer_bookmarked?: boolean;
}

// ---------------------------------------------------------------------------
// Farcaster v2 cast-embed shapes. Embeds arrive as either a URL record
// (`{ url, metadata }`) or a quote record (`{ cast_id, cast }`). These mirror
// the mobile embed type; the render layer narrows `unknown` into them.
// ---------------------------------------------------------------------------

export interface EmbedOgImage {
  url: string;
  width?: string;
  height?: string;
}

export interface EmbedOembed {
  type?: string;
  html?: string;
  author_name?: string;
  author_url?: string;
  provider_name?: string;
}

export interface EmbedHtmlMeta {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: EmbedOgImage[];
  ogUrl?: string;
  favicon?: string;
  oembed?: EmbedOembed;
}

export interface EmbedMetadata {
  content_type?: string;
  image?: { width_px?: number; height_px?: number };
  html?: EmbedHtmlMeta;
  /** Mini-app / frame metadata — keyed as either `fc_frame` or `frame`. */
  fc_frame?: Record<string, unknown>;
  frame?: Record<string, unknown>;
}

/** A quoted cast, as inlined by the read API under an embed's `cast` field. */
export interface EmbeddedCast {
  hash: string;
  author: FarcasterAuthor;
  text?: string;
  timestamp?: string;
  embeds?: unknown[];
}

/** URL embed: image, video, OG link, or mini-app frame. */
export interface UrlEmbed {
  url: string;
  metadata?: EmbedMetadata;
}

/** Quote embed: a full quoted cast plus its reference. */
export interface QuoteEmbed {
  cast?: EmbeddedCast;
  cast_id?: { fid: number; hash: string };
}

export type CastEmbed = UrlEmbed | QuoteEmbed;

export interface FeedResponse {
  casts: Cast[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Generic API error surface used by the fetch client.
// ---------------------------------------------------------------------------

export interface ApiError {
  status: number;
  detail?: string;
}
