import { beforeEach, describe, expect, it } from "@jest/globals";
import type { FarcasterNativeSpace } from "@/services/api";
import { normalizeDiscoveryLists, useSpaceStore } from "@/stores/spaceStore";
import type { Room } from "@/types/space";

function room(overrides: Partial<Room> & { id: string }): Room {
  return {
    title: "Space",
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
    status: "scheduled",
    started_at: "2026-07-10T10:00:00.000Z",
    ended_at: null,
    scheduled_at: "2099-01-01T00:00:00.000Z",
    speaker_count: 0,
    listener_count: 0,
    recording: false,
    cast_hash: null,
    ...overrides,
  };
}

function native(
  overrides: Partial<FarcasterNativeSpace> & { id: string },
): FarcasterNativeSpace {
  return { host: { fid: 2 }, state: "scheduled", ...overrides };
}

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

beforeEach(() => useSpaceStore.getState().reset());

describe("mobile discovery normalization", () => {
  it("removes past scheduled rooms from both sources", () => {
    const result = normalizeDiscoveryLists(
      {
        activeLiveSpaces: [],
        scheduledSpaces: [
          room({ id: "past", scheduled_at: "2026-07-10T11:59:59.000Z" }),
          room({ id: "future", scheduled_at: "2026-07-10T12:01:00.000Z" }),
        ],
        farcasterLiveSpaces: [],
        farcasterScheduledSpaces: [
          native({ id: "native-past", scheduled_at: "2026-07-09T12:00:00.000Z" }),
          native({ id: "native-future", scheduled_at: "2026-07-11T12:00:00.000Z" }),
        ],
      },
      NOW,
    );

    expect(result.scheduledSpaces.map((space) => space.id)).toEqual(["future"]);
    expect(result.farcasterScheduledSpaces.map((space) => space.id)).toEqual([
      "native-future",
    ]);
  });

  it("uses farcaster_room_id to dedupe without collapsing equal titles", () => {
    const result = normalizeDiscoveryLists(
      {
        activeLiveSpaces: [
          room({ id: "mirror", status: "active", farcaster_room_id: "fc-1" }),
          room({ id: "other", status: "active", title: "Space" }),
        ],
        scheduledSpaces: [],
        farcasterLiveSpaces: [native({ id: "fc-1", state: "live" })],
        farcasterScheduledSpaces: [],
      },
      NOW,
    );

    expect(result.activeLiveSpaces.map((space) => space.id)).toEqual([
      "mirror",
      "other",
    ]);
    expect(result.farcasterLiveSpaces).toEqual([]);
  });

  it("gives authoritative live state priority over a stale scheduled mirror", () => {
    const result = normalizeDiscoveryLists(
      {
        activeLiveSpaces: [],
        scheduledSpaces: [room({ id: "mirror", farcaster_room_id: "fc-live" })],
        farcasterLiveSpaces: [native({ id: "fc-live", state: "live" })],
        farcasterScheduledSpaces: [native({ id: "fc-live" })],
      },
      NOW,
    );

    expect(result.farcasterLiveSpaces.map((space) => space.id)).toEqual(["fc-live"]);
    expect(result.scheduledSpaces).toEqual([]);
    expect(result.farcasterScheduledSpaces).toEqual([]);
  });

  it("keeps dedupe invariants across sequential realtime-style writes", () => {
    useSpaceStore.getState().setScheduledSpaces([
      room({ id: "mirror", farcaster_room_id: "fc-live" }),
    ]);
    useSpaceStore.getState().setFarcasterLiveSpaces([
      native({ id: "fc-live", state: "live" }),
    ]);

    const state = useSpaceStore.getState();
    expect(state.farcasterLiveSpaces.map((space) => space.id)).toEqual(["fc-live"]);
    expect(state.scheduledSpaces).toEqual([]);
  });
});
