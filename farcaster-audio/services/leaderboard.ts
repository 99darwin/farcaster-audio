import { apiClient } from "@/services/api";

// Juke recognition leaderboard — status-only. No earn/reward/payout
// language anywhere in this module or the UI it powers (Apple 3.1.5).
// See juke-recognition-leaderboard-spec.md for the full contract.

export type LeaderboardCategoryKey =
  | "top_hosts"
  | "top_voices"
  | "top_casters"
  | "community";

export type LeaderboardStatus = "provisional" | "final";

export interface LeaderboardEntry {
  rank: number;
  fid: number;
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
  status: LeaderboardStatus;
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

export interface LeaderboardOptOutResponse {
  opt_out: boolean;
}

export interface LeaderboardAward {
  cycle: string;
  category: LeaderboardCategoryKey;
  label: string;
  rank: number;
}

export interface LeaderboardAwardsResponse {
  fid: number;
  awards: LeaderboardAward[];
}

/** Fallback labels for "Your standing" rows, which carry no `label` on the wire. */
export const CATEGORY_LABELS: Record<LeaderboardCategoryKey, string> = {
  top_hosts: "Top Hosts",
  top_voices: "Top Voices",
  top_casters: "Top Casters",
  community: "Community",
};

export const CATEGORY_ORDER: LeaderboardCategoryKey[] = [
  "top_hosts",
  "top_voices",
  "top_casters",
  "community",
];

/**
 * The first cycle the leaderboard ever ran — backward cycle navigation
 * clamps here so users can't page into empty pre-launch months forever.
 */
export const FIRST_CYCLE = "2026-07";

/** Whole scores render bare ("90"); fractional ones keep one decimal ("87.4"). */
export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export const getLeaderboard = (
  cycle: string,
): Promise<LeaderboardResponse> =>
  apiClient
    .get<LeaderboardResponse>("/v1/leaderboard", { params: { cycle } })
    .then((r) => r.data);

export const getMyLeaderboardStanding = (): Promise<LeaderboardMeResponse> =>
  apiClient
    .get<LeaderboardMeResponse>("/v1/leaderboard/me")
    .then((r) => r.data);

export const setLeaderboardOptOut = (
  optOut: boolean,
): Promise<LeaderboardOptOutResponse> =>
  apiClient
    .put<LeaderboardOptOutResponse>("/v1/leaderboard/opt-out", {
      opt_out: optOut,
    })
    .then((r) => r.data);

export const getLeaderboardAwards = (
  fid: number,
): Promise<LeaderboardAwardsResponse> =>
  apiClient
    .get<LeaderboardAwardsResponse>(
      `/v1/leaderboard/awards/${encodeURIComponent(String(fid))}`,
    )
    .then((r) => r.data);

/** Current monthly cycle in `YYYY-MM` form, computed in UTC. */
export function currentCycle(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Add (or subtract) whole months from a `YYYY-MM` cycle string. */
export function shiftCycle(cycle: string, deltaMonths: number): string {
  const [year, month] = parseCycle(cycle);
  const shifted = new Date(Date.UTC(year, month - 1 + deltaMonths, 1));
  return currentCycle(shifted);
}

/** `true` when `cycle` is chronologically at or after the real current cycle. */
export function isAtOrAfterCurrentCycle(
  cycle: string,
  now = new Date(),
): boolean {
  return cycle >= currentCycle(now);
}

/** "2026-06" -> "June 2026". Falls back to the raw string if malformed. */
export function formatCycleLabel(cycle: string): string {
  try {
    const [year, month] = parseCycle(cycle);
    const date = new Date(Date.UTC(year, month - 1, 1));
    return new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return cycle;
  }
}

function parseCycle(cycle: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(cycle);
  if (!match) throw new Error(`Invalid cycle: "${cycle}"`);
  return [Number(match[1]), Number(match[2])];
}
