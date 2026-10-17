/**
 * Recognition leaderboard API client (status-only — no earn/rewards language;
 * see `juke-recognition-leaderboard-spec.md`).
 *
 * `GET /v1/leaderboard` and `GET /v1/leaderboard/awards/{fid}` are public —
 * fetched with a plain `fetch` (no credentials) so they work from SSR and
 * from anonymous visitors, mirroring the `getSpaceDetail` pattern in
 * `lib/spaces.ts`. `GET /v1/leaderboard/me` and the opt-out write require the
 * signed-in session and go through the shared credentialed `apiFetch` client.
 */

import { apiFetch, API_BASE_URL } from "@/lib/api/client";

export type LeaderboardCategoryKey =
  | "top_hosts"
  | "top_voices"
  | "top_casters"
  | "community";

/**
 * Fallback labels, matching the backend's `LEADERBOARD_CATEGORIES` order.
 * The wire response is the source of truth for `label`; this only covers the
 * brief window where a personalized view (`/me`) has loaded before the
 * public board response has, so a category key never flashes raw.
 */
export const LEADERBOARD_CATEGORY_LABELS: Record<LeaderboardCategoryKey, string> = {
  top_hosts: "Top Hosts",
  top_voices: "Top Voices",
  top_casters: "Top Casters",
  community: "Community",
};

export interface LeaderboardEntry {
  rank: number;
  fid: number;
  // Nullable on the wire (backend `LeaderboardEntry.username`/`.display_name`
  // are `str | None` — a fid may not have hydrated Farcaster profile data yet).
  // Render helpers below always fall back to something displayable.
  username: string | null;
  display_name: string | null;
  pfp_url: string | null;
  score: number;
}

export interface LeaderboardCategory {
  key: LeaderboardCategoryKey;
  label: string;
  entries: LeaderboardEntry[];
}

export interface LeaderboardResponse {
  cycle: string;
  status: "provisional" | "final";
  // Nullable on the wire (backend `computed_at` is `datetime | None`) —
  // a cycle can exist before its first aggregation run has completed.
  computed_at: string | null;
  categories: LeaderboardCategory[];
}

export interface LeaderboardMeCategory {
  key: LeaderboardCategoryKey;
  rank: number | null;
  score: number;
}

export interface LeaderboardMeResponse {
  cycle: string;
  opt_out: boolean;
  categories: LeaderboardMeCategory[];
}

export interface LeaderboardAward {
  cycle: string;
  category: LeaderboardCategoryKey;
  label: string;
  rank: number;
}

interface LeaderboardAwardsResponse {
  fid: number;
  awards: LeaderboardAward[];
}

/** Safe display name for an entry whose profile hasn't hydrated yet. */
export function entryDisplayName(entry: LeaderboardEntry): string {
  return entry.display_name || entry.username || `Juke user #${entry.fid}`;
}

/** Safe @handle for an entry; empty string when no username is known. */
export function entryUsername(entry: LeaderboardEntry): string {
  return entry.username ?? "";
}

/**
 * Public boards for a cycle. Returns `null` on any failure (network, 404 for
 * a cycle with no data yet, backend down) so callers can render an
 * intentional empty state rather than throwing.
 */
export async function getLeaderboard(
  cycle?: string,
): Promise<LeaderboardResponse | null> {
  try {
    const query = cycle ? `?cycle=${encodeURIComponent(cycle)}` : "";
    const res = await fetch(`${API_BASE_URL}/v1/leaderboard${query}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as LeaderboardResponse;
  } catch {
    return null;
  }
}

/**
 * The signed-in viewer's own standing. Returns `null` when anonymous, on a
 * 401, or on any transient failure — callers treat that as "don't show the
 * strip" rather than an error.
 */
export async function getLeaderboardMe(): Promise<LeaderboardMeResponse | null> {
  try {
    return await apiFetch<LeaderboardMeResponse>("/v1/leaderboard/me");
  } catch {
    return null;
  }
}

/** Update the signed-in user's leaderboard opt-out flag. */
export function setLeaderboardOptOut(
  optOut: boolean,
): Promise<{ opt_out: boolean }> {
  return apiFetch<{ opt_out: boolean }>("/v1/leaderboard/opt-out", {
    method: "PUT",
    body: { opt_out: optOut },
  });
}

/** Public award history for a profile. Empty array on any failure. */
export async function getLeaderboardAwards(
  fid: number,
): Promise<LeaderboardAward[]> {
  // Defense-in-depth: fid is always a typed number from callers, but guard
  // against a non-integer value injecting extra path segments.
  if (!Number.isInteger(fid)) return [];
  try {
    const res = await fetch(`${API_BASE_URL}/v1/leaderboard/awards/${fid}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as LeaderboardAwardsResponse;
    return data.awards ?? [];
  } catch {
    return [];
  }
}
