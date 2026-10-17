import { apiFetch } from "@/lib/api/client";

export type ScheduledCastStatus =
  | "pending"
  | "processing"
  | "retrying"
  | "published"
  | "failed"
  | "cancelled";

export interface ScheduledCastQuote {
  fid: number;
  hash: string;
}

export interface CreateScheduledCastRequest {
  text: string;
  parent?: string;
  embeds?: string[];
  quote?: ScheduledCastQuote;
  channel_id?: string;
  /** Offset-aware ISO timestamp. The composer sends a UTC `Z` value. */
  scheduled_for: string;
}

export interface ScheduledCast {
  id: string;
  text: string;
  parent: string | null;
  embeds: string[];
  quote: ScheduledCastQuote | null;
  channel_id: string | null;
  scheduled_for: string;
  next_attempt_at: string;
  status: ScheduledCastStatus;
  attempts: number;
  last_error: string | null;
  published_hash: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  cancelled_at: string | null;
}

interface ScheduledCastListResponse {
  scheduled_casts: ScheduledCast[];
}

export function createScheduledCast(
  request: CreateScheduledCastRequest,
): Promise<ScheduledCast> {
  return apiFetch<ScheduledCast>("/v1/feed/scheduled-casts", {
    method: "POST",
    body: request,
  });
}

export async function getScheduledCasts(options: {
  limit?: number;
  includeHistory?: boolean;
} = {}): Promise<ScheduledCast[]> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
  });
  if (options.includeHistory) params.set("include_history", "true");
  const response = await apiFetch<ScheduledCastListResponse>(
    `/v1/feed/scheduled-casts?${params.toString()}`,
  );
  return response.scheduled_casts;
}

export function cancelScheduledCast(id: string): Promise<{
  status: "cancelled";
  id: string;
  cancelled_at: string;
}> {
  return apiFetch(`/v1/feed/scheduled-casts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
