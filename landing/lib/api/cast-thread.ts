/**
 * Typed wrapper for `POST /v1/feed/cast/thread` — publishes an ordered
 * multi-cast thread in one request (parent canonical, replies chained by the
 * backend, order guaranteed).
 *
 * Response semantics (both parse through `apiFetch` because 2xx includes 207):
 *   - 201 → `{ success: true,  casts: [all],            failed_index: null }`
 *   - 207 → `{ success: false, casts: [published prefix], failed_index: n }`
 *     (segments `0..n-1` published; `n..` did not — the composer keeps them)
 *   - root failure → 502, surfaced as an {@link ApiFetchError} by `apiFetch`.
 */

import { apiFetch } from "@/lib/api/client";
import type { ThreadCreateRequest } from "@/lib/compose/composer-utils";

/** One published cast in the thread response, in publish order. */
export interface ThreadCastResult {
  index: number;
  hash: string;
}

export interface ThreadCreateResponse {
  success: boolean;
  casts: ThreadCastResult[];
  /** Index of the first segment that failed to publish; null on full success. */
  failed_index: number | null;
  error: string | null;
}

export async function createCastThread(
  payload: ThreadCreateRequest,
): Promise<ThreadCreateResponse> {
  return apiFetch<ThreadCreateResponse>("/v1/feed/cast/thread", {
    method: "POST",
    body: payload,
  });
}
