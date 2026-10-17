/**
 * Store logic is exercised entirely against mocked modules — no real
 * WebSocket, timers, or network. WS behavior is validated in the browser sweep.
 */

import type { Space } from "@/lib/spaces";
import type { SubscribeOptions } from "@/lib/api/events";

jest.mock("@/lib/api/rooms", () => ({
  getActiveSpaces: jest.fn(),
  getScheduledSpaces: jest.fn(),
  rsvpRoom: jest.fn(),
  unrsvpRoom: jest.fn(),
}));

jest.mock("@/lib/api/events", () => ({
  subscribeToRoomEvents: jest.fn(),
}));

jest.mock("@/lib/spaces", () => ({
  fetchLiveFarcasterSpaces: jest.fn(),
  fetchScheduledFarcasterSpaces: jest.fn(),
}));

jest.mock("@/lib/auth/session", () => ({
  getUser: jest.fn(),
}));

import {
  getActiveSpaces,
  getScheduledSpaces,
  rsvpRoom,
  unrsvpRoom,
} from "@/lib/api/rooms";
import { subscribeToRoomEvents } from "@/lib/api/events";
import {
  fetchLiveFarcasterSpaces,
  fetchScheduledFarcasterSpaces,
} from "@/lib/spaces";
import { getUser } from "@/lib/auth/session";
import {
  normalizeDiscoveryLists,
  refresh,
  startSpacesDiscovery,
  useSpacesDiscoveryStore,
} from "@/lib/stores/spacesDiscoveryStore";

const mockGetActive = getActiveSpaces as jest.Mock;
const mockGetScheduled = getScheduledSpaces as jest.Mock;
const mockRsvp = rsvpRoom as jest.Mock;
const mockUnrsvp = unrsvpRoom as jest.Mock;
const mockLiveFc = fetchLiveFarcasterSpaces as jest.Mock;
const mockScheduledFc = fetchScheduledFarcasterSpaces as jest.Mock;
const mockGetUser = getUser as jest.Mock;
const mockSubscribe = subscribeToRoomEvents as jest.Mock;

let unsubMock: jest.Mock;
let capturedOptions: SubscribeOptions | undefined;

function jukeSpace(overrides: Partial<Space> & { id: string }): Space {
  return {
    title: "Room",
    host_fid: 1,
    host: { fid: 1, username: "host", display_name: "Host", pfp_url: null },
    status: "scheduled",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    scheduled_at: "2099-02-01T00:00:00.000Z",
    speaker_count: 0,
    listener_count: 0,
    recording: false,
    cast_hash: null,
    allow_agents: false,
    rsvp_summary: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  useSpacesDiscoveryStore.getState().reset();

  mockGetActive.mockResolvedValue({ rooms: [], next_cursor: null });
  mockGetScheduled.mockResolvedValue({ rooms: [], next_cursor: null });
  mockLiveFc.mockResolvedValue([]);
  mockScheduledFc.mockResolvedValue([]);
  mockGetUser.mockReturnValue(null);

  unsubMock = jest.fn();
  capturedOptions = undefined;
  mockSubscribe.mockImplementation((opts: SubscribeOptions) => {
    capturedOptions = opts;
    return unsubMock;
  });
});

describe("refresh (single-flight)", () => {
  it("collapses concurrent callers into one in-flight pass", async () => {
    let resolveActive!: (value: { rooms: Space[]; next_cursor: null }) => void;
    mockGetActive.mockReturnValue(
      new Promise((resolve) => {
        resolveActive = resolve;
      }),
    );

    const p1 = refresh();
    const p2 = refresh();

    expect(p1).toBe(p2);
    expect(mockGetActive).toHaveBeenCalledTimes(1);

    resolveActive({ rooms: [], next_cursor: null });
    await Promise.all([p1, p2]);

    // A later call, once settled, starts a fresh pass.
    mockGetActive.mockResolvedValue({ rooms: [], next_cursor: null });
    await refresh();
    expect(mockGetActive).toHaveBeenCalledTimes(2);
  });
});

