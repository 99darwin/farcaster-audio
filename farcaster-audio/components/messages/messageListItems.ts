/**
 * Turns a newest-first message window into inverted-list rows: day
 * separators and bubble grouping flags (Telegram-style runs from one sender
 * within a few minutes share a column; only the newest bubble of a run gets
 * a tail and, in groups, the oldest shows the sender name).
 */

import type { Message } from "@/types/messages";
import { isSameDay } from "@/utils/messageTime";

/** Max gap between two bubbles that still belong to one run. */
export const GROUP_GAP_MS = 5 * 60_000;

export interface MessageRow {
  kind: "message";
  key: string;
  message: Message;
  /** Oldest bubble in its run (visually on top). */
  isRunStart: boolean;
  /** Newest bubble in its run (visually at the bottom; carries the tail). */
  isRunEnd: boolean;
}

export interface DayRow {
  kind: "day";
  key: string;
  timestamp: number;
}

/** "New messages" divider, rendered above the oldest unread message. */
export interface UnreadRow {
  kind: "unread";
  key: string;
}

export const UNREAD_ROW_KEY = "unread-separator";

export type MessageListRow = MessageRow | DayRow | UnreadRow;

function isSystemMessage(message: Message): boolean {
  return message.type !== "text";
}

function belongToSameRun(a: Message, b: Message): boolean {
  if (isSystemMessage(a) || isSystemMessage(b)) return false;
  if (a.sender.fid !== b.sender.fid) return false;
  if (!isSameDay(a.sent_at, b.sent_at)) return false;
  return Math.abs(a.sent_at - b.sent_at) <= GROUP_GAP_MS;
}

/**
 * `messages` is newest first; the output keeps that order (index 0 renders
 * at the bottom of an inverted list). A day row follows the oldest message
 * of each day so it renders above that day's messages.
 */
export function buildMessageRows(
  messages: Message[],
  unreadSeparatorId: string | null = null,
): MessageListRow[] {
  const rows: MessageListRow[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const newer = messages[index - 1];
    const older = messages[index + 1];
    rows.push({
      kind: "message",
      key: message.message_id,
      message,
      isRunEnd:
        !newer ||
        !belongToSameRun(message, newer) ||
        newer.message_id === unreadSeparatorId,
      isRunStart:
        !older ||
        !belongToSameRun(message, older) ||
        message.message_id === unreadSeparatorId,
    });
    // Pushed after the message so the inverted list renders it above.
    if (message.message_id === unreadSeparatorId) {
      rows.push({ kind: "unread", key: UNREAD_ROW_KEY });
    }
    if (!older || !isSameDay(message.sent_at, older.sent_at)) {
      rows.push({
        kind: "day",
        key: `day:${message.message_id}`,
        timestamp: message.sent_at,
      });
    }
  }
  return rows;
}

export function findRowIndex(
  rows: MessageListRow[],
  messageId: string,
): number {
  return rows.findIndex(
    (row) => row.kind === "message" && row.message.message_id === messageId,
  );
}
