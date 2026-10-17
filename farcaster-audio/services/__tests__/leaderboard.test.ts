import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { apiClient } from "@/services/api";
import {
  currentCycle,
  formatCycleLabel,
  getLeaderboard,
  getLeaderboardAwards,
  getMyLeaderboardStanding,
  isAtOrAfterCurrentCycle,
  setLeaderboardOptOut,
  shiftCycle,
  type LeaderboardAwardsResponse,
  type LeaderboardMeResponse,
  type LeaderboardOptOutResponse,
  type LeaderboardResponse,
} from "@/services/leaderboard";

jest.mock("@/services/api", () => ({
  apiClient: {
    get: jest.fn(),
    put: jest.fn(),
  },
}));

const mockedGet = jest.mocked(apiClient.get);
const mockedPut = jest.mocked(apiClient.put);

describe("leaderboard cycle helpers", () => {
  it("computes the current UTC cycle in YYYY-MM form", () => {
    expect(currentCycle(new Date("2026-07-10T20:00:00.000Z"))).toBe(
      "2026-07",
    );
    expect(currentCycle(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "2026-01",
    );
  });

  it("shifts across month and year boundaries in both directions", () => {
    expect(shiftCycle("2026-07", -1)).toBe("2026-06");
    expect(shiftCycle("2026-01", -1)).toBe("2025-12");
    expect(shiftCycle("2026-12", 1)).toBe("2027-01");
    expect(shiftCycle("2026-07", 0)).toBe("2026-07");
  });

  it("flags cycles at or after the real current cycle", () => {
    const now = new Date("2026-07-10T20:00:00.000Z");
    expect(isAtOrAfterCurrentCycle("2026-07", now)).toBe(true);
    expect(isAtOrAfterCurrentCycle("2026-08", now)).toBe(true);
    expect(isAtOrAfterCurrentCycle("2026-06", now)).toBe(false);
  });

  it("formats a cycle as a human-readable month and year", () => {
    expect(formatCycleLabel("2026-06")).toBe("June 2026");
    expect(formatCycleLabel("2027-01")).toBe("January 2027");
  });

  it("falls back to the raw string for a malformed cycle", () => {
    expect(formatCycleLabel("not-a-cycle")).toBe("not-a-cycle");
  });
});

describe("leaderboard API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches the public board for a given cycle", async () => {
    const response: LeaderboardResponse = {
      cycle: "2026-07",
      status: "provisional",
      computed_at: "2026-07-10T00:00:00.000Z",
      categories: [
        {
          key: "top_hosts",
          label: "Top Hosts",
          entries: [
            {
              rank: 1,
              fid: 123,
              username: "nick",
              display_name: "Nick",
              pfp_url: "https://example.com/pfp.png",
              score: 87.4,
            },
          ],
        },
      ],
    };
    mockedGet.mockResolvedValueOnce({ data: response });

    await expect(getLeaderboard("2026-07")).resolves.toBe(response);
    expect(mockedGet).toHaveBeenCalledWith("/v1/leaderboard", {
      params: { cycle: "2026-07" },
    });
  });

  it("fetches the signed-in user's standing", async () => {
    const response: LeaderboardMeResponse = {
      cycle: "2026-07",
      opt_out: false,
      categories: [{ key: "top_hosts", rank: 12, score: 3.2 }],
    };
    mockedGet.mockResolvedValueOnce({ data: response });

    await expect(getMyLeaderboardStanding()).resolves.toBe(response);
    expect(mockedGet).toHaveBeenCalledWith("/v1/leaderboard/me");
  });

  it("submits an opt-out toggle", async () => {
    const response: LeaderboardOptOutResponse = { opt_out: true };
    mockedPut.mockResolvedValueOnce({ data: response });

    await expect(setLeaderboardOptOut(true)).resolves.toBe(response);
    expect(mockedPut).toHaveBeenCalledWith("/v1/leaderboard/opt-out", {
      opt_out: true,
    });
  });

  it("fetches awards for a fid", async () => {
    const response: LeaderboardAwardsResponse = {
      fid: 123,
      awards: [
        { cycle: "2026-06", category: "top_hosts", label: "Top Host", rank: 1 },
      ],
    };
    mockedGet.mockResolvedValueOnce({ data: response });

    await expect(getLeaderboardAwards(123)).resolves.toBe(response);
    expect(mockedGet).toHaveBeenCalledWith("/v1/leaderboard/awards/123");
  });
});