describe("refresh (per-list error isolation)", () => {
  it("keeps stale data for a failing list and updates the rest", async () => {
    const stale = jukeSpace({ id: "stale", status: "active" });
    const fresh = jukeSpace({ id: "fresh" });
    useSpacesDiscoveryStore.setState({ jukeLive: [stale] });

    mockGetActive.mockRejectedValue(new Error("boom"));
    mockGetScheduled.mockResolvedValue({ rooms: [fresh], next_cursor: null });
    mockLiveFc.mockResolvedValue([{ id: "n1", host: { fid: 2 }, state: "live" }]);

    await refresh();

    const state = useSpacesDiscoveryStore.getState();
    expect(state.jukeLive).toEqual([stale]); // failure → stale retained
    expect(state.jukeScheduled).toEqual([fresh]);
    expect(state.farcasterLive).toHaveLength(1);
    expect(state.hydrated).toBe(true);
  });
});

describe("discovery normalization", () => {
  const NOW = Date.parse("2026-07-10T12:00:00.000Z");

  it("drops past schedules but preserves uncertain and future schedules", () => {
    const result = normalizeDiscoveryLists(
      {
        jukeLive: [],
        jukeScheduled: [
          jukeSpace({ id: "past", scheduled_at: "2026-07-10T11:59:59.000Z" }),
          jukeSpace({ id: "future", scheduled_at: "2026-07-10T12:01:00.000Z" }),
          jukeSpace({ id: "unknown", scheduled_at: null }),
        ],
        farcasterLive: [],
        farcasterScheduled: [
          { id: "native-past", host: { fid: 2 }, state: "scheduled", scheduled_at: "2026-07-10T10:00:00.000Z" },
          { id: "native-future", host: { fid: 3 }, state: "scheduled", scheduled_at: "2026-07-11T10:00:00.000Z" },
        ],
      },
      NOW,
    );

    expect(result.jukeScheduled.map((room) => room.id)).toEqual(["future", "unknown"]);
    expect(result.farcasterScheduled.map((room) => room.id)).toEqual(["native-future"]);
  });

  it("dedupes by canonical Farcaster id across live and upcoming", () => {
    const result = normalizeDiscoveryLists(
      {
        jukeLive: [],
        jukeScheduled: [
          jukeSpace({ id: "mirror", farcaster_room_id: "fc-1" }),
        ],
        farcasterLive: [
          { id: "fc-1", host: { fid: 2 }, state: "live", started_at: "2026-07-10T11:00:00.000Z" },
        ],
        farcasterScheduled: [
          { id: "fc-1", host: { fid: 2 }, state: "scheduled", scheduled_at: "2099-01-01T00:00:00.000Z" },
        ],
      },
      NOW,
    );

    expect(result.farcasterLive.map((room) => room.id)).toEqual(["fc-1"]);
    expect(result.jukeScheduled).toEqual([]);
    expect(result.farcasterScheduled).toEqual([]);
  });

  it("publishes one deduped snapshot when realtime and polling data disagree", async () => {
    mockGetScheduled.mockResolvedValue({
      rooms: [jukeSpace({ id: "mirror", farcaster_room_id: "fc-live" })],
      next_cursor: null,
    });
    mockLiveFc.mockResolvedValue([
      { id: "fc-live", host: { fid: 2 }, state: "live" },
    ]);

    await refresh();

    const state = useSpacesDiscoveryStore.getState();
    expect(state.farcasterLive.map((room) => room.id)).toEqual(["fc-live"]);
    expect(state.jukeScheduled).toEqual([]);
  });
});

describe("toggleRsvp", () => {
  it("optimistically adds the viewer, then confirms with the server", async () => {
    mockGetUser.mockReturnValue({ fid: 99, display_name: "Me", pfp_url: null });
    mockRsvp.mockResolvedValue({ status: "ok" });

    const room = jukeSpace({
      id: "r1",
      rsvp_summary: { count: 5, users: [], is_going: false },
    });
    useSpacesDiscoveryStore.setState({ jukeScheduled: [room] });

    await useSpacesDiscoveryStore.getState().toggleRsvp(room);

    const summary = useSpacesDiscoveryStore.getState().jukeScheduled[0]
      .rsvp_summary!;
    expect(summary.is_going).toBe(true);
    expect(summary.count).toBe(6);
    expect(summary.users[0].fid).toBe(99);
    expect(mockRsvp).toHaveBeenCalledWith("r1");
    expect(mockUnrsvp).not.toHaveBeenCalled();
  });

  it("reverts the optimistic change and rethrows on server failure", async () => {
    mockGetUser.mockReturnValue({ fid: 99, display_name: "Me", pfp_url: null });
    mockUnrsvp.mockRejectedValue(new Error("nope"));

    const original = {
      count: 6,
      users: [{ fid: 99, display_name: "Me", pfp_url: null }],
      is_going: true,
    };
    const room = jukeSpace({ id: "r2", rsvp_summary: original });
    useSpacesDiscoveryStore.setState({ jukeScheduled: [room] });

    await expect(
      useSpacesDiscoveryStore.getState().toggleRsvp(room),
    ).rejects.toThrow("nope");

    // Snapshot restored exactly.
    expect(
      useSpacesDiscoveryStore.getState().jukeScheduled[0].rsvp_summary,
    ).toEqual(original);
  });
});

