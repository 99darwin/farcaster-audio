/**
 * Social read+write API for the Juke web app's profile / cast-thread / channel
 * screens (Stream F).
 *
 * Every call goes through the shared `apiFetch` client so it inherits the
 * Bearer + `credentials: include` + 401→refresh→retry behaviour. The backend
 * proxies Hypersnap and returns raw v2 shapes (snake_case), so this module
 * also owns the `normalizeCast` mapper that adapts a raw v2 cast into the
 * canonical web `Cast` type consumed by `CastCard`.
 */

import { apiFetch } from "@/lib/api/client";
import type { Cast, FarcasterAuthor, ParentCast } from "@/lib/api/types";
import type { Recording, RecordingFeedItem } from "@/lib/recordings";
import { normalizeCastNode, type CastNode } from "@/lib/thread/thread-tree";

// ---------------------------------------------------------------------------
// Raw v2 wire shapes (only the fields we read).
// ---------------------------------------------------------------------------

interface RawAuthor {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string | null;
  /** Upstream spam-label hint, surfaced on thread nodes as `authorIsSpam`. */
  is_spam?: boolean;
}

export interface RawCast {
  hash: string;
  author: RawAuthor;
  text?: string;
  timestamp?: string;
  embeds?: unknown[];
  reactions?: { likes_count?: number; recasts_count?: number };
  replies?: { count?: number };
  viewer_context?: { liked?: boolean; recasted?: boolean; bookmarked?: boolean };
  channel?: { id: string; name?: string | null; image_url?: string | null } | null;
  parent_hash?: string | null;
  parent_cast?: RawParentCast | null;
  direct_replies?: RawCast[];
}

export interface RawParentCast {
  hash: string;
  author: RawAuthor;
  text?: string;
  timestamp?: string | null;
}

interface RawFeedResponse {
  casts?: RawCast[];
  next?: { cursor?: string | null } | null;
}

