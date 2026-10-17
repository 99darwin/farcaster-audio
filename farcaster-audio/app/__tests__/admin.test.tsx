/**
 * L8: the admin screen used to return before its useState/useEffect calls,
 * so an admin flag flipping mid-session changed the hook order and crashed
 * React. It must also never call admin endpoints for a non-admin.
 */
import React from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, waitFor } from "@testing-library/react-native";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-toast-message", () => ({ show: jest.fn() }));

const mockAdminListRooms = jest.fn<() => Promise<{ rooms: unknown[] }>>();
jest.mock("@/services/api", () => ({
  adminListRooms: () => mockAdminListRooms(),
  getErrorMessage: () => "error",
}));

import AdminScreen from "../admin";
import { useAuthStore } from "@/stores/authStore";

function setAdmin(isAdmin: boolean) {
  useAuthStore.setState({
    user: { fid: 1, username: "a", display_name: "A", is_admin: isAdmin } as never,
  });
}

describe("AdminScreen", () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockAdminListRooms.mockReset();
    mockAdminListRooms.mockResolvedValue({ rooms: [] });
  });

  it("redirects a non-admin without calling admin endpoints", () => {
    setAdmin(false);
    const screen = render(<AdminScreen />);
    expect(screen.toJSON()).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith("/");
    expect(mockAdminListRooms).not.toHaveBeenCalled();
  });

  it("survives the admin flag flipping in both directions", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    setAdmin(false);
    const screen = render(<AdminScreen />);
    act(() => setAdmin(true));
    await waitFor(() => expect(mockAdminListRooms).toHaveBeenCalledTimes(1));
    act(() => setAdmin(false));
    expect(screen.toJSON()).toBeNull();
    const hookOrderErrors = consoleError.mock.calls.filter((args) =>
      String(args[0]).match(/order of Hooks|Rendered (more|fewer) hooks/),
    );
    expect(hookOrderErrors).toHaveLength(0);
    consoleError.mockRestore();
  });
});
