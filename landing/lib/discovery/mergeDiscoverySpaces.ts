/**
 * Pure merge/sort logic for the web discovery feed.
 *
 * Ported from `farcaster-audio/hooks/mergeDiscoverySpaces.ts`, retyped against
 * the web-app `Space` / `FarcasterNativeSpace` / `DiscoverySpace` shapes from
 * `@/lib/spaces`.
 *
 * Combines Juke-hosted rooms with Farcaster-native rooms into two ordered,
 * discriminated-union lists — `live` and `upcoming`.
 *
 * Classification is by *provenance*, not by re-reading a per-item status
 * string: anything returned by a live endpoint (`jukeLive` / `farcasterLive`)
 * is live, anything from a scheduled endpoint is upcoming. This is deliberate —
 * the Farcaster live proxy passes upstream `state` through verbatim
 * (`Literal[...] | str`), so a live room whose `state` isn't the exact literal
 * `"live"` must NOT be demoted out of "Live now".
 *
 * De-duplication: a Juke row that mirrors a Farcaster-native room carries the
 * upstream id in `farcaster_room_id`. The same room can therefore arrive twice
 * — once as a Juke mirror, once from the Farcaster list. When that happens we
 * keep the Juke mirror (it links in-app) and drop the native duplicate. Only
 * ever one side is dropped, so a room present in a single list always survives.
 *
 * Within each bucket, sort by start/scheduled time descending.
 *
 * Kept as a pure module (no React, no I/O) so it can be unit-tested in
 * isolation and reused by the discovery store + panel.
 */

import {
  asFarcasterDiscoverySpace,
  asJukeHostedDiscoverySpace,
  isStalePastScheduled,
  type DiscoverySpace,
  type FarcasterNativeSpace,
  type Space,
} from "@/lib/spaces";

function jukeTimestamp(room: Space): number {
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

/**
 * Per-item live check based on the item's own status/state string.
 *
 * NOTE: this is a convenience predicate for callers that hold a single
 * `DiscoverySpace` in isolation. The discovery merge itself classifies by
 * provenance (which list an item came from), not by this string — see the
 * module doc — so do not rely on this to bucket merged output.
 */
export function isLiveDiscoverySpace(item: DiscoverySpace): boolean {
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
  jukeLive: Space[];
  jukeScheduled: Space[];
  farcasterLive: FarcasterNativeSpace[];
  farcasterScheduled: FarcasterNativeSpace[];
}

export interface MergeDiscoveryResult {
  live: DiscoverySpace[];
  upcoming: DiscoverySpace[];
}

/** ids of Farcaster rooms already represented by a Juke mirror row. */
function jukeMirroredFarcasterIds(jukeList: Space[]): Set<string> {
  const ids = new Set<string>();
  for (const room of jukeList) {
    if (room.farcaster_room_id) ids.add(room.farcaster_room_id);
  }
  return ids;
}

/**
 * Merge the four raw lists into ordered `live` / `upcoming` buckets.
 *
 *   1. Classify by provenance (live endpoints → live, scheduled → upcoming).
 *   2. Drop stale past-dated scheduled rooms (see `isStalePastScheduled`).
 *   3. Drop native duplicates of a Juke mirror (keep the Juke row).
 *   4. Sort each bucket by time descending.
 */
export function mergeDiscoverySpaces(
  args: MergeDiscoveryArgs,
): MergeDiscoveryResult {
  // De-dupe per bucket: a native item is a duplicate only of a Juke mirror in
  // the *same* bucket. This avoids a race where a native room has gone live
  // upstream but its Juke mirror is still `scheduled` — suppressing the live
  // native against the scheduled mirror would drop it out of "Live now".
  const liveMirrored = jukeMirroredFarcasterIds(args.jukeLive);
  const scheduledMirrored = jukeMirroredFarcasterIds(args.jukeScheduled);

  const live: DiscoverySpace[] = [
    ...args.jukeLive.map(asJukeHostedDiscoverySpace),
    ...args.farcasterLive
      .filter((space) => !liveMirrored.has(space.id))
      .map(asFarcasterDiscoverySpace),
  ];

  const upcoming: DiscoverySpace[] = [
    ...args.jukeScheduled
      .filter((room) => !isStalePastScheduled(room.scheduled_at))
      .map(asJukeHostedDiscoverySpace),
    ...args.farcasterScheduled
      .filter(
        (space) =>
          !scheduledMirrored.has(space.id) &&
          !isStalePastScheduled(space.scheduled_at),
      )
      .map(asFarcasterDiscoverySpace),
  ];

  const byTimeDesc = (a: DiscoverySpace, b: DiscoverySpace): number =>
    timestampOf(b) - timestampOf(a);

  live.sort(byTimeDesc);
  upcoming.sort(byTimeDesc);

  return { live, upcoming };
}
