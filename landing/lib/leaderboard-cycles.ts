/**
 * Pure date helpers for the recognition leaderboard's monthly cycles.
 *
 * Cycles are calendar months in UTC, formatted as `YYYY-MM` (matching the
 * backend's `GET /v1/leaderboard?cycle=YYYY-MM` contract). Kept dependency-free
 * and side-effect-free so it can be unit tested without mocking fetch.
 */

/** How many months back the cycle switcher lets a visitor browse. */
export const MAX_CYCLES_BACK = 12;

function formatCycle(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** The current calendar month in UTC, as `YYYY-MM`. */
export function getCurrentCycle(): string {
  return formatCycle(new Date());
}

/** Add (or subtract) whole months from a `YYYY-MM` cycle string. */
export function shiftCycle(cycle: string, deltaMonths: number): string {
  const [yearStr, monthStr] = cycle.split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  return formatCycle(new Date(Date.UTC(year, monthIndex + deltaMonths, 1)));
}

/** Human label for a `YYYY-MM` cycle, e.g. "2026-07" → "July 2026". */
export function formatCycleLabel(cycle: string): string {
  const [yearStr, monthStr] = cycle.split("-");
  const date = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));
  return date.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Oldest cycle the switcher allows browsing back to. */
export function earliestBrowsableCycle(): string {
  return shiftCycle(getCurrentCycle(), -MAX_CYCLES_BACK);
}

/** Lexicographic compare works directly on zero-padded `YYYY-MM` strings. */
export function isCycleBefore(a: string, b: string): boolean {
  return a < b;
}

/** Clamp a cycle to the switcher's browsable range
 * (`earliestBrowsableCycle()` .. `getCurrentCycle()`). */
export function clampToRange(cycle: string): string {
  const earliest = earliestBrowsableCycle();
  const current = getCurrentCycle();
  if (isCycleBefore(cycle, earliest)) return earliest;
  if (isCycleBefore(current, cycle)) return current;
  return cycle;
}
