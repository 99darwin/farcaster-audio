/**
 * Read receipts for 1:1 threads (design doc 4.4): a viewer-sent message is
 * seen iff `peer_last_read_at >= sent_at`. `peer_last_read_at` is 0 when the
 * peer has never read and null for groups / unknown, where no receipt shows.
 */

import type { Message } from "@/lib/api/messages.types";

export type ReadReceipt = "sent" | "seen";

export interface ReceiptPlacement {
  messageId: string;
  receipt: ReadReceipt;
}

/** True when the peer has read up to (or past) `sentAt`. */
export function isSeenByPeer(sentAt: number, peerLastReadAt: number | null | undefined): boolean {
  if (peerLastReadAt === null || peerLastReadAt === undefined || peerLastReadAt <= 0) return false;
  return peerLastReadAt >= sentAt;
}

/**
 * The one receipt to show: under the viewer's newest confirmed message, as
 * long as no incoming message follows it (a reply already implies "seen").
 * Null for groups, unknown read state, or when there's nothing to label.
 */
export function placeReadReceipt(
  messages: readonly Message[],
  viewerFid: number | null,
  peerLastReadAt: number | null | undefined,
): ReceiptPlacement | null {
  if (viewerFid === null || peerLastReadAt === null || peerLastReadAt === undefined) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== "text" || message.is_deleted) continue;
    if (message.sender.fid !== viewerFid) return null;
    if (message.send_state) continue;
    return {
      messageId: message.message_id,
      receipt: isSeenByPeer(message.sent_at, peerLastReadAt) ? "seen" : "sent",
    };
  }
  return null;
}
