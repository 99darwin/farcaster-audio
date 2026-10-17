/**
 * Unit tests for landing/lib/spaces.ts pure helpers.
 *
 * Covers:
 *   - formatScheduledTime: year visibility, invalid input fallback, options
 *   - isStalePastScheduled: does NOT drop legitimately-future rooms
 */

import { formatScheduledTime, isStalePastScheduled } from "../spaces";

// Suppress the NEXT_PUBLIC_API_BASE_URL console.warn emitted at module load
// time when the env var is absent (normal in unit-test environments).
beforeAll(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// formatScheduledTime
// ---------------------------------------------------------------------------

describe("formatScheduledTime", () => {
  const currentYear = new Date().getFullYear();

  test("current-year date omits the year", () => {
    // Use July 15 of the current year — exact local time varies by runner TZ,
    // so only assert the year is absent and the month is present.
    const iso = `${currentYear}-07-15T21:02:00.000Z`;
    const result = formatScheduledTime(iso);
    expect(result).not.toContain(String(currentYear));
    expect(result).toMatch(/Jul/);
  });

  test("future non-current-year date includes the year", () => {
    const futureYear = currentYear + 1;
    const iso = `${futureYear}-05-22T21:02:00.000Z`;
    const result = formatScheduledTime(iso);
    expect(result).toContain(String(futureYear));
  });

  test("far-future non-current-year date includes the year (2027 regression)", () => {
    const iso = "2027-05-22T21:02:00.000Z";
    const result = formatScheduledTime(iso);
    expect(result).toContain("2027");
    expect(result).toMatch(/May/);
  });

  test("far-future non-current-year date includes the year (2032 regression)", () => {
    const iso = "2032-06-07T21:00:00.000Z";
    const result = formatScheduledTime(iso);
    expect(result).toContain("2032");
    expect(result).toMatch(/Jun/);
  });

  test("invalid ISO string returns em dash fallback", () => {
    expect(formatScheduledTime("not-a-date")).toBe("—");
  });

  test("empty string returns em dash fallback", () => {
    expect(formatScheduledTime("")).toBe("—");
  });

  test("null returns em dash fallback", () => {
    expect(formatScheduledTime(null)).toBe("—");
  });

  test("undefined returns em dash fallback", () => {
    expect(formatScheduledTime(undefined)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// formatScheduledTime — options: timeZone + showTimezone
// ---------------------------------------------------------------------------

describe("formatScheduledTime with options", () => {
  const currentYear = new Date().getFullYear();

  test("timeZone + showTimezone: true appends the timezone abbreviation", () => {
    const iso = "2027-05-22T21:02:00.000Z";
    const result = formatScheduledTime(iso, { timeZone: "UTC", showTimezone: true });
    expect(result).toMatch(/ UTC$/);
  });

  test("timeZone without showTimezone does not append a tz label", () => {
    const iso = "2027-05-22T21:02:00.000Z";
    const result = formatScheduledTime(iso, { timeZone: "UTC" });
    expect(result).not.toMatch(/ UTC$/);
    expect(result).toMatch(/May/);
  });

  test("showTimezone: true without timeZone does not append a tz label", () => {
    const iso = "2027-05-22T21:02:00.000Z";
    const result = formatScheduledTime(iso, { showTimezone: true });
    // No timeZone set → no abbreviation injected.
    expect(result).not.toMatch(/ UTC$/);
  });

  test("timeZone option is applied when rendering the time (UTC formats in UTC)", () => {
    // 2027-05-22T21:02:00.000Z is 9:02 PM UTC.
    const iso = "2027-05-22T21:02:00.000Z";
    const result = formatScheduledTime(iso, { timeZone: "UTC", showTimezone: true });
    expect(result).toContain("9:02");
    expect(result).toMatch(/ UTC$/);
  });

  test("year-omit behavior preserved with options (current-year omits year)", () => {
    const iso = `${currentYear}-07-15T21:02:00.000Z`;
    const result = formatScheduledTime(iso, { timeZone: "UTC", showTimezone: true });
    expect(result).not.toContain(String(currentYear));
    expect(result).toMatch(/Jul/);
    expect(result).toMatch(/ UTC$/);
  });

  test("year-include behavior preserved with options (non-current year includes year)", () => {
    const iso = "2027-05-22T21:02:00.000Z";
    const result = formatScheduledTime(iso, { timeZone: "UTC", showTimezone: true });
    expect(result).toContain("2027");
    expect(result).toMatch(/May/);
    expect(result).toMatch(/ UTC$/);
  });

  test("invalid input still returns em dash regardless of options", () => {
    expect(
      formatScheduledTime("not-a-date", { timeZone: "UTC", showTimezone: true }),
    ).toBe("—");
  });

  test("null returns em dash regardless of options", () => {
    expect(
      formatScheduledTime(null, { timeZone: "UTC", showTimezone: true }),
    ).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// isStalePastScheduled — must NOT drop legitimately-future rooms
// ---------------------------------------------------------------------------

describe("isStalePastScheduled", () => {
  test("returns false for a 2027 scheduled_at (far future)", () => {
    expect(isStalePastScheduled("2027-05-22T21:02:00.000Z")).toBe(false);
  });

  test("returns false for a 2032 scheduled_at (far future)", () => {
    expect(isStalePastScheduled("2032-06-07T21:00:00.000Z")).toBe(false);
  });

  test("returns false for a future timestamp (tomorrow)", () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(isStalePastScheduled(tomorrow)).toBe(false);
  });

  test("returns false when scheduled_at is null", () => {
    expect(isStalePastScheduled(null)).toBe(false);
  });

  test("returns false when scheduled_at is undefined", () => {
    expect(isStalePastScheduled(undefined)).toBe(false);
  });

  test("returns false when scheduled_at is unparseable", () => {
    expect(isStalePastScheduled("not-a-date")).toBe(false);
  });

  test("returns true for a timestamp older than the grace window (> 1h past)", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(isStalePastScheduled(twoHoursAgo)).toBe(true);
  });

  test("returns false for a timestamp within the grace window (30m past)", () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(isStalePastScheduled(thirtyMinAgo)).toBe(false);
  });
});