describe("dropRoom (optimistic drain on end)", () => {
  it("removes the room id from every list, leaving the rest intact", () => {
    const live = jukeSpace({ id: "ending", status: "active" });
    const keep = jukeSpace({ id: "keep", status: "active" });
    useSpacesDiscoveryStore.setState({
      jukeLive: [live, keep],
      jukeScheduled: [jukeSpace({ id: "ending" })],
      // Native lists key on the upstream Farcaster room id.
      farcasterLive: [
        { id: "ending", host: { fid: 2 }, state: "live" },
        { id: "n-keep", host: { fid: 3 }, state: "live" },
      ] as never,
      farcasterScheduled: [],
    });

    useSpacesDiscoveryStore.getState().dropRoom("ending");

    const state = useSpacesDiscoveryStore.getState();
    expect(state.jukeLive.map((r) => r.id)).toEqual(["keep"]);
    expect(state.jukeScheduled).toEqual([]);
    expect(state.farcasterLive.map((r) => r.id)).toEqual(["n-keep"]);
  });

  it("is a no-op when the id is absent (idempotent re-drop)", () => {
    const only = jukeSpace({ id: "only", status: "active" });
    useSpacesDiscoveryStore.setState({ jukeLive: [only] });

    useSpacesDiscoveryStore.getState().dropRoom("missing");
    useSpacesDiscoveryStore.getState().dropRoom("only");
    useSpacesDiscoveryStore.getState().dropRoom("only");

    expect(useSpacesDiscoveryStore.getState().jukeLive).toEqual([]);
  });
});

describe("startSpacesDiscovery (refcount)", () => {
  it("opens one subscription and tears down on the last unsubscribe", () => {
    const stop1 = startSpacesDiscovery();
    const stop2 = startSpacesDiscovery();

    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    stop1();
    expect(unsubMock).not.toHaveBeenCalled();

    stop2();
    expect(unsubMock).toHaveBeenCalledTimes(1);

    // Idempotent: releasing again is a no-op.
    stop2();
    expect(unsubMock).toHaveBeenCalledTimes(1);
  });
});

describe("polling cadence", () => {
  it("polls all four lists when WS is down and only natives when up", async () => {
    jest.useFakeTimers();
    const stop = startSpacesDiscovery();

    // Flush the initial refresh fired on first subscribe.
    await jest.advanceTimersByTimeAsync(0);

    // --- WS down (default): a poll tick refreshes all four lists. ---
    mockGetActive.mockClear();
    mockGetScheduled.mockClear();
    mockLiveFc.mockClear();
    mockScheduledFc.mockClear();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockGetActive).toHaveBeenCalledTimes(1);
    expect(mockGetScheduled).toHaveBeenCalledTimes(1);
    expect(mockLiveFc).toHaveBeenCalledTimes(1);
    expect(mockScheduledFc).toHaveBeenCalledTimes(1);

    // --- WS up: only the Farcaster-native lists poll. ---
    capturedOptions?.onOpen?.();
    mockGetActive.mockClear();
    mockGetScheduled.mockClear();
    mockLiveFc.mockClear();
    mockScheduledFc.mockClear();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockGetActive).toHaveBeenCalledTimes(0);
    expect(mockGetScheduled).toHaveBeenCalledTimes(0);
    expect(mockLiveFc).toHaveBeenCalledTimes(1);
    expect(mockScheduledFc).toHaveBeenCalledTimes(1);

    stop();
    jest.useRealTimers();
  });
});
