import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import LeaderboardScreen from "../leaderboard";
import type { LeaderboardCategoryKey } from "@/services/leaderboard";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Ionicons: ({ name }: { name: string }) =>
      React.createElement(Text, null, name),
  };
});

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: {
      text: { primary: "#fff", secondary: "#999", placeholder: "#666" },
      background: { main: "#000", surface: "#111", border: "#222", subtle: "#222" },
    },
  }),
}));

jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (value: unknown) => unknown) =>
    factory({
      colors: {
        text: { primary: "#fff", secondary: "#999", placeholder: "#666" },
        background: {
          main: "#000",
          surface: "#111",
          border: "#222",
          subtle: "#222",
        },
      },
    }),
}));

jest.mock("@/components/leaderboard/LeaderboardRow", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    LeaderboardRow: ({ entry, onPress }: any) =>
      React.createElement(
        Pressable,
        {
          accessibilityLabel: `row-${entry.fid}`,
          onPress: () => onPress(entry.fid),
        },
        React.createElement(Text, null, entry.display_name),
      ),
  };
});

let mockHookState: any;
jest.mock("@/hooks/useLeaderboard", () => ({
  useLeaderboard: () => mockHookState,
}));

// The screen derives its empty-state copy by comparing `cycle` against the
// real current cycle, so the default mock cycle must track the wall clock.
const CURRENT_CYCLE = jest
  .requireActual<typeof import("@/services/leaderboard")>(
    "@/services/leaderboard",
  )
  .currentCycle();

function baseState(overrides: Partial<typeof mockHookState> = {}) {
  return {
    cycle: CURRENT_CYCLE,
    data: null,
    isLoading: false,
    error: null,
    categoryOrder: [
      "top_hosts",
      "top_voices",
      "top_casters",
      "community",
    ] as LeaderboardCategoryKey[],
    activeCategory: "top_hosts" as LeaderboardCategoryKey,
    setActiveCategory: jest.fn(),
    activeEntries: [],
    isEmpty: false,
    canGoNext: false,
    canGoPrevious: true,
    goToPreviousCycle: jest.fn(),
    goToNextCycle: jest.fn(),
    refresh: jest.fn(),
    standing: null,
    ...overrides,
  };
}

describe("LeaderboardScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows a loading spinner while the first fetch is in flight", () => {
    mockHookState = baseState({ isLoading: true });
    const screen = render(<LeaderboardScreen />);
    expect(screen.getByLabelText("Loading")).toBeTruthy();
  });

  it("shows an error state with a retry action", () => {
    const refresh = jest.fn();
    mockHookState = baseState({ error: "Network error", refresh });
    const screen = render(<LeaderboardScreen />);

    expect(screen.getByText("Network error")).toBeTruthy();
    fireEvent.press(screen.getByText("Try Again"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the status-only empty state for a fresh current cycle", () => {
    mockHookState = baseState({
      data: {
        cycle: CURRENT_CYCLE,
        status: "provisional",
        computed_at: "2026-07-01T00:00:00.000Z",
        categories: [],
      },
      isEmpty: true,
    });
    const screen = render(<LeaderboardScreen />);
    expect(screen.getByText("First cycle in progress")).toBeTruthy();
  });

  it("uses plain empty copy for an empty past cycle", () => {
    mockHookState = baseState({
      cycle: "2020-01",
      data: {
        cycle: "2020-01",
        status: "final",
        computed_at: "2020-02-01T00:00:00.000Z",
        categories: [],
      },
      isEmpty: true,
    });
    const screen = render(<LeaderboardScreen />);
    expect(screen.getByText("No entries for this cycle")).toBeTruthy();
    expect(screen.queryByText("First cycle in progress")).toBeNull();
  });

  it("renders ranked rows and navigates to the profile on press", () => {
    mockHookState = baseState({
      data: {
        cycle: "2026-07",
        status: "final",
        computed_at: "2026-07-01T00:00:00.000Z",
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
                pfp_url: null,
                score: 87.4,
              },
            ],
          },
        ],
      },
      activeEntries: [
        {
          rank: 1,
          fid: 123,
          username: "nick",
          display_name: "Nick",
          pfp_url: null,
          score: 87.4,
        },
      ],
    });
    const screen = render(<LeaderboardScreen />);

    fireEvent.press(screen.getByLabelText("row-123"));
    expect(mockPush).toHaveBeenCalledWith("/profile/123");
  });

  it("renders 'Your standing' with recognition-only labels, never payout language", () => {
    mockHookState = baseState({
      standing: {
        cycle: CURRENT_CYCLE,
        opt_out: false,
        categories: [{ key: "top_hosts", rank: 12, score: 3.2 }],
      },
    });
    const screen = render(<LeaderboardScreen />);

    expect(screen.getByText("Your standing")).toBeTruthy();
    expect(screen.getByText("#12")).toBeTruthy();
    expect(screen.queryByText(/earn/i)).toBeNull();
    expect(screen.queryByText(/reward/i)).toBeNull();
    expect(screen.queryByText(/payout/i)).toBeNull();
  });

  it("hides 'Your standing' while browsing a different cycle", () => {
    mockHookState = baseState({
      cycle: "2020-01",
      standing: {
        cycle: CURRENT_CYCLE,
        opt_out: false,
        categories: [{ key: "top_hosts", rank: 12, score: 3.2 }],
      },
    });
    const screen = render(<LeaderboardScreen />);
    expect(screen.queryByText("Your standing")).toBeNull();
  });

  it("switches the active category through the tab strip", () => {
    const setActiveCategory = jest.fn();
    mockHookState = baseState({ setActiveCategory });
    const screen = render(<LeaderboardScreen />);

    fireEvent.press(screen.getByText("Top Voices"));
    expect(setActiveCategory).toHaveBeenCalledWith("top_voices");
  });
});