interface RawUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string | null;
  follower_count?: number;
  following_count?: number;
  profile?: { bio?: { text?: string } };
  viewer_context?: {
    following?: boolean;
    followed_by?: boolean;
    blocked?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Normalized types surfaced to the pages.
// ---------------------------------------------------------------------------

export interface ProfileUser {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  bio: string;
  follower_count: number;
  following_count: number;
  following: boolean;
  followed_by: boolean;
  blocked: boolean;
}

export interface CastPage {
  casts: Cast[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function normalizeAuthor(author: RawAuthor): FarcasterAuthor {
  return {
    fid: author.fid,
    username: author.username ?? "",
    display_name: author.display_name ?? author.username ?? "",
    pfp_url: author.pfp_url ?? null,
  };
}

/** Adapt the backend's parent-cast preview; `null` when absent. */
export function normalizeParentCast(
  raw: RawParentCast | null | undefined,
): ParentCast | null {
  if (!raw?.hash || !raw.author) return null;
  return {
    hash: raw.hash,
    author: normalizeAuthor(raw.author),
    text: raw.text ?? "",
    timestamp: raw.timestamp ?? "",
  };
}

/** Adapt a raw v2 cast into the canonical web `Cast` shape. */
export function normalizeCast(raw: RawCast): Cast {
  return {
    hash: raw.hash,
    author: normalizeAuthor(raw.author),
    text: raw.text ?? "",
    timestamp: raw.timestamp ?? "",
    embeds: raw.embeds ?? [],
    reactions: {
      likes_count: raw.reactions?.likes_count ?? 0,
      recasts_count: raw.reactions?.recasts_count ?? 0,
      replies_count: raw.replies?.count ?? 0,
      viewer_liked: raw.viewer_context?.liked ?? false,
      viewer_recasted: raw.viewer_context?.recasted ?? false,
    },
    channel: raw.channel
      ? {
          id: raw.channel.id,
          name: raw.channel.name ?? raw.channel.id,
          image_url: raw.channel.image_url ?? null,
        }
      : null,
    parent_hash: raw.parent_hash ?? null,
    parent_cast: normalizeParentCast(raw.parent_cast),
    viewer_bookmarked: raw.viewer_context?.bookmarked ?? false,
  };
}

function normalizeUser(raw: RawUser): ProfileUser {
  return {
    fid: raw.fid,
    username: raw.username ?? "",
    display_name: raw.display_name ?? raw.username ?? "",
    pfp_url: raw.pfp_url ?? null,
    bio: raw.profile?.bio?.text ?? "",
    follower_count: raw.follower_count ?? 0,
    following_count: raw.following_count ?? 0,
    following: raw.viewer_context?.following ?? false,
    followed_by: raw.viewer_context?.followed_by ?? false,
    blocked: raw.viewer_context?.blocked ?? false,
  };
}

function normalizeFeed(raw: RawFeedResponse): CastPage {
  return {
    casts: (raw.casts ?? []).map(normalizeCast),
    nextCursor: raw.next?.cursor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Users.
// ---------------------------------------------------------------------------

/** GET /v1/users/{fid} — profile by numeric FID (with viewer context). */
export async function getUser(fid: number): Promise<ProfileUser> {
  const data = await apiFetch<{ user: RawUser }>(`/v1/users/${fid}`);
  return normalizeUser(data.user);
}

/** GET /v1/users/by-username/{username} — profile by handle. */
export async function getUserByUsername(username: string): Promise<ProfileUser> {
  const data = await apiFetch<{ user: RawUser }>(
    `/v1/users/by-username/${encodeURIComponent(username)}`,
  );
  return normalizeUser(data.user);
}

/**
 * GET /v1/users/{fid}/casts — a user's authored casts (paginated).
 *
 * @param options.includeReplies - When true, appends `include_replies=true` to
 *   the request so that reply casts are included. The backend currently does not
 *   forward this flag upstream; wiring it up here makes it a no-op today but
 *   immediately effective once the backend is updated to pass it through.
 */
export async function getUserCasts(
  fid: number,
  cursor?: string,
  options?: { includeReplies?: boolean },
): Promise<CastPage> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (options?.includeReplies) params.set("include_replies", "true");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const data = await apiFetch<RawFeedResponse>(
    `/v1/users/${fid}/casts${query}`,
  );
  return normalizeFeed(data);
}

interface RawRecordingItem {
  id?: string;
  room_id: string;
  title: string;
  recording_url: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  cast_hash?: string | null;
}

export interface RecordingPage {
  recordings: Recording[];
  nextCursor: string | null;
}

/** GET /v1/users/{fid}/recordings — a user's recorded spaces. */
export async function getUserRecordings(
  fid: number,
  cursor?: string,
): Promise<RecordingPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const data = await apiFetch<{
    recordings: RawRecordingItem[];
    next_cursor: string | null;
  }>(`/v1/users/${fid}/recordings${query}`);
  return {
    recordings: (data.recordings ?? []).map((r) => ({
      id: r.id,
      room_id: r.room_id,
      title: r.title,
      recording_url: r.recording_url,
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_seconds: r.duration_seconds,
      cast_hash: r.cast_hash ?? null,
    })),
    nextCursor: data.next_cursor ?? null,
  };
}

/**
 * Wrap a user's flat recordings + the profile host into the `{recording, host}`
 * shape that `RecordingFeedItem` expects (the shared component was built for
 * the recent-recordings feed which carries a host per row).
 */
export function toRecordingFeedItems(
  recordings: Recording[],
  host: ProfileUser,
): RecordingFeedItem[] {
  return recordings.map((recording) => ({
    recording,
    host: {
      fid: host.fid,
      username: host.username,
      display_name: host.display_name,
      pfp_url: host.pfp_url,
    },
  }));
}

/** POST /v1/users/{fid}/follow. */
export function followUser(fid: number): Promise<unknown> {
  return apiFetch(`/v1/users/${fid}/follow`, { method: "POST" });
}

/** DELETE /v1/users/{fid}/follow. */
export function unfollowUser(fid: number): Promise<unknown> {
  return apiFetch(`/v1/users/${fid}/follow`, { method: "DELETE" });
}

/** POST /v1/users/{fid}/block. */
export function blockUser(fid: number): Promise<unknown> {
  return apiFetch(`/v1/users/${fid}/block`, { method: "POST" });
}

/** DELETE /v1/users/{fid}/block. */
export function unblockUser(fid: number): Promise<unknown> {
  return apiFetch(`/v1/users/${fid}/block`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Cast thread + channel feed.
// ---------------------------------------------------------------------------

export interface CastThread {
  root: Cast | null;
  /** The focused cast's parent chain, oldest first (empty for a top-level cast). */
  ancestors: Cast[];
  replies: CastNode[];
}

/**
 * GET /v1/feed/cast/thread?hash=0x… — a focused cast plus its nested reply
 * tree. Requests `reply_depth=5` so nested conversations arrive in one round
 * trip, and returns the replies as a `CastNode` forest (not flattened) for the
 * threaded view.
 */
export async function getCastThread(hash: string): Promise<CastThread> {
  const data = await apiFetch<{
    conversation?: { cast?: RawCast; chronological_parent_casts?: RawCast[] };
  }>(`/v1/feed/cast/thread?hash=${encodeURIComponent(hash)}&reply_depth=5`);
  const cast = data.conversation?.cast;
  if (!cast) return { root: null, ancestors: [], replies: [] };
  return {
    root: normalizeCast(cast),
    ancestors: (data.conversation?.chronological_parent_casts ?? []).map(
      normalizeCast,
    ),
    replies: (cast.direct_replies ?? []).map(normalizeCastNode),
  };
}

/** GET /v1/feed/channel/{id} — a single channel's cast feed (paginated). */
export async function getChannelFeed(
  channelId: string,
  cursor?: string,
): Promise<CastPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const data = await apiFetch<RawFeedResponse>(
    `/v1/feed/channel/${encodeURIComponent(channelId)}${query}`,
  );
  return normalizeFeed(data);
}

// ---------------------------------------------------------------------------
// Reactions + bookmarks (optimistic wiring for CastCard on these screens).
// ---------------------------------------------------------------------------

type ReactionKind = "like" | "recast";

function setReaction(hash: string, reaction: ReactionKind, add: boolean) {
  return apiFetch("/v1/feed/reaction", {
    method: add ? "POST" : "DELETE",
    body: { reaction_type: reaction, target: hash },
  });
}

export const likeCast = (hash: string) => setReaction(hash, "like", true);
export const unlikeCast = (hash: string) => setReaction(hash, "like", false);
export const recastCast = (hash: string) => setReaction(hash, "recast", true);
export const unrecastCast = (hash: string) =>
  setReaction(hash, "recast", false);

export function bookmarkCast(hash: string): Promise<unknown> {
  return apiFetch(`/v1/feed/bookmarks/${encodeURIComponent(hash)}`, {
    method: "POST",
  });
}

export function unbookmarkCast(hash: string): Promise<unknown> {
  return apiFetch(`/v1/feed/bookmarks/${encodeURIComponent(hash)}`, {
    method: "DELETE",
  });
}

/** Pure optimistic toggle of a like/recast on a single cast. */
export function applyReaction(cast: Cast, kind: ReactionKind): Cast {
  const reactions = { ...cast.reactions };
  if (kind === "like") {
    const liked = !reactions.viewer_liked;
    reactions.viewer_liked = liked;
    reactions.likes_count = Math.max(0, reactions.likes_count + (liked ? 1 : -1));
  } else {
    const recasted = !reactions.viewer_recasted;
    reactions.viewer_recasted = recasted;
    reactions.recasts_count = Math.max(
      0,
      reactions.recasts_count + (recasted ? 1 : -1),
    );
  }
  return { ...cast, reactions };
}

/** Pure optimistic toggle of the viewer bookmark on a single cast. */
export function applyBookmark(cast: Cast): Cast {
  return { ...cast, viewer_bookmarked: !cast.viewer_bookmarked };
}
