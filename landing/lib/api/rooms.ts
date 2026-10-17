"use client";

/**
 * Room list / discovery wrappers for the Juke web app.
 *
 * Reuses the public, no-auth `getActiveSpaces` from `@/lib/spaces` and adds a
 * matching scheduled-rooms fetch. Discovery is public, so these go over
 * `apiFetch` which simply omits the Bearer header when anonymous.
 */

import { apiFetch } from "@/lib/api/client";
import { getActiveSpaces, type SpaceListResponse } from "@/lib/spaces";

export { getActiveSpaces };
export type { SpaceListResponse };

/**
 * List scheduled (upcoming) Juke rooms.
 * Backend: `GET /v1/rooms?status=scheduled&limit=...`.
 */
export function getScheduledSpaces(
  cursor?: string,
  limit = 20,
): Promise<SpaceListResponse> {
  const params = new URLSearchParams({
    status: "scheduled",
    limit: String(limit),
  });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<SpaceListResponse>(`/v1/rooms?${params.toString()}`);
}

/** Response from the RSVP endpoints (mirrors mobile `RsvpResponse`). */
export interface RsvpResponse {
  status: string;
}

/**
 * RSVP the authenticated viewer to a scheduled room.
 * Backend: `POST /v1/rooms/{id}/rsvp`. Requires a JWT.
 */
export function rsvpRoom(roomId: string): Promise<RsvpResponse> {
  return apiFetch<RsvpResponse>(
    `/v1/rooms/${encodeURIComponent(roomId)}/rsvp`,
    { method: "POST" },
  );
}

/**
 * Cancel the authenticated viewer's RSVP for a scheduled room.
 * Backend: `DELETE /v1/rooms/{id}/rsvp`. Requires a JWT.
 */
export function unrsvpRoom(roomId: string): Promise<RsvpResponse> {
  return apiFetch<RsvpResponse>(
    `/v1/rooms/${encodeURIComponent(roomId)}/rsvp`,
    { method: "DELETE" },
  );
}
