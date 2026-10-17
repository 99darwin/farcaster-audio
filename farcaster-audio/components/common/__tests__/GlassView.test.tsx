import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { act, render, waitFor } from "@testing-library/react-native";
import { GlassView } from "../GlassView";

let reduceTransparencyListener: ((enabled: boolean) => void) | null = null;
const mockRemove = jest.fn();

jest.mock("expo-blur", () => ({
  BlurView: ({ testID, ...props }: { testID?: string }) => {
    const React = require("react");
    const { View } = require("react-native");
    return React.createElement(View, { testID, ...props });
  },
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    glass: {
      blurIntensity: 80,
      tint: "dark",
      overlayColor: "rgba(26, 26, 46, 0.45)",
      borderColor: "rgba(255,255,255,0.12)",
      shadow: {
        color: "#000",
        offset: { width: 0, height: 8 },
        opacity: 0.35,
        radius: 24,
      },
    },
  }),
}));

describe("GlassView", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reduceTransparencyListener = null;
    jest
      .spyOn(AccessibilityInfo, "isReduceTransparencyEnabled")
      .mockResolvedValue(false);
    jest
      .spyOn(AccessibilityInfo, "addEventListener")
      .mockImplementation(
        ((event: string, listener: (enabled: boolean) => void) => {
          if (event === "reduceTransparencyChanged") {
            reduceTransparencyListener = listener;
          }
          return { remove: mockRemove };
        }) as unknown as typeof AccessibilityInfo.addEventListener,
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders native blur with a translucent overlay and highlight", async () => {
    const screen = render(
      <GlassView testID="surface" style={{ borderRadius: 28 }}>
        <View testID="content" />
      </GlassView>,
    );

    await waitFor(() => expect(screen.getByTestId("glass-blur")).toBeTruthy());
    expect(screen.getByTestId("glass-blur").props).toMatchObject({
      intensity: 80,
      tint: "dark",
      blurMethod: "dimezisBlurViewSdk31Plus",
    });
    expect(
      StyleSheet.flatten(
        screen.getByTestId("glass-translucent-overlay").props.style,
      ),
    ).toMatchObject({ backgroundColor: "rgba(26, 26, 46, 0.45)" });
    expect(screen.getByTestId("glass-highlight")).toBeTruthy();
    expect(screen.getByTestId("content")).toBeTruthy();
  });

  it("allows a lighter material variant for floating navigation", async () => {
    const screen = render(
      <GlassView
        blurIntensity={26}
        overlayColor="rgba(20, 22, 48, 0.16)"
        tint="default"
      >
        <View />
      </GlassView>,
    );

    await waitFor(() => expect(screen.getByTestId("glass-blur")).toBeTruthy());
    expect(screen.getByTestId("glass-blur").props).toMatchObject({
      intensity: 26,
      tint: "default",
    });
    expect(
      StyleSheet.flatten(
        screen.getByTestId("glass-translucent-overlay").props.style,
      ),
    ).toMatchObject({ backgroundColor: "rgba(20, 22, 48, 0.16)" });
  });

  it("keeps a readable translucent fallback when transparency is reduced", async () => {
    const screen = render(
      <GlassView overlayColor="rgba(15, 15, 35, 0.72)">
        <View />
      </GlassView>,
    );

    await waitFor(() => expect(screen.getByTestId("glass-blur")).toBeTruthy());
    act(() => reduceTransparencyListener?.(true));

    await waitFor(() => expect(screen.queryByTestId("glass-blur")).toBeNull());
    expect(
      StyleSheet.flatten(
        screen.getByTestId("glass-translucent-overlay").props.style,
      ),
    ).toMatchObject({ backgroundColor: "rgba(15, 15, 35, 0.72)" });
    expect(
      StyleSheet.flatten(
        screen.getByTestId("glass-reduced-transparency-boost").props.style,
      ),
    ).toMatchObject({ backgroundColor: "rgba(15, 15, 35, 0.72)" });
  });

  it("removes the accessibility listener on unmount", () => {
    const screen = render(
      <GlassView>
        <View />
      </GlassView>,
    );
    screen.unmount();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
