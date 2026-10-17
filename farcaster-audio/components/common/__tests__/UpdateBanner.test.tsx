import React from "react";
import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render } from "@testing-library/react-native";
import { UpdateBanner } from "../UpdateBanner";

jest.mock("@expo/vector-icons", () => ({
  Ionicons: () => null,
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: { text: { primary: "#fff", secondary: "#ccc" } },
  }),
}));

jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (theme: unknown) => unknown) =>
    factory({
      colors: {
        purple: "#855DCD",
        text: { primary: "#fff", secondary: "#ccc" },
      },
      glass: { accentOverlay: "rgba(255,255,255,0.2)" },
    }),
}));

describe("UpdateBanner", () => {
  it("labels an already-downloaded update as a restart", () => {
    const screen = render(
      <UpdateBanner
        isRestarting={false}
        onUpdate={jest.fn<() => void>()}
        onDismiss={jest.fn<() => void>()}
      />,
    );

    expect(screen.getByText("Update downloaded and ready")).toBeTruthy();
    expect(screen.getByLabelText("Restart to update")).toBeTruthy();
    expect(screen.getByLabelText("Dismiss update")).toBeTruthy();
  });

  it("shows restart progress without leaving active actions", () => {
    const screen = render(
      <UpdateBanner
        isRestarting
        onUpdate={jest.fn<() => void>()}
        onDismiss={jest.fn<() => void>()}
      />,
    );

    expect(screen.getByText("Restarting to apply update…")).toBeTruthy();
    expect(screen.getByLabelText("Restarting to apply update")).toBeTruthy();
    expect(screen.queryByLabelText("Restart to update")).toBeNull();
    expect(screen.queryByLabelText("Dismiss update")).toBeNull();
  });

  it("restores a retry action when restart rejects", async () => {
    const onUpdate = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("safe failure"))
      .mockResolvedValueOnce(undefined);
    const screen = render(
      <UpdateBanner
        isRestarting={false}
        onUpdate={onUpdate}
        onDismiss={jest.fn<() => void>()}
      />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Restart to update"));
    });

    expect(
      screen.getByText("Couldn't restart to apply the update. Try again."),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Retry update restart"));
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });
});
