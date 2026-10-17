/**
 * Flatten a conversation's messages into renderable rows: date separators,
 * the "unread messages" divider, system lines, and message bubbles with their
 * grouping flags (consecutive messages from one sender within a few minutes
 * render as one visual group with tightened corners).
 */

import type { Message } from "@/lib/api/messages.types";
import { dayKey, formatDayLabel } from "./format";

/** Messages from one sender closer together than this share a group. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export const UNREAD_ROW_KEY = "row:unread";

export type ThreadRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "unread"; key: string }
  | { kind: "system"; key: string; message: Message }
  | {
      kind: "message";
      key: string;
      message: Message;
      isOwn: boolean;
      isFirstInGroup: boolean;
      isLastInGroup: boolean;
    };

export interface BuildThreadRowsOptions {
  viewerFid: number | null;
  /** Render the unread divider after this message (captured on thread open). */
  unreadAfterId: string | null;
  now: number;
}

function isGroupable(a: Message, b: Message): boolean {
  return (
    a.type === "text" &&
    b.type === "text" &&
    a.sender.fid === b.sender.fid &&
    b.sent_at - a.sent_at < GROUP_WINDOW_MS &&
    dayKey(a.sent_at) === dayKey(b.sent_at)
  );
}

/** Row key for a message; stable across optimistic -> server replacement. */
export function messageRowKey(messageId: string): string {
  return `msg:${messageId}`;
}

/** `messages` must be ascending by `sent_at` (store order). */
export function buildThreadRows(
  messages: readonly Message[],
  { viewerFid, unreadAfterId, now }: BuildThreadRowsOptions,
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let previousDay: string | null = null;
  // Only show the divider if something not sent by the viewer follows it.
  const unreadIndex = unreadAfterId
    ? messages.findIndex((m) => m.message_id === unreadAfterId)
    : -1;
  const hasUnreadAfter =
    unreadIndex !== -1 &&
    messages.slice(unreadIndex + 1).some((m) => m.sender.fid !== viewerFid);

  messages.forEach((message, index) => {
    const day = dayKey(message.sent_at);
    if (day !== previousDay) {
      rows.push({
        kind: "day",
        key: `day:${day}`,
        label: formatDayLabel(message.sent_at, now),
      });
      previousDay = day;
    }

    if (message.type !== "text") {
      rows.push({ kind: "system", key: messageRowKey(message.message_id), message });
    } else {
      const previous = messages[index - 1];
      const next = messages[index + 1];
      const breaksBefore = hasUnreadAfter && index === unreadIndex + 1;
      const breaksAfter = hasUnreadAfter && index === unreadIndex;
      rows.push({
        kind: "message",
        key: messageRowKey(message.message_id),
        message,
        isOwn: message.sender.fid === viewerFid,
        isFirstInGroup:
          breaksBefore || !previous || !isGroupable(previous, message),
        isLastInGroup: breaksAfter || !next || !isGroupable(message, next),
      });
    }

    if (hasUnreadAfter && index === unreadIndex) {
      rows.push({ kind: "unread", key: UNREAD_ROW_KEY });
    }
  });

  return rows;
}

/** Index of the row for `messageId`, or -1. */
export function findMessageRowIndex(
  rows: readonly ThreadRow[],
  messageId: string,
): number {
  const key = messageRowKey(messageId);
  return rows.findIndex((row) => row.key === key);
}
