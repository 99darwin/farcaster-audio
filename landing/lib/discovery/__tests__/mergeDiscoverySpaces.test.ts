import {
  isLiveDiscoverySpace,
  mergeDiscoverySpaces,
} from "@/lib/discovery/mergeDiscoverySpaces";
import type { FarcasterNativeSpace, Space } from "@/lib/spaces";

function jukeSpace(overrides: Partial<Space> & { id: string }): Space {
  return {
    title: "Juke room",
    host_fid: 1,
    host: { fid: 1, username: "host", display_name: "Host", pfp_url: null },
    status: "active",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    scheduled_at: null,
    speaker_count: 1,
    listener_count: 0,
    recording: false,
    cast_hash: null,
    allow_agents: false,
    rsvp_summary: null,
    ...overrides,
  };
}

function nativeSpace(
  overrides: Partial<FarcasterNativeSpace> & { id: string },
): FarcasterNativeSpace {
  return {
    title: "Native room",
    host: { fid: 2 },
    state: "live",
    ...overrides,
  };
}

// A fixed "future" and "past" relative to Date.now() so scheduled-filter tests
// are stable regardless of when they run.
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const LONG_PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

describe("mergeDiscoverySpaces", () => {
  it("classifies by provenance: live-endpoint items are always live", () => {
    const { live, upcoming } = mergeDiscoverySpaces({
      jukeLive: [jukeSpace({ id: "j-live", status: "active" })],
      jukeScheduled: [
        jukeSpace({ id: "j-sched", status: "scheduled", scheduled_at: FUTURE }),
      ],
      farcasterLive: [nativeSpace({ id: "f-live", state: "live" })],
      farcasterScheduled: [
        nativeSpace({ id: "f-sched", state: "scheduled", scheduled_at: FUTURE }),
      ],
    });

    expect(live.map((s) => s.space.id).sort()).toEqual(["f-live", "j-live"]);
    expect(upcoming.map((s) => s.space.id).sort()).toEqual([
      "f-sched",
      "j-sched",
    ]);
  });

  it("keeps a live native room whose state string isn't the literal 'live'", () => {
    // The Farcaster live proxy passes upstream `state` through verbatim; an
    // unexpected value must NOT demote the room out of Live now.
    const { live, upcoming } = mergeDiscoverySpaces({
      jukeLive: [],
      jukeScheduled: [],
      farcasterLive: [
        nativeSpace({ id: "weird", state: "LIVE" as unknown as "live" }),
      ],
      farcasterScheduled: [],
    });

    expect(live.map((s) => s.space.id)).toEqual(["weird"]);
    expect(upcoming).toHaveLength(0);
  });

  it("orders live spaces by start time descending", () => {
    const { live } = mergeDiscoverySpaces({
      jukeLive: [
        jukeSpace({ id: "older", started_at: "2026-01-01T00:00:00.000Z" }),
        jukeSpace({ id: "newer", started_at: "2026-01-05T00:00:00.000Z" }),
      ],
      jukeScheduled: [],
      farcasterLive: [
        nativeSpace({
          id: "mid",
          state: "live",
          started_at: "2026-01-03T00:00:00.000Z",
        }),
      ],
      farcasterScheduled: [],
    });

    expect(live.map((s) => s.space.id)).toEqual(["newer", "mid", "older"]);
  });

  it("orders upcoming spaces by scheduled time descending", () => {
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
    const { upcoming } = mergeDiscoverySpaces({
      jukeLive: [],
      jukeScheduled: [
        jukeSpace({ id: "soon", status: "scheduled", scheduled_at: soon }),
        jukeSpace({ id: "later", status: "scheduled", scheduled_at: later }),
      ],
      farcasterLive: [],
      farcasterScheduled: [],
    });

    expect(upcoming.map((s) => s.space.id)).toEqual(["later", "soon"]);
  });

  it("drops long-past scheduled rooms from upcoming", () => {
    const { upcoming } = mergeDiscoverySpaces({
      jukeLive: [],
      jukeScheduled: [
        jukeSpace({ id: "stale-juke", status: "scheduled", scheduled_at: LONG_PAST }),
        jukeSpace({ id: "future-juke", status: "scheduled", scheduled_at: FUTURE }),
      ],
      farcasterLive: [],
      farcasterScheduled: [
        nativeSpace({ id: "stale-fc", state: "scheduled", scheduled_at: LONG_PAST }),
        nativeSpace({ id: "future-fc", state: "scheduled", scheduled_at: FUTURE }),
      ],
    });

    expect(upcoming.map((s) => s.space.id).sort()).toEqual([
      "future-fc",
      "future-juke",
    ]);
  });

  it("keeps scheduled rooms with a missing/unparseable start time", () => {
    const { upcoming } = mergeDiscoverySpaces({
      jukeLive: [],
      jukeScheduled: [],
      farcasterLive: [],
      farcasterScheduled: [
        nativeSpace({ id: "no-date", state: "scheduled", scheduled_at: undefined }),
      ],
    });

    expect(upcoming.map((s) => s.space.id)).toEqual(["no-date"]);
  });

  it("de-dupes a native room that also arrives as a Juke mirror (keeps Juke)", () => {
    const { live } = mergeDiscoverySpaces({
      jukeLive: [
        jukeSpace({
          id: "juke-uuid",
          status: "active",
          is_farcaster_native: true,
          farcaster_room_id: "fc-123",
        }),
      ],
      jukeScheduled: [],
      farcasterLive: [nativeSpace({ id: "fc-123", state: "live" })],
      farcasterScheduled: [],
    });

    // Only the Juke mirror survives; the native duplicate is dropped.
    expect(live).toHaveLength(1);
    expect(live[0].isFarcasterNative).toBe(false);
    expect(live[0].space.id).toBe("juke-uuid");
  });

  it("keeps the native room when no Juke mirror exists (never drops both)", () => {
    const { live } = mergeDiscoverySpaces({
      jukeLive: [],
      jukeScheduled: [],
      farcasterLive: [nativeSpace({ id: "fc-123", state: "live" })],
      farcasterScheduled: [],
    });

    expect(live.map((s) => s.space.id)).toEqual(["fc-123"]);
  });

  it("treats invalid/missing live timestamps as 0 without throwing", () => {
    const { live } = mergeDiscoverySpaces({
      jukeLive: [
        jukeSpace({ id: "bad", started_at: "not-a-date" }),
        jukeSpace({ id: "good", started_at: "2026-01-05T00:00:00.000Z" }),
      ],
      jukeScheduled: [],
      farcasterLive: [
        nativeSpace({ id: "no-ts", state: "live", started_at: undefined }),
      ],
      farcasterScheduled: [],
    });

    expect(live[0].space.id).toBe("good");
    expect(live).toHaveLength(3);
  });

  it("interleaves Juke and native live spaces purely by time", () => {
    const { live } = mergeDiscoverySpaces({
      jukeLive: [jukeSpace({ id: "j1", started_at: "2026-01-04T00:00:00.000Z" })],
      jukeScheduled: [],
      farcasterLive: [
        nativeSpace({
          id: "f1",
          state: "live",
          started_at: "2026-01-06T00:00:00.000Z",
        }),
        nativeSpace({
          id: "f2",
          state: "live",
          started_at: "2026-01-02T00:00:00.000Z",
        }),
      ],
      farcasterScheduled: [],
    });

    expect(live.map((s) => s.space.id)).toEqual(["f1", "j1", "f2"]);
    expect(live.map((s) => s.isFarcasterNative)).toEqual([true, false, true]);
  });

  it("isLiveDiscoverySpace still reports per-item status", () => {
    expect(
      isLiveDiscoverySpace({
        isFarcasterNative: false,
        space: jukeSpace({ id: "a", status: "active" }),
      }),
    ).toBe(true);
    expect(
      isLiveDiscoverySpace({
        isFarcasterNative: true,
        space: nativeSpace({ id: "b", state: "scheduled" }),
      }),
    ).toBe(false);
  });
});
