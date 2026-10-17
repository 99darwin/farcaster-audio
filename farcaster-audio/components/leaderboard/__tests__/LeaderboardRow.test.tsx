import React from "react";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { LeaderboardRow } from "../LeaderboardRow";
import type { LeaderboardEntry } from "@/services/leaderboard";

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: {
      text: { primary: "#fff", secondary: "#999" },
    },
  }),
}));

jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (value: unknown) => unknown) =>
    factory({
      colors: {
        text: { primary: "#fff", secondary: "#999" },
      },
    }),
}));

jest.mock("@/components/common/Avatar", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Avatar: () => React.createElement(View, { testID: "avatar" }) };
});

const entry: LeaderboardEntry = {
  rank: 1,
  fid: 123,
  username: "nick",
  display_name: "Nick",
  pfp_url: "https://example.com/pfp.png",
  score: 87.4,
};

describe("LeaderboardRow", () => {
  it("renders rank, name, username, and score", () => {
    const screen = render(<LeaderboardRow entry={entry} onPress={jest.fn()} />);

    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Nick")).toBeTruthy();
    expect(screen.getByText("@nick")).toBeTruthy();
    expect(screen.getByText("87.4")).toBeTruthy();
  });

  it("formats whole-number scores without a decimal", () => {
    const screen = render(
      <LeaderboardRow entry={{ ...entry, score: 90 }} onPress={jest.fn()} />,
    );
    expect(screen.getByText("90")).toBeTruthy();
  });

  it("invokes onPress with the entry's fid", () => {
    const onPress = jest.fn();
    const screen = render(<LeaderboardRow entry={entry} onPress={onPress} />);

    fireEvent.press(
      screen.getByLabelText("Rank 1, Nick, score 87.4"),
    );
    expect(onPress).toHaveBeenCalledWith(123);
  });

  it("labels below-top-3 ranks without special styling assumptions", () => {
    const screen = render(
      <LeaderboardRow
        entry={{ ...entry, rank: 12, score: 3.2 }}
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("falls back to a fid-based name and hides the bare @ when username and display_name are null", () => {
    const screen = render(
      <LeaderboardRow
        entry={{ ...entry, username: null, display_name: null }}
        onPress={jest.fn()}
      />,
    );

    expect(screen.getByText("User 123")).toBeTruthy();
    expect(screen.queryByText("@")).toBeNull();
    const label = screen.getByLabelText(
      "Rank 1, User 123, score 87.4",
    );
    expect(label).toBeTruthy();
    expect(label.props.accessibilityLabel).not.toContain("null");
  });

  it("falls back to username when display_name is null", () => {
    const screen = render(
      <LeaderboardRow
        entry={{ ...entry, display_name: null }}
        onPress={jest.fn()}
      />,
    );

    expect(screen.getByText("nick")).toBeTruthy();
    expect(screen.getByText("@nick")).toBeTruthy();
  });
});
