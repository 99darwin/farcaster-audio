/**
 * GIF search/trending wrappers for the Juke web app.
 *
 * Proxies through the Juke backend (/v1/gifs/*) which holds the Giphy API key
 * server-side. All calls require a valid JWT (apiFetch handles this).
 *
 * Ported from farcaster-audio/services/giphy.ts, adapted to use apiFetch
 * instead of the mobile axios apiClient.
 */

import { apiFetch } from "@/lib/api/client";

export interface GifResult {
  id: string;
  gifUrl: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface GifSearchResponse {
  results: GifResult[];
  /** Offset to pass for the next page, or null if no more results. */
  nextOffset: number | null;
}

/** Wire-format response from /v1/gifs/search and /v1/gifs/trending. */
interface GifSearchDto {
  results: GifResult[];
  next_offset: number | null;
}

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50; // mirrors backend MAX_LIMIT

/**
 * Search Giphy for GIFs matching `query`.
 *
 * Maps to GET /v1/gifs/search?q=...&offset=...&limit=...
 * Auth required (per backend: Depends(get_current_user)).
 */
export async function searchGifs(
  query: string,
  offset = 0,
  limit = DEFAULT_LIMIT,
): Promise<GifSearchResponse> {
  const q = query.trim();
  if (!q) throw new Error("searchGifs: query must not be empty");

  // Clamp to backend-accepted ranges (ge=0, ge=1, le=MAX_LIMIT).
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));

  const params = new URLSearchParams({
    q,
    offset: String(safeOffset),
    limit: String(safeLimit),
  });

  const data = await apiFetch<GifSearchDto>(`/v1/gifs/search?${params}`);
  return { results: data.results ?? [], nextOffset: data.next_offset ?? null };
}

/**
 * Return trending GIFs.
 *
 * Maps to GET /v1/gifs/trending?offset=...&limit=...
 * Auth required (per backend: Depends(get_current_user)).
 */
export async function getTrendingGifs(
  offset = 0,
  limit = DEFAULT_LIMIT,
): Promise<GifSearchResponse> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));

  const params = new URLSearchParams({
    offset: String(safeOffset),
    limit: String(safeLimit),
  });

  const data = await apiFetch<GifSearchDto>(`/v1/gifs/trending?${params}`);
  return { results: data.results ?? [], nextOffset: data.next_offset ?? null };
}
