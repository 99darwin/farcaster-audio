import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { renderHook, waitFor } from "@testing-library/react-native";

const mockGetUserProfile = jest.fn<(fid: number) => Promise<unknown>>();
jest.mock("@/services/api", () => ({
  getUserProfile: (fid: number) => mockGetUserProfile(fid),
}));

import {
  __resetRememberedDraftRecipients,
  rememberDraftRecipient,
  useDraftRecipient,
} from "@/hooks/useDraftRecipient";

const ALICE = {
  fid: 42,
  username: "alice",
  display_name: "Alice",
  pfp_url: "https://example.com/a.png",
};

describe("useDraftRecipient", () => {
  beforeEach(() => {
    __resetRememberedDraftRecipients();
    mockGetUserProfile.mockReset();
  });

  it("loads the recipient by fid and shows loading meanwhile", async () => {
    mockGetUserProfile.mockResolvedValue({ user: { ...ALICE, extra: 1 } });
    const { result } = renderHook(() => useDraftRecipient(42));
    expect(result.current).toEqual({ recipient: null, isLoading: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.recipient).toEqual(ALICE);
    expect(mockGetUserProfile).toHaveBeenCalledWith(42);
  });

  it("uses an in-app remembered profile without a request", () => {
    rememberDraftRecipient(ALICE);
    const { result } = renderHook(() => useDraftRecipient(42));
    expect(result.current).toEqual({ recipient: ALICE, isLoading: false });
    expect(mockGetUserProfile).not.toHaveBeenCalled();
  });

  it("rejects a profile response for a different fid", async () => {
    mockGetUserProfile.mockResolvedValue({ user: { ...ALICE, fid: 7 } });
    const { result } = renderHook(() => useDraftRecipient(42));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.recipient).toBeNull();
  });

  it("stops loading when the fetch fails", async () => {
    mockGetUserProfile.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useDraftRecipient(42));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.recipient).toBeNull();
  });

  it("does nothing without a fid", () => {
    const { result } = renderHook(() => useDraftRecipient(null));
    expect(result.current).toEqual({ recipient: null, isLoading: false });
    expect(mockGetUserProfile).not.toHaveBeenCalled();
  });
});
