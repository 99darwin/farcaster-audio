import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useLeaderboard } from "@/hooks/useLeaderboard";
import {
  getLeaderboard,
  getMyLeaderboardStanding,
  type LeaderboardMeResponse,
  type LeaderboardResponse,
} from "@/services/leaderboard";

// Pin the clock-dependent helpers to a fixed "now" (2026-08-15) so the
// tests are deterministic regardless of when they run: current cycle is
// 2026-08, exactly one month after FIRST_CYCLE (2026-07), so exactly one
// backward navigation step is allowed.
jest.mock("@/services/leaderboard", () => {
  const actual = jest.requireActual(
    "@/services/leaderboard",
  ) as typeof import("@/services/leaderboard");
  const fixedNow = new Date("2026-08-15T12:00:00.000Z");
  return {
    ...actual,
    currentCycle: (now?: Date) => actual.currentCycle(now ?? fixedNow),
    isAtOrAfterCurrentCycle: (cycle: string, now?: Date) =>
      actual.isAtOrAfterCurrentCycle(cycle, now ?? fixedNow),
    getLeaderboard: jest.fn(),
    getMyLeaderboardStanding: jest.fn(),
  };
});

// The real @/services/api module wires axios interceptors + auth-refresh
// machinery on import; the hook only needs getErrorMessage from it.
jest.mock("@/services/api", () => ({
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "error",
}));

// The state object must be referentially stable across renders — the hook
// keys effects on `user` identity, and a fresh object per render would spin
// the fetch-standing effect forever.
jest.mock("@/stores/authStore", () => {
  const state = { user: { fid: 123 } };
  return {
    useAuthStore: (selector: (s: unknown) => unknown) => selector(state),
  };
});

const mockedGetLeaderboard = jest.mocked(getLeaderboard);
const mockedGetStanding = jest.mocked(getMyLeaderboardStanding);

function board(
  cycle: string,
  entries: LeaderboardResponse["categories"][number]["entries"] = [],
): LeaderboardResponse {
  return {
    cycle,
    status: "provisional",
    computed_at: "2026-08-15T00:00:00.000Z",
    categories: [
      { key: "top_hosts", label: "Top Hosts", entries },
      { key: "top_voices", label: "Top Voices", entries: [] },
      { key: "top_casters", label: "Top Casters", entries: [] },
      { key: "community", label: "Community", entries: [] },
    ],
  };
}

const standing: LeaderboardMeResponse = {
  cycle: "2026-08",
  opt_out: false,
  categories: [{ key: "top_hosts", rank: 12, score: 3.2 }],
};

describe("useLeaderboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetStanding.mockResolvedValue(standing);
  });

  it("loads the current cycle's board and standing on mount", async () => {
    mockedGetLeaderboard.mockResolvedValue(board("2026-08"));
    const { result, unmount } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockedGetLeaderboard).toHaveBeenCalledWith("2026-08");
    expect(result.current.cycle).toBe("2026-08");
    expect(result.current.data?.cycle).toBe("2026-08");
    expect(result.current.standing).toBe(standing);
    unmount();
  });

  it("clamps navigation at the current cycle and the first cycle", async () => {
    mockedGetLeaderboard.mockResolvedValue(board("2026-08"));
    const { result, unmount } = renderHook(() => useLeaderboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.canGoNext).toBe(false);
    expect(result.current.canGoPrevious).toBe(true);

    act(() => result.current.goToNextCycle());
    expect(result.current.cycle).toBe("2026-08");

    act(() => result.current.goToPreviousCycle());
    expect(result.current.cycle).toBe("2026-07");
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.canGoNext).toBe(true);

    act(() => result.current.goToPreviousCycle());
    expect(result.current.cycle).toBe("2026-07");

    act(() => result.current.goToNextCycle());
    expect(result.current.cycle).toBe("2026-08");
    unmount();
  });

  it("ignores an out-of-order response from a superseded cycle fetch", async () => {
    let resolveAugust: (value: LeaderboardResponse) => void = () => {};
    const augustPromise = new Promise<LeaderboardResponse>((resolve) => {
      resolveAugust = resolve;
    });
    mockedGetLeaderboard
      .mockReturnValueOnce(augustPromise)
      .mockResolvedValueOnce(board("2026-07"));

    const { result, unmount } = renderHook(() => useLeaderboard());
    // Switch to July while August is still in flight.
    act(() => result.current.goToPreviousCycle());
    await waitFor(() => expect(result.current.data?.cycle).toBe("2026-07"));

    // The stale August response resolves last — it must not clobber July.
    await act(async () => {
      resolveAugust(board("2026-08"));
      await augustPromise;
    });
    expect(result.current.data?.cycle).toBe("2026-07");
    expect(result.current.cycle).toBe("2026-07");
    unmount();
  });

  it("clears the previous board while a new cycle loads", async () => {
    mockedGetLeaderboard.mockResolvedValueOnce(board("2026-08"));
    let resolveJuly: (value: LeaderboardResponse) => void = () => {};
    const julyPromise = new Promise<LeaderboardResponse>((resolve) => {
      resolveJuly = resolve;
    });
    mockedGetLeaderboard.mockReturnValueOnce(julyPromise);

    const { result, unmount } = renderHook(() => useLeaderboard());
    await waitFor(() => expect(result.current.data?.cycle).toBe("2026-08"));

    act(() => result.current.goToPreviousCycle());
    // August's rows must not linger under July's header.
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveJuly(board("2026-07"));
      await julyPromise;
    });
    expect(result.current.data?.cycle).toBe("2026-07");
    unmount();
  });

  it("derives isEmpty only when every category is empty", async () => {
    mockedGetLeaderboard.mockResolvedValueOnce(board("2026-08"));
    const { result, unmount } = renderHook(() => useLeaderboard());
    await waitFor(() => expect(result.current.isEmpty).toBe(true));

    mockedGetLeaderboard.mockResolvedValueOnce(
      board("2026-08", [
        {
          rank: 1,
          fid: 123,
          username: "nick",
          display_name: "Nick",
          pfp_url: null,
          score: 87.4,
        },
      ]),
    );
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.activeEntries).toHaveLength(1));
    expect(result.current.isEmpty).toBe(false);
    unmount();
  });

  it("surfaces a board error and refetches standing on refresh", async () => {
    mockedGetLeaderboard.mockRejectedValueOnce(new Error("boom"));
    mockedGetStanding.mockRejectedValueOnce(new Error("boom"));
    const { result, unmount } = renderHook(() => useLeaderboard());
    await waitFor(() => expect(result.current.error).toBe("boom"));

    expect(result.current.data).toBeNull();
    expect(result.current.standing).toBeNull();

    mockedGetLeaderboard.mockResolvedValueOnce(board("2026-08"));
    mockedGetStanding.mockResolvedValue(standing);
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.data?.cycle).toBe("2026-08"));
    expect(result.current.error).toBeNull();
    expect(result.current.standing).toBe(standing);
    expect(mockedGetStanding).toHaveBeenCalledTimes(2);
    unmount();
  });
});
