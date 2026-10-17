import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { renderHook, waitFor } from "@testing-library/react-native";
import { useLiveSpaces } from "@/hooks/useLiveSpaces";
import * as api from "@/services/api";
import { useSpaceStore } from "@/stores/spaceStore";
import type { Room } from "@/types/space";

class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {}
  close() {}
}

function room(id: string, status: "active" | "scheduled"): Room {
  return {
    id,
    title: id,
    host_fid: 1,
    host: {
      fid: 1,
      username: "host",
      display_name: "Host",
      pfp_url: null,
      custody_address: "0x1",
      is_pro: false,
      is_admin: false,
    },
    status,
    started_at: "2026-07-10T10:00:00.000Z",
    ended_at: null,
    scheduled_at:
      status === "scheduled" ? "2099-01-01T00:00:00.000Z" : null,
    speaker_count: 0,
    listener_count: 0,
    recording: false,
    cast_hash: null,
  };
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("useLiveSpaces refresh isolation", () => {
  it("retains a failed native list, clears a successful empty one, and keeps Juke updates", async () => {
    useSpaceStore.setState({
      farcasterLiveSpaces: [
        { id: "stale-live", host: { fid: 2 }, state: "live" },
      ],
      farcasterScheduledSpaces: [
        {
          id: "stale-scheduled",
          host: { fid: 3 },
          state: "scheduled",
          scheduled_at: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    jest.spyOn(api, "listRooms").mockImplementation(async (params) => ({
      rooms: [
        room(
          params?.status === "active" ? "fresh-live" : "fresh-scheduled",
          params?.status === "active" ? "active" : "scheduled",
        ),
      ],
      next_cursor: null,
    }));
    jest
      .spyOn(api, "fetchFarcasterNativeSpaces")
      .mockImplementation(async ({ status }) => {
        if (status === "live") throw new Error("transient upstream failure");
        return [];
      });

    const { unmount } = renderHook(() => useLiveSpaces());

    await waitFor(() => {
      expect(useSpaceStore.getState().activeLiveSpaces[0]?.id).toBe(
        "fresh-live",
      );
    });

    const state = useSpaceStore.getState();
    expect(state.scheduledSpaces[0]?.id).toBe("fresh-scheduled");
    expect(state.farcasterLiveSpaces.map((space) => space.id)).toEqual([
      "stale-live",
    ]);
    expect(state.farcasterScheduledSpaces).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch Farcaster live spaces",
    );

    unmount();
  });

  it("retains failed Juke lists without logging authenticated Axios data", async () => {
    useSpaceStore.setState({
      activeLiveSpaces: [room("stale-juke-live", "active")],
      scheduledSpaces: [room("stale-juke-scheduled", "scheduled")],
    });
    const sensitiveError = {
      message: "request failed",
      config: { headers: { Authorization: "Bearer never-log-this" } },
    };
    jest.spyOn(api, "listRooms").mockRejectedValue(sensitiveError);
    jest
      .spyOn(api, "fetchFarcasterNativeSpaces")
      .mockImplementation(async ({ status }) =>
        status === "live"
          ? [{ id: "fresh-native-live", host: { fid: 2 }, state: "live" }]
          : [
              {
                id: "fresh-native-scheduled",
                host: { fid: 3 },
                state: "scheduled",
                scheduled_at: "2099-01-01T00:00:00.000Z",
              },
            ],
      );

    const { unmount } = renderHook(() => useLiveSpaces());

    await waitFor(() => {
      expect(useSpaceStore.getState().farcasterLiveSpaces[0]?.id).toBe(
        "fresh-native-live",
      );
    });

    const state = useSpaceStore.getState();
    expect(state.activeLiveSpaces[0]?.id).toBe("stale-juke-live");
    expect(state.scheduledSpaces[0]?.id).toBe("stale-juke-scheduled");
    expect(state.farcasterScheduledSpaces[0]?.id).toBe(
      "fresh-native-scheduled",
    );
    expect(console.error).toHaveBeenCalledWith("Failed to fetch live spaces");
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch scheduled spaces",
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(
      "never-log-this",
    );

    unmount();
  });
});
