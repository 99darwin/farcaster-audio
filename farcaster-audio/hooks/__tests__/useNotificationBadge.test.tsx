import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { AppState, type AppStateStatus } from "react-native";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useNotificationBadge } from "../useNotificationBadge";
import { useNotificationStore } from "@/stores/notificationStore";
import * as api from "@/services/api";
import * as storage from "@/services/storage";
import type { FarcasterNotification } from "@/types/farcaster";

let mockIsAuthenticated = true;
let appStateListener: ((state: AppStateStatus) => void) | null = null;

jest.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: mockIsAuthenticated }),
}));

jest.mock("@/services/api", () => ({
  getNotifications: jest.fn(),
}));

jest.mock("@/services/storage", () => ({
  getLastSeenNotificationTimestamp: jest.fn(),
}));

const mockGetNotifications = jest.mocked(api.getNotifications);
const mockGetLastSeen = jest.mocked(
  storage.getLastSeenNotificationTimestamp,
);

const notification = (timestamp: string) =>
  ({ most_recent_timestamp: timestamp }) as FarcasterNotification;

describe("useNotificationBadge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAuthenticated = true;
    appStateListener = null;
    useNotificationStore.getState().reset();
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        appStateListener = listener;
        return { remove: jest.fn() };
      });
    mockGetNotifications.mockResolvedValue({
      notifications: [],
      next: { cursor: null },
    });
    mockGetLastSeen.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("loads a full badge page and counts only notifications after last seen", async () => {
    mockGetNotifications.mockResolvedValue({
      notifications: [
        notification("2026-07-10T12:03:00Z"),
        notification("2026-07-10T12:02:00Z"),
        notification("2026-07-10T11:59:00Z"),
      ],
      next: { cursor: "next" },
    });
    mockGetLastSeen.mockResolvedValue("2026-07-10T12:00:00Z");

    renderHook(() => useNotificationBadge());

    await waitFor(() =>
      expect(useNotificationStore.getState().unreadCount).toBe(2),
    );
    expect(mockGetNotifications).toHaveBeenCalledWith({ limit: 25 });
    expect(useNotificationStore.getState().notifications).toHaveLength(3);
  });

  it("treats an invalid stored timestamp as unread instead of hiding the badge", async () => {
    mockGetNotifications.mockResolvedValue({
      notifications: [
        notification("2026-07-10T12:03:00Z"),
        notification("2026-07-10T12:02:00Z"),
      ],
      next: { cursor: null },
    });
    mockGetLastSeen.mockResolvedValue("not-a-date");

    renderHook(() => useNotificationBadge());

    await waitFor(() =>
      expect(useNotificationStore.getState().unreadCount).toBe(2),
    );
  });

  it("clears stale account state and does not fetch while signed out", async () => {
    mockIsAuthenticated = false;
    useNotificationStore.getState().setUnreadCount(9);

    renderHook(() => useNotificationBadge());

    await waitFor(() =>
      expect(useNotificationStore.getState().unreadCount).toBe(0),
    );
    expect(mockGetNotifications).not.toHaveBeenCalled();
  });

  it("throttles active-state refetches using the badge fetch timestamp", async () => {
    renderHook(() => useNotificationBadge());
    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalledTimes(1));
    mockGetNotifications.mockClear();

    act(() => appStateListener?.("active"));

    expect(mockGetNotifications).not.toHaveBeenCalled();
  });
});
