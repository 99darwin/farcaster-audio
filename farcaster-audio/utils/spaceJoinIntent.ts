/**
 * Records that the user tapped something inside Juke to enter a space, so
 * the space screen can join immediately. expo-router opens `/space/[id]`
 * straight from `juke://space/<id>` and universal links too; those
 * arrive with no recorded intent and get a pre-join confirmation instead,
 * so a link on a web page cannot drop the user into a live room (and out
 * of the one they are in) and publish their presence without a tap.
 */

import type { ConfirmationRequest } from "@/stores/confirmationStore";
import type { Room } from "@/types/space";

/** Long enough for a room fetch on a slow network, short enough to stay tied to the tap. */
export const SPACE_JOIN_INTENT_TTL_MS = 60 * 1000;

let pendingIntent: { roomId: string; expiresAt: number } | null = null;

/** Call immediately before an in-app navigation to `/space/<roomId>`. */
export function markSpaceJoinIntent(roomId: string): void {
  pendingIntent = { roomId, expiresAt: Date.now() + SPACE_JOIN_INTENT_TTL_MS };
}

/**
 * True (once) if an in-app tap targeted this room within the TTL. Single
 * use: a later deep link to the same room still has to be confirmed.
 */
export function consumeSpaceJoinIntent(roomId: string): boolean {
  const intent = pendingIntent;
  if (!intent || intent.roomId !== roomId) return false;
  pendingIntent = null;
  return Date.now() <= intent.expiresAt;
}

export function buildJoinSpaceConfirmation(
  room: Pick<Room, "title" | "host">,
): ConfirmationRequest {
  const hostName = room.host?.display_name || room.host?.username;
  const title = room.title?.trim();
  return {
    title: "Join this space?",
    message: hostName
      ? `You opened a link to ${hostName}'s live space. Others in the room will see you've joined.`
      : "You opened a link to a live space. Others in the room will see you've joined.",
    detail: title || undefined,
    confirmLabel: "Join space",
  };
}
