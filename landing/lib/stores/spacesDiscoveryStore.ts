"use client";

/**
 * Real-time spaces-discovery store for the Juke web app.
 *
 * Holds the four raw discovery lists (Juke-hosted + Farcaster-native, live +
 * scheduled) plus hydration/connection flags. Follows the `feedStore.ts`
 * conventions (an `INITIAL` const + `reset()`), and keeps all live-update
 * plumbing (single-flight refresh, WS subscription, polling fallback, refcount)
 * at module scope so a single socket + timer is shared across every consumer.
 *
 * The `SpacesPanel` reads merged/derived slices via `useSpacesDiscovery`; this
 * store only owns raw state + the optimistic RSVP mutation.
 */

import { create } from "zustand";
import { getActiveSpaces, getScheduledSpaces, rsvpRoom, unrsvpRoom } from "@/lib/api/rooms";
import { subscribeToRoomEvents } from "@/lib/api/events";
import {
  fetchLiveFarcasterSpaces,
  fetchScheduledFarcasterSpaces,
  type FarcasterNativeSpace,
  type RsvpSummary,
  type Space,
} from "@/lib/spaces";
import { getUser } from "@/lib/auth/session";

const POLL_INTERVAL_MS = 30_000;
const DISCOVERY_LIMIT = 20;

export interface DiscoveryLists {
  jukeLive: Space[];
  jukeScheduled: Space[];
  farcasterLive: FarcasterNativeSpace[];
  farcasterScheduled: FarcasterNativeSpace[];
}

