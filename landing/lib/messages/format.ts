/**
 * Date/label formatting for the messaging UI. Every function takes `now`
 * explicitly so the output is deterministic in tests.
 */

import type {
  Conversation,
  Message,
  MessageUser,
} from "@/lib/api/messages.types";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
/** Badges above this show "99+". */
const MAX_BADGE_COUNT = 99;

/** Unread badge text, capped at `99+`. */
export function formatBadgeCount(count: number): string {
  return count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count);
}

/** Local calendar-day key, e.g. `2026-10-16`. */
export function dayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Whole local days between the two timestamps' calendar days. */
export function calendarDaysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY_MS);
}

/** Thread date separator: "Today", "Yesterday", "Monday", "March 3", "March 3, 2025". */
export function formatDayLabel(ms: number, now: number): string {
  const days = calendarDaysBetween(ms, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(ms);
  if (days > 1 && days < WEEK_DAYS) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Bubble timestamp, e.g. "9:41 AM". */
export function formatMessageTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Inbox row timestamp: time today, weekday this week, short date otherwise. */
export function formatInboxTime(ms: number, now: number): string {
  const days = calendarDaysBetween(ms, now);
  if (days <= 0) return formatMessageTime(ms);
  const date = new Date(ms);
  if (days < WEEK_DAYS) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}

/** Full timestamp for `title`/screen-reader text. */
export function formatFullTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function userLabel(user: MessageUser): string {
  return user.display_name || (user.username ? `@${user.username}` : `fid ${user.fid}`);
}

/** Profile route for a messaging user (username when known, else fid). */
export function profileHref(user: MessageUser): string {
  return user.username ? mentionHref(user.username) : `/app/profile/${user.fid}`;
}

/** Profile route for an @mention; the username is path-encoded. */
export function mentionHref(username: string): string {
  return `/app/profile/${encodeURIComponent(username)}`;
}

/**
 * Display title: the group name, else the 1:1 counterparty, else a joined list
 * of the other participants.
 */
export function conversationTitle(
  conversation: Conversation,
  viewerFid: number | null,
): string {
  if (conversation.name) return conversation.name;
  if (conversation.counterparty) return userLabel(conversation.counterparty);
  const others = conversation.participants.filter((p) => p.fid !== viewerFid);
  if (others.length === 0) return "Conversation";
  return others.map(userLabel).join(", ");
}

/** Avatar source for a conversation row/header. */
export function conversationAvatar(
  conversation: Conversation,
  viewerFid: number | null,
): { src: string | null; name: string } {
  const name = conversationTitle(conversation, viewerFid);
  if (conversation.photo_url) return { src: conversation.photo_url, name };
  const peer =
    conversation.counterparty ??
    conversation.participants.find((p) => p.fid !== viewerFid) ??
    null;
  return { src: peer?.pfp_url ?? null, name };
}

const SYSTEM_LABELS: Record<Exclude<Message["type"], "text">, string> = {
  group_name_change: "changed the group name",
  group_membership_addition: "added a member",
  group_membership_removal: "removed a member",
  pin_message: "pinned a message",
  message_ttl_change: "changed disappearing messages",
  rich_announcement: "posted an announcement",
};

/** One-line text for system (non-`text`) messages. */
export function systemMessageText(message: Message): string {
  if (message.type === "text") return message.text;
  if (message.text) return message.text;
  return `${userLabel(message.sender)} ${SYSTEM_LABELS[message.type]}`;
}

/** Inbox preview line for a conversation's last message. */
export function lastMessagePreview(
  message: Message | null,
  viewerFid: number | null,
  isGroup: boolean,
): string {
  if (!message) return "No messages yet";
  if (message.is_deleted) return "Message deleted";
  if (message.type !== "text") return systemMessageText(message);
  const body = message.text.trim() || attachmentLabel(message);
  if (message.sender.fid === viewerFid) return `You: ${body}`;
  if (isGroup) return `${userLabel(message.sender)}: ${body}`;
  return body;
}

const GIF_MIME = "image/gif";

/**
 * Preview label for one attachment by mime type. A missing mime type means an
 * image: upstream only omits it for legacy photo uploads.
 */
export function mediaLabel(mimeType: string | null): string {
  const mime = mimeType?.toLowerCase().split(";")[0].trim() ?? null;
  if (mime === null || mime === "") return "Photo";
  if (mime === GIF_MIME) return "GIF";
  if (mime.startsWith("image/")) return "Photo";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Voice message";
  return "File";
}

function attachmentLabel(message: Message): string {
  const first = message.metadata?.medias[0];
  if (first) return mediaLabel(first.mime_type);
  if (message.metadata?.urls.length) return "Link";
  return "Message";
}
