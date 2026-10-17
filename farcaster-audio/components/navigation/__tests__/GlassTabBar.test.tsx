import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { StyleSheet } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { GlassTabBar } from "../GlassTabBar";
import { useMessageStore } from "@/stores/messageStore";

const mockPush = jest.fn();
const mockEmit = jest.fn(() => ({ defaultPrevented: false }));
const mockNavigate = jest.fn();
const mockMarkAllRead = jest.fn();
let mockUnreadCount = 24;

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Ionicons: ({ name }: { name: string }) =>
      React.createElement(Text, null, name),
  };
});

jest.mock("@/components/common/GlassView", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    GlassView: ({
      children,
      style,
      testID,
      overlayColor,
      blurIntensity,
      tint,
    }: {
      children: React.ReactNode;
      style: unknown;
      testID?: string;
      overlayColor?: string;
      blurIntensity?: number;
      tint?: string;
    }) =>
      React.createElement(
        View,
        { style, testID, overlayColor, blurIntensity, tint },
        children,
      ),
  };
});

jest.mock("@/stores/notificationStore", () => ({
  useNotificationStore: (selector: (state: unknown) => unknown) =>
    selector({ unreadCount: mockUnreadCount, markAllRead: mockMarkAllRead }),
}));

jest.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { fid: 123 } }),
}));

jest.mock("@/utils/haptics", () => ({
  haptic: { selection: jest.fn() },
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: {
      accent: "#D85A30",
      danger: "#dc2626",
      background: { main: "#0f0f23", surface: "#1a1a2e" },
      text: { primary: "#fff", secondary: "#999" },
    },
    glass: {
      pillRadius: 28,
      borderColor: "rgba(255,255,255,.12)",
      navigationBlurIntensity: 26,
      navigationOverlayColor: "rgba(20, 22, 48, 0.16)",
    },
  }),
}));
jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (value: unknown) => unknown) =>
    factory({
      colors: {
        accent: "#D85A30",
        danger: "#dc2626",
        background: { main: "#0f0f23", surface: "#1a1a2e" },
        text: { primary: "#fff", secondary: "#999" },
      },
      glass: {
        pillRadius: 28,
        borderColor: "rgba(255,255,255,.12)",
        navigationBlurIntensity: 26,
        navigationOverlayColor: "rgba(20, 22, 48, 0.16)",
      },
    }),
}));

function props(index = 0, onCompose = jest.fn()) {
  return {
    state: {
      index,
      key: "tabs",
      routeNames: ["index", "notifications"],
      history: [],
      stale: false as const,
      type: "tab" as const,
      routes: [
        { key: "home-key", name: "index", params: undefined },
        { key: "notifications-key", name: "notifications", params: undefined },
      ],
    },
    descriptors: {},
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    navigation: {
      emit: mockEmit,
      navigate: mockNavigate,
    },
    onCompose,
  } as unknown as React.ComponentProps<typeof GlassTabBar>;
}

describe("GlassTabBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmit.mockReturnValue({ defaultPrevented: false });
    mockUnreadCount = 24;
  });

  it("renders one centered surface without search, with safe-area placement", () => {
    const screen = render(<GlassTabBar {...props()} />);

    expect(screen.getByLabelText("Home").props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.queryByLabelText("Search")).toBeNull();
    expect(screen.getByLabelText("New cast")).toBeTruthy();
    expect(screen.getByLabelText("Notifications")).toBeTruthy();
    expect(screen.getByLabelText("Profile")).toBeTruthy();
    expect(screen.getByTestId("glass-tab-bar").props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ bottom: 42 })]),
    );
    expect(screen.getByTestId("tab-bar-glass-surface")).toBeTruthy();
    expect(screen.getByTestId("tab-bar-glass-surface").props).toMatchObject({
      tint: "default",
      blurIntensity: 26,
      overlayColor: "rgba(20, 22, 48, 0.16)",
    });
    expect(
      screen.getByText("20+", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Notifications").props.accessibilityHint,
    ).toBe("24 unread notifications");
    expect(
      StyleSheet.flatten(
        screen.getByTestId("notification-badge", {
          includeHiddenElements: true,
        }).props.style,
      ),
    ).toMatchObject({
      top: -7,
      right: -9,
      height: 20,
      minWidth: 20,
      backgroundColor: "#dc2626",
      borderColor: "#0f0f23",
    });
  });

  it("opens compose in place and routes profile intentionally", () => {
    const onCompose = jest.fn();
    const screen = render(<GlassTabBar {...props(0, onCompose)} />);

    fireEvent.press(screen.getByLabelText("New cast"));
    expect(onCompose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Profile"));
    expect(mockPush).toHaveBeenCalledWith("/profile/123");
  });

  it("marks read on a genuine focused notifications re-tap", () => {
    const screen = render(<GlassTabBar {...props(1)} />);
    fireEvent.press(screen.getByLabelText("Notifications"));

    expect(mockEmit).toHaveBeenCalledWith({
      type: "tabPress",
      target: "notifications-key",
      canPreventDefault: true,
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it("does not clear the badge or navigate when notification navigation is prevented", () => {
    mockEmit.mockReturnValue({ defaultPrevented: true });
    const screen = render(<GlassTabBar {...props(0)} />);

    fireEvent.press(screen.getByLabelText("Notifications"));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockMarkAllRead).not.toHaveBeenCalled();
    expect(
      screen.getByText("20+", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it("does not clear a focused badge when its tab event is prevented", () => {
    mockEmit.mockReturnValue({ defaultPrevented: true });
    const screen = render(<GlassTabBar {...props(1)} />);

    fireEvent.press(screen.getByLabelText("Notifications"));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockMarkAllRead).not.toHaveBeenCalled();
  });

  it("navigates to notifications but lets the focused screen mark them read", () => {
    const screen = render(<GlassTabBar {...props(0)} />);

    fireEvent.press(screen.getByLabelText("Notifications"));

    expect(mockNavigate).toHaveBeenCalledWith("notifications", undefined);
    expect(mockMarkAllRead).not.toHaveBeenCalled();
  });

  it("does not render an empty notification badge", () => {
    mockUnreadCount = 0;
    const screen = render(<GlassTabBar {...props(0)} />);

    expect(
      screen.queryByTestId("notification-badge", {
        includeHiddenElements: true,
      }),
    ).toBeNull();
    expect(
      screen.getByLabelText("Notifications").props.accessibilityHint,
    ).toBeUndefined();
  });

  it("shows a Messages tab with its own unread badge", () => {
    useMessageStore.setState({ unreadTotal: 120, availability: "available" });
    const base = props(0);
    const withMessages = {
      ...base,
      state: {
        ...base.state,
        routeNames: ["index", "messages", "notifications"],
        routes: [
          base.state.routes[0],
          { key: "messages-key", name: "messages", params: undefined },
          base.state.routes[1],
        ],
      },
    } as unknown as React.ComponentProps<typeof GlassTabBar>;

    const screen = render(<GlassTabBar {...withMessages} />);

    // Two and two around compose: Home, Messages | + | Notifications, Profile.
    const order = ["Home", "Messages", "New cast", "Notifications", "Profile"];
    const buttons = screen.getAllByRole(/^(tab|button)$/);
    expect(buttons.map((b) => b.props.accessibilityLabel)).toEqual(order);
    expect(screen.getByText("99+", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId("messages-badge", { includeHiddenElements: true })).toBeTruthy();

    act(() => useMessageStore.setState({ availability: "unavailable" }));
    expect(screen.queryByTestId("tab-messages")).toBeNull();
  });
});
