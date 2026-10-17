/**
 * Notification (push) preferences API for the Juke web app.
 *
 * Mirrors mobile `services/api.ts` (`getNotificationPreferences`,
 * `updateNotificationPreferences`) and the backend
 * `NotificationPreferencesResponse` / `NotificationPreferencesUpdate` schemas:
 *   - GET   /v1/push/preferences  → full preference set
 *   - PATCH /v1/push/preferences  → partial update, returns the full set
 *
 * These server-side toggles gate which events generate notifications. On web,
 * actual browser push delivery is out of scope — the toggles simply persist the
 * user's server preferences (which the mobile app and any future web push honor).
 */

import { apiFetch } from "@/lib/api/client";

export interface PushPreferences {
  follows_enabled: boolean;
  likes_enabled: boolean;
  replies_enabled: boolean;
  recasts_enabled: boolean;
  space_started_enabled: boolean;
  space_invited_enabled: boolean;
  hand_raised_enabled: boolean;
  miniapp_enabled: boolean;
}

/** Partial update — only the toggled keys are sent. */
export type PushPreferencesUpdate = Partial<PushPreferences>;

/** Fetch the current user's notification preferences. */
export function getPushPreferences(): Promise<PushPreferences> {
  return apiFetch<PushPreferences>("/v1/push/preferences");
}

/** Partially update notification preferences; resolves to the full new set. */
export function updatePushPreferences(
  updates: PushPreferencesUpdate,
): Promise<PushPreferences> {
  return apiFetch<PushPreferences>("/v1/push/preferences", {
    method: "PATCH",
    body: updates,
  });
}
