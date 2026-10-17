/**
 * Tests for the discovery feed merge logic that combines Juke-hosted
 * rooms with Farcaster-native rooms into a single ordered union.
 *
 * Invariants covered:
 *   - Live rooms (Juke "active" or Farcaster "live") sort before scheduled.
 *   - Within a bucket, newer start/scheduled time sorts first.
 *   - Empty inputs from either side collapse gracefully (the other side
 *     is still returned in order).
 *   - The `isFarcasterNative` discriminator narrows correctly.
 */

import { describe, expect, it } from "@jest/globals";

import { mergeDiscoverySpaces } from "@/hooks/mergeDiscoverySpaces";
import type { Room } from "@/types/space";
import type { FarcasterNativeSpace } from "@/services/api";

const buildJukeRoom = (overrides: Partial<Room> & Pick<Room, "id">): Room => ({
  id: overrides.id,
  title: overrides.title ?? "Juke room",
  host_fid: overrides.host_fid ?? 1,
  host: overrides.host ?? {
    fid: 1,
    username: "alice",
    display_name: "Alice",
    pfp_url: null,
    custody_address: "0x0",
    is_pro: false,
    is_admin: false,
  },
  status: overrides.status ?? "active",
  started_at: overrides.started_at ?? "2026-05-30T12:00:00.000Z",
  ended_at: overrides.ended_at ?? null,
  scheduled_at: overrides.scheduled_at ?? null,
  speaker_count: overrides.speaker_count ?? 1,
  listener_count: overrides.listener_count ?? 5,
  recording: overrides.recording ?? false,
  cast_hash: overrides.cast_hash ?? null,
});

const buildFarcasterSpace = (
  overrides: Partial<FarcasterNativeSpace> & Pick<FarcasterNativeSpace, "id">,
): FarcasterNativeSpace => ({
  id: overrides.id,
  title: overrides.title ?? "Farcaster space",
  description: overrides.description,
  host: overrides.host ?? {
    fid: 2,
    username: "bob",
    display_name: "Bob",
    pfp_url: undefined,
  },
  state: overrides.state ?? "live",
  started_at: overrides.started_at,
  scheduled_at: overrides.scheduled_at,
  ended_at: overrides.ended_at,
  listener_count: overrides.listener_count,
  channel_key: overrides.channel_key,
  root_cast_hash: overrides.root_cast_hash,
  root_cast_fid: overrides.root_cast_fid,
});

describe("mergeDiscoverySpaces", () => {
  it("places all live rooms (Juke + Farcaster) before scheduled", () => {
    const merged = mergeDiscoverySpaces({
      jukeLive: [
        buildJukeRoom({ id: "j-live", started_at: "2026-05-30T10:00:00Z" }),
      ],
      jukeScheduled: [
        buildJukeRoom({
          id: "j-sched",
          status: "scheduled",
          scheduled_at: "2026-06-01T10:00:00Z",
        }),
      ],
      farcasterLive: [
        buildFarcasterSpace({
          id: "fc-live",
          state: "live",
          started_at: "2026-05-30T11:00:00Z",
        }),
      ],
      farcasterScheduled: [
        buildFarcasterSpace({
          id: "fc-sched",
          state: "scheduled",
          scheduled_at: "2026-06-02T10:00:00Z",
        }),
      ],
    });

    expect(merged.map((s) => s.space.id)).toEqual([
      // Live first, newer started_at wins inside the bucket.
      "fc-live",
      "j-live",
      // Scheduled bucket: later scheduled_at first (desc sort).
      "fc-sched",
      "j-sched",
    ]);
  });

  it("returns only Juke rooms when Farcaster lists are empty", () => {
    const merged = mergeDiscoverySpaces({
      jukeLive: [
        buildJukeRoom({ id: "j-live-1", started_at: "2026-05-30T10:00:00Z" }),
        buildJukeRoom({ id: "j-live-2", started_at: "2026-05-30T11:00:00Z" }),
      ],
      jukeScheduled: [
        buildJukeRoom({
          id: "j-sched",
          status: "scheduled",
          scheduled_at: "2026-06-01T10:00:00Z",
        }),
      ],
      farcasterLive: [],
      farcasterScheduled: [],
    });

    expect(merged).toHaveLength(3);
    expect(merged.every((s) => s.isFarcasterNative === false)).toBe(true);
    expect(merged.map((s) => s.space.id)).toEqual([
      // Newer live first.
      "j-live-2",
      "j-live-1",
      "j-sched",
    ]);
  });

  it("returns only Farcaster rooms when Juke lists are empty", () => {
    const merged = mergeDiscoverySpaces({
      jukeLive: [],
      jukeScheduled: [],
      farcasterLive: [
        buildFarcasterSpace({
          id: "fc-live",
          state: "live",
          started_at: "2026-05-30T10:00:00Z",
        }),
      ],
      farcasterScheduled: [
        buildFarcasterSpace({
          id: "fc-sched-1",
          state: "scheduled",
          scheduled_at: "2026-06-01T10:00:00Z",
        }),
        buildFarcasterSpace({
          id: "fc-sched-2",
          state: "scheduled",
          scheduled_at: "2026-06-02T10:00:00Z",
        }),
      ],
    });

    expect(merged).toHaveLength(3);
    expect(merged.every((s) => s.isFarcasterNative === true)).toBe(true);
    expect(merged.map((s) => s.space.id)).toEqual([
      "fc-live",
      // Later scheduled_at sorts first within the bucket.
      "fc-sched-2",
      "fc-sched-1",
    ]);
  });

  it("returns an empty list when both sides are empty", () => {
    expect(
      mergeDiscoverySpaces({
        jukeLive: [],
        jukeScheduled: [],
        farcasterLive: [],
        farcasterScheduled: [],
      }),
    ).toEqual([]);
  });

  it("exposes a discriminator that narrows to the correct space shape", () => {
    const merged = mergeDiscoverySpaces({
      jukeLive: [buildJukeRoom({ id: "j-1" })],
      jukeScheduled: [],
      farcasterLive: [
        buildFarcasterSpace({ id: "fc-1", listener_count: 42, state: "live" }),
      ],
      farcasterScheduled: [],
    });

    const fids: number[] = [];
    const listenerCounts: number[] = [];

    for (const item of merged) {
      if (item.isFarcasterNative) {
        // Narrowed to FarcasterNativeSpace — listener_count is optional.
        listenerCounts.push(item.space.listener_count ?? -1);
      } else {
        // Narrowed to Room — host_fid is required, not optional.
        fids.push(item.space.host_fid);
      }
    }

    expect(fids).toEqual([1]);
    expect(listenerCounts).toEqual([42]);
  });
});
