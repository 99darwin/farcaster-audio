/**
 * Pure merge/sort logic for the discovery feed.
 *
 * Combines Juke-hosted rooms (status "active" / "scheduled") with
 * Farcaster-native rooms (state "live" / "scheduled") into a single
 * discriminated-union list:
 *
 *   - Live (Juke "active" or Farcaster "live") comes first.
 *   - Within a bucket, sort by start/scheduled time descending — the
 *     most recently-started live room, or the soonest-upcoming scheduled
 *     room, surfaces first.
 *
 * Extracted from `useLiveSpaces` so it can be unit-tested in isolation.
 */

import type { DiscoverySpace } from "@/types/space";
import type { Room } from "@/types/space";
import type { FarcasterNativeSpace } from "@/services/api";

function jukeTimestamp(room: Room): number {
  // Live rooms sort by start; scheduled rooms by scheduled_at.
  const raw =
    room.status === "active"
      ? room.started_at
      : (room.scheduled_at ?? room.started_at);
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function nativeTimestamp(space: FarcasterNativeSpace): number {
  const raw =
    space.state === "live"
      ? (space.started_at ?? space.scheduled_at)
      : (space.scheduled_at ?? space.started_at);
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function isLive(item: DiscoverySpace): boolean {
  return item.isFarcasterNative
    ? item.space.state === "live"
    : item.space.status === "active";
}

function timestampOf(item: DiscoverySpace): number {
  return item.isFarcasterNative
    ? nativeTimestamp(item.space)
    : jukeTimestamp(item.space);
}

export interface MergeDiscoveryArgs {
  jukeLive: Room[];
  jukeScheduled: Room[];
  farcasterLive: FarcasterNativeSpace[];
  farcasterScheduled: FarcasterNativeSpace[];
}

/**
 * Merge the four lists into one ordered discriminated-union list.
 *
 * Ordering:
 *   1. Live before scheduled.
 *   2. Within a bucket, newest start time first.
 */
export function mergeDiscoverySpaces(
  args: MergeDiscoveryArgs,
): DiscoverySpace[] {
  const live: DiscoverySpace[] = [
    ...args.jukeLive.map<DiscoverySpace>((space) => ({
      isFarcasterNative: false,
      space,
    })),
    ...args.farcasterLive.map<DiscoverySpace>((space) => ({
      isFarcasterNative: true,
      space,
    })),
  ];

  const scheduled: DiscoverySpace[] = [
    ...args.jukeScheduled.map<DiscoverySpace>((space) => ({
      isFarcasterNative: false,
      space,
    })),
    ...args.farcasterScheduled.map<DiscoverySpace>((space) => ({
      isFarcasterNative: true,
      space,
    })),
  ];

  const byTimeDesc = (a: DiscoverySpace, b: DiscoverySpace): number =>
    timestampOf(b) - timestampOf(a);

  live.sort(byTimeDesc);
  scheduled.sort(byTimeDesc);

  return [...live, ...scheduled].sort((a, b) => {
    const aLive = isLive(a);
    const bLive = isLive(b);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return byTimeDesc(a, b);
  });
}
