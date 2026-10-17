/**
 * Timestamp formatting for Direct Casts. All inputs are ms epoch
 * (`Message.sent_at`, design §5). `now` is injectable for tests.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAYS_PER_WEEK = 7;
const WEEK_MS = DAYS_PER_WEEK * DAY_MS;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** "9:41 AM" */
export function formatBubbleTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Inbox row: "now", "5m", "9:41 AM", "Tue", "Mar 4", "Mar 4, 2024". */
export function formatInboxTime(ms: number, now: number = Date.now()): string {
  const delta = now - ms;
  if (delta < MINUTE_MS) return "now";
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m`;
  if (isSameDay(ms, now)) return formatBubbleTime(ms);
  if (delta < WEEK_MS) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
  }
  const date = new Date(ms);
  const isThisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(isThisYear ? {} : { year: "numeric" }),
  });
}

/** Day separator: "Today", "Yesterday", "Tuesday", "March 4", "March 4, 2024". */
export function formatDaySeparator(ms: number, now: number = Date.now()): string {
  const dayDelta = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta > 1 && dayDelta < DAYS_PER_WEEK) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  }
  const date = new Date(ms);
  const isThisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(isThisYear ? {} : { year: "numeric" }),
  });
}
