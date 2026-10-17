import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  apiClient,
  fetchFarcasterNativeSpaces,
} from "@/services/api";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("fetchFarcasterNativeSpaces", () => {
  it("propagates transport failures so the caller can retain stale data", async () => {
    jest.spyOn(apiClient, "get").mockRejectedValueOnce(new Error("offline"));

    await expect(
      fetchFarcasterNativeSpaces({ status: "live", limit: 20 }),
    ).rejects.toThrow("offline");
  });

  it("returns an empty list for a successful empty response", async () => {
    jest.spyOn(apiClient, "get").mockResolvedValueOnce({ data: [] });

    await expect(
      fetchFarcasterNativeSpaces({ status: "scheduled", limit: 20 }),
    ).resolves.toEqual([]);
  });
});
