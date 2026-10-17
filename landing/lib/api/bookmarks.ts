/**
 * Bookmarked-casts API for the Juke web app.
 *
 * Mirrors mobile `services/api.ts` (`getBookmarkedCasts`, `removeBookmark`):
 *   - GET    /v1/feed/bookmarks           → paginated feed of saved casts
 *   - DELETE /v1/feed/bookmarks/{hash}    → remove a bookmark
 *
 * Kept in its own module (rather than editing the Stream-C-owned
 * `lib/api/feed.ts`) so the bookmarks/settings workstream stays self-contained.
 */

import { apiFetch } from "@/lib/api/client";
import type { FeedResponse } from "@/lib/api/types";

export interface GetBookmarksParams {
  limit?: number;
  cursor?: string;
}

/** Fetch one page of the current user's bookmarked casts. */
export function getBookmarkedCasts(
  params: GetBookmarksParams = {},
): Promise<FeedResponse> {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  const qs = query.toString();
  return apiFetch<FeedResponse>(`/v1/feed/bookmarks${qs ? `?${qs}` : ""}`);
}

/** Remove a cast from the current user's bookmarks. */
export function removeBookmark(castHash: string): Promise<void> {
  return apiFetch<void>(`/v1/feed/bookmarks/${encodeURIComponent(castHash)}`, {
    method: "DELETE",
  });
}
