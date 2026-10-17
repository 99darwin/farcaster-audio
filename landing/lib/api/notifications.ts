/**
 * Notifications API wrappers for the Juke web app.
 *
 * `GET /v1/notifications` proxies the Hypersnap notifications read (with backend
 * spam filtering) and returns the Farcaster v2 payload
 * (`{ notifications, next: { cursor } }`). These types mirror the mobile
 * notification definitions — only the fields the web feed
 * actually renders are modelled here.
 */

import { apiFetch } from "@/lib/api/client";

/** Page size requested per notifications fetch. Mirrors mobile. */
const NOTIFICATIONS_LIMIT = 25;

export type NotificationType =
  | "likes"
  | "recasts"
  | "follows"
  | "reply"
  | "mention"
  | "quote";

/** A Farcaster user as embedded in notification actors / cast authors. */
export interface NotificationUser {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  is_spam?: boolean;
}

/**
 * The cast attached to a notification (raw v2 shape).
 *
 * A structural superset of {@link RawCast} — every field `normalizeCast`
 * reads is present here, so a `NotificationCast` can be passed straight to
 * `normalizeCast` to produce the canonical web `Cast` consumed by `CastCard`.
 * The extra `thread_hash` / `parent_author` fields (dropped by `normalizeCast`)
 * are retained for thread deep-linking and the "Replying to" header.
 */
export interface NotificationCast {
  hash: string;
  thread_hash: string | null;
  parent_hash: string | null;
  author: NotificationUser;
  text: string;
  timestamp?: string;
  embeds?: unknown[];
  reactions?: { likes_count?: number; recasts_count?: number };
  replies?: { count?: number };
  viewer_context?: {
    liked?: boolean;
    recasted?: boolean;
    bookmarked?: boolean;
  };
  channel?: { id: string; name?: string | null } | null;
  parent_author?: {
    fid: number;
    username?: string | null;
  } | null;
}

/** A single like/recast actor entry (`type` in {"likes","recasts"}). */
export interface NotificationReaction {
  user: NotificationUser;
}

/** A single follow actor entry (`type === "follows"`). */
export interface NotificationFollow {
  user: NotificationUser;
}

export interface Notification {
  type: NotificationType;
  most_recent_timestamp: string;
  seen: boolean;
  cast?: NotificationCast | null;
  reactions?: NotificationReaction[];
  follows?: NotificationFollow[];
  /** Total aggregate actor count (may exceed the returned actor array). */
  count?: number;
}

export interface NotificationsResponse {
  notifications: Notification[];
  next: { cursor: string | null };
}

/**
 * Fetch a page of notifications. Pass the previous page's `next.cursor` to
 * paginate; omit it for the first page / a refresh.
 */
export function getNotifications(
  cursor?: string,
): Promise<NotificationsResponse> {
  const params = new URLSearchParams({ limit: String(NOTIFICATIONS_LIMIT) });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<NotificationsResponse>(
    `/v1/notifications?${params.toString()}`,
  );
}
