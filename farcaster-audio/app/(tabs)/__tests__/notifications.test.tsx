import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import NotificationsScreen from "../notifications";

const mockScrollToOffset = jest.fn();
let mockIsFocused = false;
let mockTabPressListener: (() => void) | null = null;

const mockAddListener = jest.fn(
  (type: string, listener: () => void): (() => void) => {
    if (type === "tabPress") mockTabPressListener = listener;
    return () => {
      if (mockTabPressListener === listener) mockTabPressListener = null;
    };
  },
);
const mockNavigation = { addListener: mockAddListener };

const mockRefresh = jest.fn<() => Promise<void>>();
const mockFetch = jest.fn<() => Promise<void>>();
const mockMarkAsRead = jest.fn();
const mockNotifications: never[] = [];

jest.mock("react-native", () => {
  const React = require("react");
  const actual = jest.requireActual(
    "react-native",
  ) as typeof import("react-native");
  const FlatList = React.forwardRef(
    (_props: unknown, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        scrollToOffset: mockScrollToOffset,
      }));
      return React.createElement(actual.View, {
        testID: "notifications-list",
      });
    },
  );

  Object.defineProperty(actual, "FlatList", { value: FlatList });
  return actual;
});

jest.mock("expo-router", () => ({
  useNavigation: () => mockNavigation,
}));

jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => mockIsFocused,
}));

jest.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: mockNotifications,
    isLoading: false,
    isRefreshing: false,
    hasMore: false,
    fetch: mockFetch,
    fetchMore: jest.fn(),
    refresh: mockRefresh,
    markAsRead: mockMarkAsRead,
    handleLike: jest.fn(),
    handleRecast: jest.fn(),
    handleBookmark: jest.fn(),
    handlePublishCast: jest.fn(),
  }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));

jest.mock("@/components/navigation/GlassTabBar", () => ({
  TAB_BAR_CONTENT_INSET: 80,
}));

jest.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { fid: 123 } }),
}));

jest.mock("@/components/notifications/NotificationItem", () => ({
  NotificationItem: () => null,
}));

jest.mock("@/components/feed/ComposeModal", () => ({
  ComposeModal: () => null,
}));

jest.mock("@/services/storage", () => ({
  getLastSeenNotificationTimestamp: jest
    .fn<() => Promise<string | null>>()
    .mockResolvedValue(null),
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: {
      background: { main: "#000" },
      text: { secondary: "#999" },
    },
  }),
}));

jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (
    factory: (theme: {
      colors: {
        background: { main: string };
        text: { secondary: string };
      };
    }) => unknown,
  ) =>
    factory({
      colors: {
        background: { main: "#000" },
        text: { secondary: "#999" },
      },
    }),
}));

describe("NotificationsScreen tab activation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFocused = false;
    mockTabPressListener = null;
    mockFetch.mockResolvedValue(undefined);
    mockRefresh.mockResolvedValue(undefined);
  });

  it("fetches first entry without a pull refresh or scroll animation", async () => {
    const screen = render(<NotificationsScreen />);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();

    mockIsFocused = true;
    await act(async () => {
      screen.rerender(<NotificationsScreen />);
    });

    expect(mockScrollToOffset).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockMarkAsRead).toHaveBeenCalledTimes(1);
  });

  it("scrolls and refreshes when the selected tab is tapped again", async () => {
    mockIsFocused = true;
    render(<NotificationsScreen />);

    await act(async () => undefined);
    mockScrollToOffset.mockClear();
    mockRefresh.mockClear();

    act(() => {
      mockTabPressListener?.();
    });

    expect(mockScrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("deduplicates refreshes while keeping repeated scroll-to-top taps", async () => {
    let finishRefresh: (() => void) | undefined;
    mockRefresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    mockIsFocused = true;
    render(<NotificationsScreen />);
    await act(async () => undefined);

    act(() => {
      mockTabPressListener?.();
      mockTabPressListener?.();
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockScrollToOffset).toHaveBeenCalledTimes(2);

    act(() => {
      finishRefresh?.();
    });
  });

  it("scrolls and refreshes once when returning to the tab", async () => {
    mockIsFocused = true;
    const screen = render(<NotificationsScreen />);
    await act(async () => undefined);

    mockScrollToOffset.mockClear();
    mockRefresh.mockClear();
    mockIsFocused = false;
    screen.rerender(<NotificationsScreen />);
    mockIsFocused = true;
    await act(async () => {
      screen.rerender(<NotificationsScreen />);
    });

    expect(mockScrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
