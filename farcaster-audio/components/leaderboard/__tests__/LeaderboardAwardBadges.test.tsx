import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import { LeaderboardAwardBadges } from "../LeaderboardAwardBadges";
import { getLeaderboardAwards } from "@/services/leaderboard";

jest.mock("@/services/leaderboard", () => {
  const actual = jest.requireActual("@/services/leaderboard");
  return {
    ...(actual as object),
    getLeaderboardAwards: jest.fn(),
  };
});

jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (value: unknown) => unknown) =>
    factory({
      colors: {
        background: { subtle: "#222" },
        purple: "#855DCD",
        text: { primary: "#fff" },
      },
    }),
}));

const mockedGetAwards = jest.mocked(getLeaderboardAwards);

describe("LeaderboardAwardBadges", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders nothing while loading or when there are no awards", async () => {
    mockedGetAwards.mockResolvedValueOnce({ fid: 1, awards: [] });
    const screen = render(<LeaderboardAwardBadges fid={1} />);

    expect(screen.toJSON()).toBeNull();
    await act(async () => undefined);
    expect(screen.toJSON()).toBeNull();
  });

  it("renders nothing on fetch failure", async () => {
    mockedGetAwards.mockRejectedValueOnce(new Error("network"));
    const screen = render(<LeaderboardAwardBadges fid={1} />);

    await act(async () => undefined);
    expect(screen.toJSON()).toBeNull();
  });

  it("renders a chip per award using status-only recognition copy", async () => {
    mockedGetAwards.mockResolvedValueOnce({
      fid: 1,
      awards: [
        { cycle: "2026-06", category: "top_hosts", label: "Top Host", rank: 1 },
      ],
    });
    const screen = render(<LeaderboardAwardBadges fid={1} />);

    await act(async () => undefined);
    expect(screen.getByText("Top Host — June 2026")).toBeTruthy();
  });
});
