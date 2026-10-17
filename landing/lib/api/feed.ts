/**
 * Typed feed/reaction/bookmark wrappers over `apiFetch` for the Juke web app.
 *
 * The backend `/v1/feed/following` proxies Hypersnap and returns the raw v2
 * cast shape (`{ casts, next: { cursor } }`, with `reactions`, `replies`, and
 * `viewer_context` sub-objects). The rest of the web app consumes the flatter,
 * normalised `Cast` type from `@/lib/api/types`, so we map at this boundary —
 * every other layer (store, CastCard, Stream F) works against `Cast`.
 *
 * Reactions inject the managed `signer_uuid` server-side, so the client only
 * sends `{ reaction_type, target }`. Bookmarks are Juke-local (hash only).
 */

import { apiFetch } from "@/lib/api/client";
import type { Cast } from "@/lib/api/types";
import { normalizeParentCast, type RawParentCast } from "@/lib/api/users";
import type {
  VoiceNoteDetail,
  VoiceNoteFeedResponse,
} from "@/lib/voice-notes";

// Re-export so callers can import the voice-note types from one place.
export type { VoiceNoteDetail, VoiceNoteFeedResponse };

const DEFAULT_FEED_LIMIT = 25;
const DEFAULT_VOICE_NOTE_LIMIT = 20;

/** Normalised feed page: a list of casts plus the opaque next-page cursor. */
export interface CastFeedPage {
  casts: Cast[];
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// Raw v2 wire shape (only the fields we read) → normalised `Cast`.
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
  parent_cast?: RawParentCast | null;
}

interface RawFeedResponse {
  casts: RawCast[];
  next?: { cursor: string | null } | null;
}

/** Map a single raw v2 cast onto the normalised `Cast` contract. */
export function normalizeCast(raw: RawCast): Cast {
  const viewer = raw.viewer_context ?? {};
  return {
    hash: raw.hash,
    author: {
      fid: raw.author.fid,
      username: raw.author.username,
      display_name: raw.author.display_name,
      pfp_url: raw.author.pfp_url ?? null,
    },
    text: raw.text,
    timestamp: raw.timestamp,
    embeds: raw.embeds ?? [],
    reactions: {
      likes_count: raw.reactions?.likes_count ?? 0,
      recasts_count: raw.reactions?.recasts_count ?? 0,
      replies_count: raw.replies?.count ?? 0,
      viewer_liked: viewer.liked ?? false,
      viewer_recasted: viewer.recasted ?? false,
    },
    channel: raw.channel
      ? { id: raw.channel.id, name: raw.channel.name ?? raw.channel.id }
      : null,
    parent_hash: raw.parent_hash ?? null,
    parent_cast: normalizeParentCast(raw.parent_cast),
    viewer_bookmarked: viewer.bookmarked ?? false,
  };
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/** `GET /v1/feed/following` — the authenticated user's home timeline. */
export async function getFollowingFeed(
  cursor?: string,
  limit: number = DEFAULT_FEED_LIMIT,
): Promise<CastFeedPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const data = await apiFetch<RawFeedResponse>(
    `/v1/feed/following?${params.toString()}`,
  );
  return {
    casts: (data.casts ?? []).map(normalizeCast),
    cursor: data.next?.cursor ?? null,
  };
}

/**
 * `GET /v1/voice-notes/feed` — voice notes from people you follow.
 *
 * Authenticated (unlike the public `/recent` endpoint in `lib/voice-notes.ts`),
 * so it must go through `apiFetch` to carry the Bearer JWT.
 */
export async function getVoiceNoteFeed(
  cursor?: string,
  limit: number = DEFAULT_VOICE_NOTE_LIMIT,
): Promise<VoiceNoteFeedResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<VoiceNoteFeedResponse>(
    `/v1/voice-notes/feed?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Reactions (signer injected server-side)
// ---------------------------------------------------------------------------

type ReactionType = "like" | "recast";

function reactionBody(reactionType: ReactionType, target: string) {
  return { reaction_type: reactionType, target };
}

/** `POST /v1/feed/reaction` — like a cast. */
export function likeCast(castHash: string): Promise<void> {
  return apiFetch("/v1/feed/reaction", {
    method: "POST",
    body: reactionBody("like", castHash),
  });
}

/** `DELETE /v1/feed/reaction` — remove a like. */
export function removeLike(castHash: string): Promise<void> {
  return apiFetch("/v1/feed/reaction", {
    method: "DELETE",
    body: reactionBody("like", castHash),
  });
}

/** `POST /v1/feed/reaction` — recast a cast. */
export function recastCast(castHash: string): Promise<void> {
  return apiFetch("/v1/feed/reaction", {
    method: "POST",
    body: reactionBody("recast", castHash),
  });
}

/** `DELETE /v1/feed/reaction` — remove a recast. */
export function removeRecast(castHash: string): Promise<void> {
  return apiFetch("/v1/feed/reaction", {
    method: "DELETE",
    body: reactionBody("recast", castHash),
  });
}

// ---------------------------------------------------------------------------
// Bookmarks (Juke-local; hash only)
// ---------------------------------------------------------------------------

/** `POST /v1/feed/bookmarks/{hash}` — bookmark a cast. */
export function bookmarkCast(castHash: string): Promise<void> {
  return apiFetch(`/v1/feed/bookmarks/${encodeURIComponent(castHash)}`, {
    method: "POST",
  });
}

/** `DELETE /v1/feed/bookmarks/{hash}` — remove a bookmark. */
export function removeBookmark(castHash: string): Promise<void> {
  return apiFetch(`/v1/feed/bookmarks/${encodeURIComponent(castHash)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Cast delete (own casts only; ownership enforced server-side)
// ---------------------------------------------------------------------------

/** `DELETE /v1/feed/cast/{hash}` — delete a cast the authenticated user owns. */
export function deleteCast(castHash: string): Promise<void> {
  return apiFetch(`/v1/feed/cast/${encodeURIComponent(castHash)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Block (author removal) — lives under /v1/users but used by the feed.
// ---------------------------------------------------------------------------

/** `POST /v1/users/{fid}/block` — block an author (removes their casts). */
export function blockUser(fid: number): Promise<void> {
  return apiFetch(`/v1/users/${fid}/block`, { method: "POST", body: {} });
}
