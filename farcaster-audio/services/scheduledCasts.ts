import { apiClient } from "@/services/api";
import type { CastCreateRequest } from "@/types/api";

export const MIN_SCHEDULE_DELAY_MS = 30_000;
export const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;
export const DEFAULT_SCHEDULE_LEAD_MS = 60 * 60 * 1_000;

export type ScheduledCastStatus =
  | "pending"
  | "processing"
  | "retrying"
  | "published"
  | "failed"
  | "cancelled";

export interface CreateScheduledCastRequest extends CastCreateRequest {
  /** Offset-aware ISO timestamp. Mobile sends a UTC `Z` value. */
  scheduled_for: string;
}

export interface ScheduledCast {
  id: string;
  text: string;
  parent: string | null;
  embeds: string[];
  quote: { fid: number; hash: string } | null;
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

export type ScheduleValidation =
  | { ok: true; date: Date; utcIso: string }
  | { ok: false; error: string };

/** A useful default: one hour from now, rounded up to a whole minute. */
export function defaultScheduledDate(now = new Date()): Date {
  const date = new Date(now.getTime() + DEFAULT_SCHEDULE_LEAD_MS);
  date.setSeconds(0, 0);
  if (date.getTime() < now.getTime() + MIN_SCHEDULE_DELAY_MS) {
    date.setMinutes(date.getMinutes() + 1);
  }
  return date;
}

/** Validate in absolute time, then serialize the chosen local Date as UTC. */
export function validateScheduledDate(
  date: Date,
  now = new Date(),
): ScheduleValidation {
  if (!Number.isFinite(date.getTime())) {
    return { ok: false, error: "Choose a valid date and time." };
  }

  const delay = date.getTime() - now.getTime();
  if (delay < MIN_SCHEDULE_DELAY_MS) {
    return {
      ok: false,
      error: "Choose a time at least 30 seconds from now.",
    };
  }
  if (delay > MAX_SCHEDULE_HORIZON_MS) {
    return {
      ok: false,
      error: "Choose a time within the next 365 days.",
    };
  }

  return { ok: true, date, utcIso: date.toISOString() };
}

/** Preserve the current local time while changing the Android date picker part. */
export function mergeLocalDate(current: Date, selected: Date): Date {
  const next = new Date(current);
  next.setFullYear(
    selected.getFullYear(),
    selected.getMonth(),
    selected.getDate(),
  );
  return next;
}

/** Preserve the current local date while changing the Android time picker part. */
export function mergeLocalTime(current: Date, selected: Date): Date {
  const next = new Date(current);
  next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
  return next;
}

export function formatScheduledDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function validateScheduledEmbedCount(
  embedCount: number,
  hasQuote: boolean,
): string | null {
  const allowed = hasQuote ? 1 : 2;
  if (embedCount <= allowed) return null;
  return hasQuote
    ? "A scheduled quote can include one link or media attachment."
    : "A scheduled cast can include up to two links or media attachments.";
}

export const createScheduledCast = (
  request: CreateScheduledCastRequest,
): Promise<ScheduledCast> =>
  apiClient
    .post<ScheduledCast>("/v1/feed/scheduled-casts", request)
    .then((response) => response.data);

export const getScheduledCasts = (params?: {
  limit?: number;
  includeHistory?: boolean;
}): Promise<ScheduledCast[]> =>
  apiClient
    .get<{ scheduled_casts: ScheduledCast[] }>("/v1/feed/scheduled-casts", {
      params: {
        limit: params?.limit ?? 50,
        include_history: params?.includeHistory || undefined,
      },
    })
    .then((response) => response.data.scheduled_casts ?? []);
