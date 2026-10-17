import { apiFetch } from "@/lib/api/client";
import {
  cancelScheduledCast,
  createScheduledCast,
  getScheduledCasts,
} from "@/lib/api/scheduled-casts";
import {
  defaultScheduleValue,
  MAX_SCHEDULE_HORIZON_MS,
  validateLocalSchedule,
} from "@/lib/compose/scheduling";

jest.mock("@/lib/api/client", () => ({ apiFetch: jest.fn() }));

const mockedApiFetch = jest.mocked(apiFetch);

describe("scheduled-cast time helpers", () => {
  const now = new Date(2026, 6, 9, 10, 0, 0, 0);

  it("defaults to a useful local time about one hour ahead", () => {
    expect(defaultScheduleValue(now)).toBe("2026-07-09T11:00");
  });

  it("turns a numeric local wall time into an offset-aware UTC ISO value", () => {
    const result = validateLocalSchedule("2026-07-09T11:30", now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utcIso).toBe(result.date.toISOString());
    expect(result.utcIso.endsWith("Z")).toBe(true);
    expect(result.date.getHours()).toBe(11);
    expect(result.date.getMinutes()).toBe(30);
  });

  it("rejects missing, impossible, too-soon, and over-horizon values", () => {
    expect(validateLocalSchedule("", now)).toEqual({
      ok: false,
      error: "Choose a date and time.",
    });
    expect(validateLocalSchedule("2026-02-30T11:00", now).ok).toBe(false);
    expect(validateLocalSchedule("2026-07-09T10:00", now).ok).toBe(false);
    const tooLate = new Date(now.getTime() + MAX_SCHEDULE_HORIZON_MS + 60_000);
    const value = [
      tooLate.getFullYear(),
      "-",
      String(tooLate.getMonth() + 1).padStart(2, "0"),
      "-",
      String(tooLate.getDate()).padStart(2, "0"),
      "T",
      String(tooLate.getHours()).padStart(2, "0"),
      ":",
      String(tooLate.getMinutes()).padStart(2, "0"),
    ].join("");
    expect(validateLocalSchedule(value, now).ok).toBe(false);
  });
});

describe("scheduled-cast API", () => {
  beforeEach(() => mockedApiFetch.mockReset());

  it("posts the caller-provided UTC schedule payload", async () => {
    const body = {
      text: "Later",
      scheduled_for: "2026-07-09T18:00:00.000Z",
      embeds: ["https://example.com/image.jpg"],
    };
    mockedApiFetch.mockResolvedValue({ id: "job-1" });
    await createScheduledCast(body);
    expect(mockedApiFetch).toHaveBeenCalledWith("/v1/feed/scheduled-casts", {
      method: "POST",
      body,
    });
  });

  it("lists active/history safely and URL-encodes cancellation ids", async () => {
    mockedApiFetch.mockResolvedValueOnce({ scheduled_casts: [] });
    await getScheduledCasts({ limit: 25, includeHistory: true });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/v1/feed/scheduled-casts?limit=25&include_history=true",
    );

    mockedApiFetch.mockResolvedValueOnce({ status: "cancelled" });
    await cancelScheduledCast("job/unsafe");
    expect(mockedApiFetch).toHaveBeenLastCalledWith(
      "/v1/feed/scheduled-casts/job%2Funsafe",
      { method: "DELETE" },
    );
  });
});
