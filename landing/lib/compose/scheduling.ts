/** Pure local-time helpers for the scheduled-cast composer. */

export const MIN_SCHEDULE_DELAY_MS = 30_000;
export const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;
export const DEFAULT_SCHEDULE_LEAD_MS = 60 * 60 * 1_000;

export type ScheduleValidation =
  | { ok: true; date: Date; utcIso: string }
  | { ok: false; error: string };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Format a Date for an `<input type="datetime-local">` without UTC drift. */
export function toLocalDateTimeInput(date: Date): string {
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

/** A useful default: one hour from now, rounded up to the next minute. */
export function defaultScheduleValue(now = new Date()): string {
  const date = new Date(now.getTime() + DEFAULT_SCHEDULE_LEAD_MS);
  date.setSeconds(0, 0);
  if (date.getTime() < now.getTime() + DEFAULT_SCHEDULE_LEAD_MS) {
    date.setMinutes(date.getMinutes() + 1);
  }
  return toLocalDateTimeInput(date);
}

/**
 * Parse a browser local-date value using numeric fields, not implementation-
 * dependent `Date.parse`. The round-trip check rejects impossible DST/calendar
 * values rather than silently normalising them to a different wall time.
 */
export function validateLocalSchedule(
  value: string,
  now = new Date(),
): ScheduleValidation {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return { ok: false, error: "Choose a date and time." };

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? 0);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);

  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return {
      ok: false,
      error: "That local time doesn’t exist. Choose another time.",
    };
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

export function formatScheduleConfirmation(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
