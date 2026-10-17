import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { apiClient } from "@/services/api";
import {
  MAX_SCHEDULE_HORIZON_MS,
  MIN_SCHEDULE_DELAY_MS,
  createScheduledCast,
  defaultScheduledDate,
  getScheduledCasts,
  mergeLocalDate,
  mergeLocalTime,
  validateScheduledDate,
  validateScheduledEmbedCount,
  type ScheduledCast,
} from "@/services/scheduledCasts";

jest.mock("@/services/api", () => ({
  apiClient: {
    post: jest.fn(),
    get: jest.fn(),
  },
}));

const mockedPost = jest.mocked(apiClient.post);
const mockedGet = jest.mocked(apiClient.get);

const scheduledCast: ScheduledCast = {
  id: "4f90c62c-77cf-4f50-9b70-28f631b60015",
  text: "Later, from Juke",
  parent: null,
  embeds: ["https://example.com/image.png"],
  quote: null,
  channel_id: "juke",
  scheduled_for: "2026-07-11T02:30:00.000Z",
  next_attempt_at: "2026-07-11T02:30:00.000Z",
  status: "pending",
  attempts: 0,
  last_error: null,
  published_hash: null,
  created_at: "2026-07-10T20:00:00.000Z",
  updated_at: "2026-07-10T20:00:00.000Z",
  published_at: null,
  cancelled_at: null,
};

describe("scheduled-cast time helpers", () => {
  const now = new Date("2026-07-10T20:00:00.000Z");

  it("creates a future default rounded to the minute", () => {
    const value = defaultScheduledDate(
      new Date("2026-07-10T20:00:29.500Z"),
    );
    expect(value.getSeconds()).toBe(0);
    expect(value.getMilliseconds()).toBe(0);
    expect(value.getTime()).toBeGreaterThan(now.getTime());
  });

  it("rejects invalid, past, too-soon, and over-horizon values", () => {
    expect(validateScheduledDate(new Date(Number.NaN), now)).toEqual({
      ok: false,
      error: "Choose a valid date and time.",
    });
    expect(validateScheduledDate(new Date(now.getTime() - 1), now).ok).toBe(
      false,
    );
    expect(
      validateScheduledDate(
        new Date(now.getTime() + MIN_SCHEDULE_DELAY_MS - 1),
        now,
      ).ok,
    ).toBe(false);
    expect(
      validateScheduledDate(
        new Date(now.getTime() + MAX_SCHEDULE_HORIZON_MS + 1),
        now,
      ).ok,
    ).toBe(false);
  });

  it("accepts the backend boundary and serializes with a UTC offset", () => {
    const date = new Date(now.getTime() + MIN_SCHEDULE_DELAY_MS);
    expect(validateScheduledDate(date, now)).toEqual({
      ok: true,
      date,
      utcIso: date.toISOString(),
    });
    expect(date.toISOString()).toMatch(/Z$/);
  });

  it("merges Android date and time choices without changing the other part", () => {
    const current = new Date(2026, 6, 10, 13, 45, 30, 100);
    const chosenDate = new Date(2027, 1, 14, 8, 0);
    const chosenTime = new Date(2020, 0, 1, 21, 20);

    const dated = mergeLocalDate(current, chosenDate);
    expect([
      dated.getFullYear(),
      dated.getMonth(),
      dated.getDate(),
      dated.getHours(),
      dated.getMinutes(),
    ]).toEqual([2027, 1, 14, 13, 45]);

    const timed = mergeLocalTime(current, chosenTime);
    expect([
      timed.getFullYear(),
      timed.getMonth(),
      timed.getDate(),
      timed.getHours(),
      timed.getMinutes(),
      timed.getSeconds(),
    ]).toEqual([2026, 6, 10, 21, 20, 0]);
  });

  it("enforces the two-embed cap including quotes", () => {
    expect(validateScheduledEmbedCount(2, false)).toBeNull();
    expect(validateScheduledEmbedCount(3, false)).toMatch(/up to two/);
    expect(validateScheduledEmbedCount(1, true)).toBeNull();
    expect(validateScheduledEmbedCount(2, true)).toMatch(/quote/);
  });
});

describe("scheduled-cast API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("submits the exact authenticated backend payload without a client FID", async () => {
    mockedPost.mockResolvedValueOnce({ data: scheduledCast });
    const request = {
      text: "Later, from Juke",
      embeds: ["https://example.com/image.png"],
      channel_id: "juke",
      scheduled_for: "2026-07-11T02:30:00.000Z",
    };

    await expect(createScheduledCast(request)).resolves.toBe(scheduledCast);
    expect(mockedPost).toHaveBeenCalledWith(
      "/v1/feed/scheduled-casts",
      request,
    );
    expect(request).not.toHaveProperty("fid");
    expect(request).not.toHaveProperty("signer_uuid");
  });

  it("lists pending jobs through the existing endpoint", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { scheduled_casts: [scheduledCast] },
    });

    await expect(getScheduledCasts({ limit: 25 })).resolves.toEqual([
      scheduledCast,
    ]);
    expect(mockedGet).toHaveBeenCalledWith("/v1/feed/scheduled-casts", {
      params: { limit: 25, include_history: undefined },
    });
  });
});
