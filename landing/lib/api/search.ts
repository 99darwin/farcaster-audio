/**
 * Typed `apiFetch` wrappers for global search (Stream G).
 *
 * Endpoints + query-param names mirror mobile `services/api.ts` exactly so the
 * web app and the app share one backend contract:
 *   - People    → GET /v1/users/search?q=&limit=
 *   - Casts     → GET /v1/search/casts?q=&sort=&limit=
 *   - Channels  → GET /v1/feed/channels/search?q=&limit=
 *   - Mini Apps → GET /v1/search/miniapps?q=&limit=
 *
 * The casts endpoint proxies raw Hypersnap v2 casts, so `searchCasts` normalises them
 * into the shared `Cast` shape that `CastCard` (Stream C) consumes.
 */

import { apiFetch } from "@/lib/api/client";
import type { Cast } from "@/lib/api/types";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface UserSearchItem {
  fid: number;
  username: string;
  display_name: string | null;
  pfp_url: string | null;
  bio?: string | null;
  follower_count?: number | null;
}

interface UserSearchResponse {
  users: UserSearchItem[];
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface ChannelSearchItem {
  id: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  follower_count: number | null;
}

interface ChannelSearchResponse {
  channels: ChannelSearchItem[];
}

// ---------------------------------------------------------------------------
// Mini Apps
// ---------------------------------------------------------------------------

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

interface MiniappSearchResponse {
  frames: MiniappResult[];
  next?: { cursor: string | null };
  meta?: { unsupported?: boolean };
}

// ---------------------------------------------------------------------------
// Casts — raw v2 wire shape → normalised `Cast`
// ---------------------------------------------------------------------------

interface RawCast {
  hash: string;
  author: {
    fid: number;
    username: string;
    display_name: string;
    pfp_url: string | null;
  };
  text: string;
  timestamp: string;
  embeds?: unknown[];
  reactions?: { likes_count?: number; recasts_count?: number };
  replies?: { count?: number };
  viewer_context?: { liked?: boolean; recasted?: boolean; bookmarked?: boolean };
  channel?: { id: string; name?: string | null } | null;
  parent_hash?: string | null;
}

interface CastSearchResponse {
  casts: RawCast[];
  next?: { cursor: string | null };
}

function toCast(raw: RawCast): Cast {
  return {
    hash: raw.hash,
    author: {
      fid: raw.author.fid,
      username: raw.author.username,
      display_name: raw.author.display_name,
      pfp_url: raw.author.pfp_url,
    },
    text: raw.text,
    timestamp: raw.timestamp,
    embeds: raw.embeds,
    reactions: {
      likes_count: raw.reactions?.likes_count ?? 0,
      recasts_count: raw.reactions?.recasts_count ?? 0,
      replies_count: raw.replies?.count ?? 0,
      viewer_liked: raw.viewer_context?.liked,
      viewer_recasted: raw.viewer_context?.recasted,
    },
    channel: raw.channel
      ? { id: raw.channel.id, name: raw.channel.name ?? raw.channel.id }
      : null,
    parent_hash: raw.parent_hash ?? null,
    viewer_bookmarked: raw.viewer_context?.bookmarked,
  };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

const USER_LIMIT = 10;
const CHANNEL_LIMIT = 10;
const CAST_LIMIT = 20;
const MINIAPP_LIMIT = 12;

type FetchOptions = { signal?: AbortSignal };

function buildQuery(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return search.toString();
}

export async function searchUsers(
  q: string,
  options?: FetchOptions,
): Promise<UserSearchItem[]> {
  const query = buildQuery({ q, limit: USER_LIMIT });
  const data = await apiFetch<UserSearchResponse>(`/v1/users/search?${query}`, {
    signal: options?.signal,
  });
  return data.users ?? [];
}

export async function searchCasts(
  q: string,
  options?: FetchOptions,
): Promise<Cast[]> {
  const query = buildQuery({ q, sort: "popular", limit: CAST_LIMIT });
  const data = await apiFetch<CastSearchResponse>(`/v1/search/casts?${query}`, {
    signal: options?.signal,
  });
  return (data.casts ?? []).map(toCast);
}

export async function searchChannels(
  q: string,
  options?: FetchOptions,
): Promise<ChannelSearchItem[]> {
  const query = buildQuery({ q, limit: CHANNEL_LIMIT });
  const data = await apiFetch<ChannelSearchResponse>(
    `/v1/feed/channels/search?${query}`,
    { signal: options?.signal },
  );
  return data.channels ?? [];
}

export async function searchMiniapps(
  q: string,
  options?: FetchOptions,
): Promise<MiniappResult[]> {
  const query = buildQuery({ q, limit: MINIAPP_LIMIT });
  const data = await apiFetch<MiniappSearchResponse>(
    `/v1/search/miniapps?${query}`,
    { signal: options?.signal },
  );
  return data.frames ?? [];
}