function isPastScheduled(
  value: string | null | undefined,
  nowMs: number,
): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const identity = key(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** Enforce live/upcoming and canonical-id invariants on one atomic snapshot. */
export function normalizeDiscoveryLists(
  lists: DiscoveryLists,
  nowMs = Date.now(),
): DiscoveryLists {
  const jukeLive = uniqueBy(
    lists.jukeLive.filter((room) => room.status === "active"),
    (room) =>
      room.farcaster_room_id
        ? `fc:${room.farcaster_room_id}`
        : `juke:${room.id}`,
  );
  const mirroredLiveIds = new Set(
    jukeLive.flatMap((room) =>
      room.farcaster_room_id ? [room.farcaster_room_id] : [],
    ),
  );
  const farcasterLive = uniqueBy(
    lists.farcasterLive.filter(
      (space) => space.state === "live" && !mirroredLiveIds.has(space.id),
    ),
    (space) => space.id,
  );
  const liveNativeIds = new Set([
    ...mirroredLiveIds,
    ...farcasterLive.map((space) => space.id),
  ]);
  const jukeScheduled = uniqueBy(
    lists.jukeScheduled.filter(
      (room) =>
        room.status === "scheduled" &&
        !isPastScheduled(room.scheduled_at, nowMs) &&
        !(room.farcaster_room_id && liveNativeIds.has(room.farcaster_room_id)),
    ),
    (room) =>
      room.farcaster_room_id
        ? `fc:${room.farcaster_room_id}`
        : `juke:${room.id}`,
  );
  const mirroredScheduledIds = new Set(
    jukeScheduled.flatMap((room) =>
      room.farcaster_room_id ? [room.farcaster_room_id] : [],
    ),
  );
  const farcasterScheduled = uniqueBy(
    lists.farcasterScheduled.filter(
      (space) =>
        space.state === "scheduled" &&
        !isPastScheduled(space.scheduled_at, nowMs) &&
        !liveNativeIds.has(space.id) &&
        !mirroredScheduledIds.has(space.id),
    ),
    (space) => space.id,
  );

  return { jukeLive, jukeScheduled, farcasterLive, farcasterScheduled };
}

interface SpacesDiscoveryStore {
  jukeLive: Space[];
  jukeScheduled: Space[];
  farcasterLive: FarcasterNativeSpace[];
  farcasterScheduled: FarcasterNativeSpace[];
  hydrated: boolean;
  wsConnected: boolean;

  /**
   * Optimistically flip the viewer's RSVP for a scheduled room, then reconcile
   * with the server. Restores the prior `rsvp_summary` and rethrows on failure.
   */
  toggleRsvp: (room: Space) => Promise<void>;
  /**
   * Optimistically remove a room from every discovery list by id. Fired the
   * instant the local user ends a space so the "Live now" rail drains without
   * waiting for the WS `room_ended` push or the 30s poll. The next refresh
   * reconciles (an ended room won't reappear).
   */
  dropRoom: (roomId: string) => void;
  reset: () => void;
}

const INITIAL = {
  jukeLive: [] as Space[],
  jukeScheduled: [] as Space[],
  farcasterLive: [] as FarcasterNativeSpace[],
  farcasterScheduled: [] as FarcasterNativeSpace[],
  hydrated: false,
  wsConnected: false,
};

/** Patch a room's `rsvp_summary` wherever it appears in the Juke lists. */
function applyRsvpSummary(roomId: string, summary: RsvpSummary | null): void {
  const patch = (list: Space[]): Space[] =>
    list.map((room) =>
      room.id === roomId ? { ...room, rsvp_summary: summary } : room,
    );
  useSpacesDiscoveryStore.setState((state) => ({
    jukeLive: patch(state.jukeLive),
    jukeScheduled: patch(state.jukeScheduled),
  }));
}

/** Remove a room id from every discovery list. Pure — returns the next state. */
function dropRoomFromLists(
  state: Pick<
    SpacesDiscoveryStore,
    "jukeLive" | "jukeScheduled" | "farcasterLive" | "farcasterScheduled"
  >,
  roomId: string,
): Pick<
  SpacesDiscoveryStore,
  "jukeLive" | "jukeScheduled" | "farcasterLive" | "farcasterScheduled"
> {
  return {
    jukeLive: state.jukeLive.filter((room) => room.id !== roomId),
    jukeScheduled: state.jukeScheduled.filter((room) => room.id !== roomId),
    farcasterLive: state.farcasterLive.filter((room) => room.id !== roomId),
    farcasterScheduled: state.farcasterScheduled.filter(
      (room) => room.id !== roomId,
    ),
  };
}

/** Compute the optimistic post-toggle summary from the current one. */
function nextRsvpSummary(current: RsvpSummary | null): RsvpSummary {
  const base = current ?? { count: 0, users: [], is_going: false };
  const going = !base.is_going;
  const viewer = getUser();

  let users = base.users;
  if (viewer) {
    if (going) {
      if (!users.some((u) => u.fid === viewer.fid)) {
        users = [
          {
            fid: viewer.fid,
            display_name: viewer.display_name,
            pfp_url: viewer.pfp_url,
          },
          ...users,
        ];
      }
    } else {
      users = users.filter((u) => u.fid !== viewer.fid);
    }
  }

  return {
    count: Math.max(0, base.count + (going ? 1 : -1)),
    users,
    is_going: going,
  };
}

export const useSpacesDiscoveryStore = create<SpacesDiscoveryStore>(() => ({
  ...INITIAL,

  toggleRsvp: async (room) => {
    const snapshot = room.rsvp_summary;
    const optimistic = nextRsvpSummary(snapshot);
    applyRsvpSummary(room.id, optimistic);

    try {
      if (optimistic.is_going) {
        await rsvpRoom(room.id);
      } else {
        await unrsvpRoom(room.id);
      }
    } catch (error) {
      applyRsvpSummary(room.id, snapshot ?? null);
      throw error;
    }
  },

  dropRoom: (roomId) =>
    useSpacesDiscoveryStore.setState((state) =>
      dropRoomFromLists(state, roomId),
    ),

  reset: () => useSpacesDiscoveryStore.setState({ ...INITIAL }),
}));

// ---------------------------------------------------------------------------
// Module-level live-update plumbing (single socket + timer for all consumers).
// ---------------------------------------------------------------------------

type RefreshScope = "all" | "natives";

let refreshInFlight: Promise<void> | null = null;

async function runRefresh(scope: RefreshScope): Promise<void> {
  const includeJuke = scope === "all";
  const current = useSpacesDiscoveryStore.getState();

  // Fetch independently, retain the previous value on a per-list failure,
  // then publish one normalized snapshot. This prevents a partial refresh or
  // websocket/poll overlap from briefly reintroducing a duplicate.
  const [jukeLive, jukeScheduled, farcasterLive, farcasterScheduled] =
    await Promise.all([
      includeJuke
        ? getActiveSpaces(undefined, DISCOVERY_LIMIT)
            .then((res) => res.rooms)
            .catch(() => current.jukeLive)
        : Promise.resolve(current.jukeLive),
      includeJuke
        ? getScheduledSpaces(undefined, DISCOVERY_LIMIT)
            .then((res) => res.rooms)
            .catch(() => current.jukeScheduled)
        : Promise.resolve(current.jukeScheduled),
      fetchLiveFarcasterSpaces(DISCOVERY_LIMIT).catch(
        () => current.farcasterLive,
      ),
      fetchScheduledFarcasterSpaces(DISCOVERY_LIMIT).catch(
        () => current.farcasterScheduled,
      ),
    ]);

  useSpacesDiscoveryStore.setState({
    ...normalizeDiscoveryLists({
      jukeLive,
      jukeScheduled,
      farcasterLive,
      farcasterScheduled,
    }),
    hydrated: true,
  });
}

/**
 * Refresh the discovery lists. Single-flight: concurrent callers share the
 * in-flight promise so a burst of WS events + a poll tick collapse to one pass.
 *
 * `scope: "natives"` skips the Juke lists (used while the WS is connected — Juke
 * rooms arrive over the socket; only Farcaster-native lists lack a push feed).
 */
export function refresh(scope: RefreshScope = "all"): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = runRefresh(scope).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

let refCount = 0;
let unsubscribeSocket: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start (or join) the shared discovery lifecycle. The first subscriber kicks
 * off an initial refresh, opens the room-events WS, and starts the 30s poll;
 * the last unsubscriber tears both down. Data is kept warm across the gap (no
 * reset) so a remount renders instantly.
 *
 * Returns an idempotent unsubscribe function.
 */
export function startSpacesDiscovery(): () => void {
  refCount += 1;

  if (refCount === 1) {
    void refresh("all");

    unsubscribeSocket = subscribeToRoomEvents({
      onRoomsChanged: () => {
        void refresh("all");
      },
      onResume: () => {
        void refresh("all");
      },
      onOpen: () => useSpacesDiscoveryStore.setState({ wsConnected: true }),
      onClose: () => useSpacesDiscoveryStore.setState({ wsConnected: false }),
    });

    pollTimer = setInterval(() => {
      // WS up → Juke rooms push over the socket, so only poll natives.
      // WS down → poll all four lists as the fallback.
      const scope: RefreshScope = useSpacesDiscoveryStore.getState().wsConnected
        ? "natives"
        : "all";
      void refresh(scope);
    }, POLL_INTERVAL_MS);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;

    if (refCount === 0) {
      unsubscribeSocket?.();
      unsubscribeSocket = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  };
}
