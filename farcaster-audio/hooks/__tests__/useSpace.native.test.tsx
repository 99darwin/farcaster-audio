/**
 * Tests for useSpace's Farcaster-native branching.
 *
 * Coverage (post native-join wiring):
 *   - Joining a native room signs a JFS bearer, calls
 *     `api.joinFarcasterNativeRoom`, connects to upstream LiveKit with
 *     the returned ws_url + token, and starts the heartbeat.
 *   - Leaving a native room skips `api.leaveRoom` (no Juke-side leave)
 *     and disconnects the LiveKit room.
 *   - Native host-only controls (raise-hand, promote, end, reactions)
 *     remain wired to the Farcaster spaces client.
 *   - Juke-hosted regression: joinRoom against a non-native room calls
 *     api.joinRoom (unchanged).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";

// ---------------------------------------------------------------------------
// Module mocks. NOTE: jest.mock() is hoisted above imports, so factories
// must be self-contained — variables they close over need a `mock` prefix.
// ---------------------------------------------------------------------------

// react-native: minimal — only NativeModules + NativeEventEmitter.
// Linking is no longer touched by the native-join path.
jest.mock("react-native", () => {
  class FakeEventEmitter {
    addListener() {
      return { remove: () => {} };
    }
  }
  return {
    NativeModules: { AudioSessionModule: null },
    NativeEventEmitter: FakeEventEmitter,
    AppState: {
      addEventListener: () => ({ remove: () => {} }),
    },
  };
});

// snapSigner: stub the JFS bearer signer so we don't need
// expo-secure-store / ed25519 plumbing in the test environment.
const mockSignFarcasterClientBearer =
  jest.fn<(fid: number) => Promise<string>>();
jest.mock("@/services/snapSigner", () => ({
  signFarcasterClientBearer: (fid: number) =>
    mockSignFarcasterClientBearer(fid),
}));

// useFarcasterAppKey: stub the approval gate so native-join tests don't
// have to drag in registerSnapSigner / useSnapSignerStatus / AppState
// plumbing. Tests that exercise the not-approved path set
// `mockEnsureApprovedResult` to `{ approved: false, approvalUrl }`.
let mockEnsureApprovedResult: {
  approved: boolean;
  approvalUrl?: string | null;
} = { approved: true };
const mockEnsureApproved = jest.fn(async () => mockEnsureApprovedResult);
jest.mock("@/hooks/useFarcasterAppKey", () => ({
  useFarcasterAppKey: () => ({
    status: "approved",
    refresh: jest.fn(),
    ensureApproved: mockEnsureApproved,
  }),
}));

// livekit-client: surface only the enums useSpace touches statically.
jest.mock("livekit-client", () => ({
  RoomEvent: {
    ActiveSpeakersChanged: "activeSpeakersChanged",
    ParticipantMetadataChanged: "participantMetadataChanged",
    ParticipantPermissionsChanged: "participantPermissionsChanged",
    DataReceived: "dataReceived",
  },
  DataPacket_Kind: { RELIABLE: 0, LOSSY: 1 },
  DisconnectReason: { SERVER_SHUTDOWN: 1, ROOM_DELETED: 2 },
}));

// livekitService: stub every call useSpace uses; capture invocations.
const mockConnectToRoom = jest.fn<
  (wsUrl: string, token: string) => Promise<unknown>
>();
const mockDisconnectFromRoom = jest.fn<() => Promise<void>>();
const mockToggleMicrophone = jest.fn<() => Promise<boolean>>();
const mockEnableMicrophone = jest.fn<() => Promise<void>>();
const mockDisableMicrophone = jest.fn<() => Promise<void>>();
const mockSendReactionLk = jest.fn<(key: string) => Promise<void>>();
const mockGetActiveRoom = jest.fn<() => unknown>();
const mockGetActiveWsUrl = jest.fn<() => string | null>();

jest.mock("@/services/livekit", () => ({
  connectToRoom: (...args: unknown[]) =>
    mockConnectToRoom(...(args as [string, string])),
  disconnectFromRoom: () => mockDisconnectFromRoom(),
  toggleMicrophone: () => mockToggleMicrophone(),
  enableMicrophone: () => mockEnableMicrophone(),
  disableMicrophone: () => mockDisableMicrophone(),
  sendReaction: (key: string) => mockSendReactionLk(key),
  getActiveRoom: () => mockGetActiveRoom(),
  getActiveWsUrl: () => mockGetActiveWsUrl(),
}));

// services/api: mock the surface useSpace touches.
const mockApiGetRoom = jest.fn<(id: string) => Promise<unknown>>();
const mockApiJoinRoom = jest.fn<(id: string) => Promise<unknown>>();
const mockApiLeaveRoom = jest.fn<(id: string) => Promise<unknown>>();
const mockApiRefreshRoomToken =
  jest.fn<(id: string) => Promise<{ livekit_token: string; expires_at: string }>>();
const mockApiPromoteParticipant =
  jest.fn<(id: string, fid: number) => Promise<unknown>>();
const mockApiDemoteParticipant =
  jest.fn<(id: string, fid: number) => Promise<unknown>>();
const mockApiEndRoom = jest.fn<(id: string) => Promise<unknown>>();
const mockApiEndFarcasterNativeRoom = jest.fn<
  (id: string, body?: { user_jfs_bearer?: string }) => Promise<unknown>
>();
const mockApiJoinFarcasterNativeRoom = jest.fn<
  (id: string, body: { user_jfs_bearer: string }) => Promise<{
    ws_url: string;
    token: string;
  }>
>();
const mockApiFetchNativeParticipants =
  jest.fn<(id: string) => Promise<unknown[]>>();
const mockApiRaiseHandFarcasterNative = jest.fn<
  (
    id: string,
    body: { user_jfs_bearer: string; raised: boolean },
  ) => Promise<unknown>
>();
const mockApiAcceptStageInviteFarcasterNative = jest.fn<
  (id: string, body: { user_jfs_bearer: string }) => Promise<unknown>
>();
const mockApiDeclineStageInviteFarcasterNative = jest.fn<
  (id: string, body: { user_jfs_bearer: string }) => Promise<unknown>
>();
const mockApiAcceptSpeakerFarcasterNative = jest.fn<
  (
    id: string,
    body: { user_jfs_bearer: string; target_fid: number },
  ) => Promise<unknown>
>();
const mockApiRemoveSpeakerFarcasterNative = jest.fn<
  (
    id: string,
    body: { user_jfs_bearer: string; target_fid: number },
  ) => Promise<unknown>
>();

jest.mock("@/services/api", () => ({
  getRoom: (id: string) => mockApiGetRoom(id),
  joinRoom: (id: string) => mockApiJoinRoom(id),
  leaveRoom: (id: string) => mockApiLeaveRoom(id),
  refreshRoomToken: (id: string) => mockApiRefreshRoomToken(id),
  promoteParticipant: (id: string, fid: number) =>
    mockApiPromoteParticipant(id, fid),
  demoteParticipant: (id: string, fid: number) =>
    mockApiDemoteParticipant(id, fid),
  endRoom: (id: string) => mockApiEndRoom(id),
  endFarcasterNativeRoom: (
    id: string,
    body?: { user_jfs_bearer?: string },
  ) => mockApiEndFarcasterNativeRoom(id, body),
  // Upstream participant list — used by joinRoom to overlay
  // display_name + pfp_url onto the LiveKit-seeded store. Default in
  // beforeEach is `[]` (no-op merge branch); tests asserting hydrate
  // behavior override.
  fetchFarcasterNativeSpaceParticipants: (id: string) =>
    mockApiFetchNativeParticipants(id),
  joinFarcasterNativeRoom: (
    id: string,
    body: { user_jfs_bearer: string },
  ) => mockApiJoinFarcasterNativeRoom(id, body),
  acceptStageInviteFarcasterNative: (
    id: string,
    body: { user_jfs_bearer: string },
  ) => mockApiAcceptStageInviteFarcasterNative(id, body),
  declineStageInviteFarcasterNative: (
    id: string,
    body: { user_jfs_bearer: string },
  ) => mockApiDeclineStageInviteFarcasterNative(id, body),
  raiseHandFarcasterNative: (
    id: string,
    body: { user_jfs_bearer: string; raised: boolean },
  ) => mockApiRaiseHandFarcasterNative(id, body),
  acceptSpeakerFarcasterNative: (
    id: string,
    body: { user_jfs_bearer: string; target_fid: number },
  ) => mockApiAcceptSpeakerFarcasterNative(id, body),
  removeSpeakerFarcasterNative: (
    id: string,
    body: { user_jfs_bearer: string; target_fid: number },
  ) => mockApiRemoveSpeakerFarcasterNative(id, body),
}));

// farcasterSpacesClient: mock every function useSpace uses.
const mockJoinAudioRoom = jest.fn<(id: string) => Promise<unknown>>();
const mockLeaveAudioRoom = jest.fn<(id: string) => Promise<void>>();
const mockHeartbeatAudioRoom =
  jest.fn<(id: string, fids: number[]) => Promise<void>>();
const mockEndAudioRoom = jest.fn<(id: string) => Promise<unknown>>();
const mockRaiseHand =
  jest.fn<(id: string, raised: boolean) => Promise<void>>();
const mockSendReactionFc =
  jest.fn<(id: string, emoji: string) => Promise<void>>();
const mockAcceptSpeaker =
  jest.fn<(id: string, fid: number) => Promise<void>>();
const mockRemoveSpeaker =
  jest.fn<(id: string, fid: number) => Promise<void>>();

jest.mock("@/services/farcasterSpacesClient", () => {
  class MockNoBearerError extends Error {
    constructor() {
      super("no bearer");
      this.name = "NoBearerError";
    }
  }
  return {
    NoBearerError: MockNoBearerError,
    FarcasterSpacesError: class extends Error {},
    fidFromIdentity: (identity: string | undefined) => {
      if (!identity) return null;
      const raw = identity.startsWith("fid:") ? identity.slice(4) : identity;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    joinAudioRoom: (id: string) => mockJoinAudioRoom(id),
    leaveAudioRoom: (id: string) => mockLeaveAudioRoom(id),
    heartbeatAudioRoom: (id: string, fids: number[]) =>
      mockHeartbeatAudioRoom(id, fids),
    endAudioRoom: (id: string) => mockEndAudioRoom(id),
    raiseHand: (id: string, raised: boolean) => mockRaiseHand(id, raised),
    sendReaction: (id: string, emoji: string) => mockSendReactionFc(id, emoji),
    acceptSpeaker: (id: string, fid: number) => mockAcceptSpeaker(id, fid),
    removeSpeaker: (id: string, fid: number) => mockRemoveSpeaker(id, fid),
  };
});

// Pull the class out for the test that needs to throw an instance.
// Late-bound via require() to avoid the hoisting / TDZ tripwire.
function getMockNoBearerError(): new () => Error {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@/services/farcasterSpacesClient") as {
    NoBearerError: new () => Error;
  };
  return mod.NoBearerError;
}

// useFarcasterSync: stub openMiniAppSync.
const mockOpenMiniAppSync = jest.fn<() => Promise<void>>();
jest.mock("@/hooks/useFarcasterSync", () => ({
  useFarcasterSync: () => ({
    enabled: false,
    fid: null,
    expiringSoon: false,
    ensureBearer: async () => null,
    openMiniAppSync: () => mockOpenMiniAppSync(),
    revoke: async () => {},
  }),
}));

// useReconnect: dependencies of useReconnect are awkward — stub.
const mockSetToken = jest.fn<
  (token: string, expiresAt?: string | null, wsUrl?: string | null) => void
>();
jest.mock("@/hooks/useReconnect", () => ({
  useReconnect: () => ({
    reconnect: async () => {},
    setToken: (...args: unknown[]) =>
      mockSetToken(
        ...(args as [string, string | null | undefined, string | null | undefined]),
      ),
    isReconnecting: false,
  }),
}));

// authStore: minimal — just enough for `user.fid` lookups.
jest.mock("@/stores/authStore", () => {
  const mockState = { user: { fid: 999, display_name: "Me" } };
  type MockState = typeof mockState;
  function mockUseAuthStore(sel?: (s: MockState) => unknown): unknown {
    return sel ? sel(mockState) : mockState;
  }
  mockUseAuthStore.getState = () => mockState;
  return { useAuthStore: mockUseAuthStore };
});

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { useSpace, AppKeyNotApprovedError } from "@/hooks/useSpace";
import { useSpaceStore } from "@/stores/spaceStore";
import type { Room as JukeRoom } from "@/types/space";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FC_ROOM_ID = "fc-room-uuid-v7";
const JUKE_ROOM_ID = "juke-room-id";

function makeNativeRoom(overrides: Partial<JukeRoom> = {}): JukeRoom {
  return {
    id: JUKE_ROOM_ID,
    title: "Native space",
    host_fid: 999,
    host: { fid: 999 } as JukeRoom["host"],
    status: "active",
    started_at: new Date().toISOString(),
    ended_at: null,
    scheduled_at: null,
    speaker_count: 1,
    listener_count: 0,
    recording: false,
    cast_hash: null,
    farcaster_room_id: FC_ROOM_ID,
    is_farcaster_native: true,
    ...overrides,
  };
}

function makeJukeRoom(): JukeRoom {
  return {
    id: JUKE_ROOM_ID,
    title: "Juke-hosted space",
    host_fid: 999,
    host: { fid: 999 } as JukeRoom["host"],
    status: "active",
    started_at: new Date().toISOString(),
    ended_at: null,
    scheduled_at: null,
    speaker_count: 1,
    listener_count: 0,
    recording: false,
    cast_hash: null,
    is_farcaster_native: false,
  };
}

function makeFakeLkRoom() {
  // Match the shape useSpace.setupRoomListeners expects: an .on(...) chain
  // taking arbitrary handlers. We don't fire any of them in these tests.
  const handlers: Record<string, ((...args: unknown[]) => void) | undefined> =
    {};
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers[event] = handler;
      return this;
    },
    handlers,
    localParticipant: {
      permissions: { canPublish: false },
    },
    // `useSpace.connect` enumerates already-connected participants on
    // join. We don't need to seed any in these tests — an empty Map
    // just exercises the no-op branch.
    remoteParticipants: new Map(),
  };
}

function resetStore() {
  useSpaceStore.getState().reset();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  resetStore();
  mockConnectToRoom.mockResolvedValue(makeFakeLkRoom());
  mockDisconnectFromRoom.mockResolvedValue(undefined);
  mockEnableMicrophone.mockResolvedValue(undefined);
  mockToggleMicrophone.mockResolvedValue(true);
  mockGetActiveRoom.mockReturnValue(null);
  mockGetActiveWsUrl.mockReturnValue(null);
  mockHeartbeatAudioRoom.mockResolvedValue(undefined);
  mockSignFarcasterClientBearer.mockResolvedValue(
    "headerB64.payloadB64.sigB64",
  );
  mockApiJoinFarcasterNativeRoom.mockResolvedValue({
    ws_url: "wss://farcaster.livekit.cloud",
    token: "fc-lk-token",
  });
  // Default: app key is approved. Per-test overrides flip this to
  // exercise the not-approved path.
  mockEnsureApprovedResult = { approved: true };
  // Default: empty upstream participant list (no-op merge). Tests
  // asserting hydrate behavior override per-test.
  mockApiFetchNativeParticipants.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSpace — Farcaster-native branching", () => {
  it("joinRoom on a native room signs a JFS bearer, calls native-join, and connects to upstream LiveKit", async () => {
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeNativeRoom(),
      participants: [],
      hand_queue: [],
    });

    const { result } = renderHook(() => useSpace());

    let returned: unknown = "untouched";
    await act(async () => {
      returned = await result.current.joinRoom(JUKE_ROOM_ID);
    });

    expect(mockApiGetRoom).toHaveBeenCalledWith(JUKE_ROOM_ID);
    expect(mockSignFarcasterClientBearer).toHaveBeenCalledWith(999);
    expect(mockApiJoinFarcasterNativeRoom).toHaveBeenCalledWith(
      JUKE_ROOM_ID,
      { user_jfs_bearer: "headerB64.payloadB64.sigB64" },
    );
    expect(mockConnectToRoom).toHaveBeenCalledWith(
      "wss://farcaster.livekit.cloud",
      "fc-lk-token",
    );
    // Juke /join is NOT called for native rooms — different infra.
    expect(mockApiJoinRoom).not.toHaveBeenCalled();
    // Heartbeat fires once immediately to mark the user present.
    expect(mockHeartbeatAudioRoom).toHaveBeenCalledWith(FC_ROOM_ID, []);
    // The hook returns null for native rooms — the caller's contract
    // is "joined-with-juke-response or null".
    expect(returned).toBeNull();
  });

  it("joinRoom hydrates display_name + pfp_url from the upstream participant list", async () => {
    // LiveKit metadata from Farcaster's upstream doesn't carry
    // display_name / pfp_url, so without the upstream overlay the
    // speakers/listeners list renders initials only.
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeNativeRoom(),
      participants: [],
      hand_queue: [],
    });
    // Use mockResolvedValue so both the hydration call AND the new
    // pending-invite poll (which also calls
    // fetchFarcasterNativeSpaceParticipants) see the same fixture.
    mockApiFetchNativeParticipants.mockResolvedValue([
      {
        user: {
          fid: 4242,
          username: "bob",
          display_name: "Bob the Host",
          pfp_url: "https://example.com/bob.png",
        },
        role: "host",
        hand_raised: false,
      },
      {
        user: {
          fid: 7000,
          username: "carol",
          display_name: "Carol",
          pfp_url: "https://example.com/carol.png",
        },
        role: "listener",
        hand_raised: true,
      },
    ]);

    const { result } = renderHook(() => useSpace());
    await act(async () => {
      await result.current.joinRoom(JUKE_ROOM_ID);
    });
    // Drain the .then() callback inside joinRoom that runs the merge.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const participants = useSpaceStore.getState().participants;
    const bob = participants.find((p) => p.fid === 4242);
    expect(bob).toBeDefined();
    expect(bob?.display_name).toBe("Bob the Host");
    expect(bob?.pfp_url).toBe("https://example.com/bob.png");
    expect(bob?.role).toBe("host");

    const carol = participants.find((p) => p.fid === 7000);
    expect(carol).toBeDefined();
    expect(carol?.display_name).toBe("Carol");
    expect(carol?.pfp_url).toBe("https://example.com/carol.png");
    expect(carol?.role).toBe("listener");
    expect(carol?.hand_raised).toBe(true);
  });

  it("pending stage invite surfaces from the participants poll and accept dispatches the JFS-bearer endpoint", async () => {
    // The local user (fid=999) shows up in the upstream participants
    // list with a pending_invite — that's the signal we'd otherwise
    // get from a Farcaster-app push notification.
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeNativeRoom(),
      participants: [],
      hand_queue: [],
    });
    mockApiFetchNativeParticipants.mockResolvedValue([
      {
        user: { fid: 999, username: "me" },
        role: "listener",
        pending_invite: { role: "speaker_invited", inviter_fid: 4242 },
      },
      {
        user: {
          fid: 4242,
          username: "bob",
          display_name: "Bob the Host",
          pfp_url: "https://example.com/bob.png",
        },
        role: "host",
      },
    ]);
    mockApiAcceptStageInviteFarcasterNative.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSpace());
    await act(async () => {
      await result.current.joinRoom(JUKE_ROOM_ID);
    });
    // Drain microtasks so the poll's first tick resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.pendingStageInvite).toEqual({
      inviterFid: 4242,
      inviterDisplayName: "Bob the Host",
      inviterPfpUrl: "https://example.com/bob.png",
      role: "speaker_invited",
    });

    // Accept dispatches the JFS-bearer endpoint and clears the local
    // banner immediately (LiveKit will flip the role/mic via the
    // permissions-changed handler).
    await act(async () => {
      await result.current.acceptStageInvite();
    });
    expect(mockApiAcceptStageInviteFarcasterNative).toHaveBeenCalledWith(
      JUKE_ROOM_ID,
      expect.objectContaining({ user_jfs_bearer: expect.any(String) }),
    );
    expect(result.current.pendingStageInvite).toBeNull();
  });

  it("ActiveSpeakersChanged self-heals a ghost speaker (LiveKit silent reconnect)", async () => {
    // Repro: a remote speaker disconnects from upstream LiveKit (we
    // remove them from the store), then silently re-subscribes — no
    // fresh `participantConnected` event. Their audio flows but they
    // never reappear in the speakers list. The
    // `ActiveSpeakersChanged` handler should notice the unknown fid
    // and add them defensively.
    const fakeLk = makeFakeLkRoom();
    mockConnectToRoom.mockResolvedValueOnce(fakeLk);
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeNativeRoom(),
      participants: [],
      hand_queue: [],
    });

    const { result } = renderHook(() => useSpace());
    await act(async () => {
      await result.current.joinRoom(JUKE_ROOM_ID);
    });

    // After join, the local participant + any LK-seeded participants
    // are in the store. The ghost speaker (fid=4242) is NOT.
    const beforeFids = useSpaceStore
      .getState()
      .participants.map((p) => p.fid);
    expect(beforeFids).not.toContain(4242);

    // Simulate LiveKit firing ActiveSpeakersChanged with a phantom
    // remote speaker. Identity is the Farcaster-native `fid:<n>` form.
    const phantomParticipant = {
      identity: "fid:4242",
      name: "PhantomSpeaker",
      metadata: JSON.stringify({
        display_name: "Phantom",
        pfp_url: "https://example.com/phantom.png",
      }),
    } as unknown as never;
    await act(async () => {
      fakeLk.handlers.activeSpeakersChanged?.([phantomParticipant]);
    });

    const after = useSpaceStore.getState().participants;
    const phantom = after.find((p) => p.fid === 4242);
    expect(phantom).toBeDefined();
    expect(phantom?.is_speaking).toBe(true);
    // Default role is "speaker" when no metadata.role — we know they're
    // a speaker because they're actively speaking.
    expect(phantom?.role).toBe("speaker");
    expect(phantom?.display_name).toBe("Phantom");
    expect(phantom?.pfp_url).toBe("https://example.com/phantom.png");
  });

  it("joinRoom throws AppKeyNotApprovedError when the user's app key isn't approved yet", async () => {
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeNativeRoom(),
      participants: [],
      hand_queue: [],
    });
    mockEnsureApprovedResult = {
      approved: false,
      approvalUrl: "https://farcaster.xyz/~/connect?token=abc",
    };

    const { result } = renderHook(() => useSpace());

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.joinRoom(JUKE_ROOM_ID);
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(AppKeyNotApprovedError);
    expect((caught as AppKeyNotApprovedError).approvalUrl).toBe(
      "https://farcaster.xyz/~/connect?token=abc",
    );
    // We bail before signing the bearer or hitting native-join — the
    // user needs to approve first.
    expect(mockSignFarcasterClientBearer).not.toHaveBeenCalled();
    expect(mockApiJoinFarcasterNativeRoom).not.toHaveBeenCalled();
    expect(mockConnectToRoom).not.toHaveBeenCalled();
  });

  it("native-join host role auto-enables the microphone", async () => {
    // Host: room.host_fid === user.fid. useSpace.connect auto-enables
    // mic for hosts.
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeNativeRoom({ host_fid: 999 }),
      participants: [],
      hand_queue: [],
    });

    const { result } = renderHook(() => useSpace());
    await act(async () => {
      await result.current.joinRoom(JUKE_ROOM_ID);
    });

    expect(mockEnableMicrophone).toHaveBeenCalled();
  });

  it("native-join listener role does NOT auto-enable the microphone", async () => {
    // Listener: room.host_fid !== user.fid.
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeNativeRoom({ host_fid: 1 }),
      participants: [],
      hand_queue: [],
    });

    const { result } = renderHook(() => useSpace());
    await act(async () => {
      await result.current.joinRoom(JUKE_ROOM_ID);
    });

    expect(mockEnableMicrophone).not.toHaveBeenCalled();
  });

  it("leaveRoom on a native room is a no-op against the upstream (no Juke leave)", async () => {
    // Seed the store as if the user somehow has a native room in
    // store (in practice they don't — join deep-links out — but the
    // method must not blow up if called).
    useSpaceStore.getState().joinSpace(makeNativeRoom(), [], "listener");

    const { result } = renderHook(() => useSpace());
    mockLeaveAudioRoom.mockResolvedValue(undefined);

    await act(async () => {
      await result.current.leaveRoom(JUKE_ROOM_ID);
    });

    // The Juke /leave endpoint must not be called for native rooms.
    expect(mockApiLeaveRoom).not.toHaveBeenCalled();
    // We still disconnect any in-flight LiveKit room (defensive — the
    // store can carry a stale connection).
    expect(mockDisconnectFromRoom).toHaveBeenCalled();
  });

  it("toggleRaiseHand on a native room signs a JFS bearer and POSTs to Juke's native-raise-hand endpoint", async () => {
    const room = makeNativeRoom();
    useSpaceStore.getState().joinSpace(room, [], "listener");
    mockApiRaiseHandFarcasterNative.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSpace());

    await act(async () => {
      await result.current.toggleRaiseHand();
    });

    // Signs a fresh bearer for the local user's fid.
    expect(mockSignFarcasterClientBearer).toHaveBeenCalledWith(999);
    // Posts to /v1/rooms/{juke_id}/native-raise-hand (NOT the dead
    // Mini-App custody path).
    expect(mockApiRaiseHandFarcasterNative).toHaveBeenCalledWith(room.id, {
      user_jfs_bearer: expect.any(String),
      raised: true,
    });
    // The dead farcasterSpacesClient.raiseHand MUST NOT be called.
    expect(mockRaiseHand).not.toHaveBeenCalled();
    expect(useSpaceStore.getState().isHandRaised).toBe(true);
  });

  it("promoteParticipant on a native room signs a JFS bearer and POSTs to native-accept-speaker", async () => {
    const room = makeNativeRoom();
    useSpaceStore.getState().joinSpace(room, [], "host");
    mockApiAcceptSpeakerFarcasterNative.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSpace());

    await act(async () => {
      await result.current.promoteParticipant(42);
    });

    expect(mockSignFarcasterClientBearer).toHaveBeenCalledWith(999);
    expect(mockApiAcceptSpeakerFarcasterNative).toHaveBeenCalledWith(room.id, {
      user_jfs_bearer: expect.any(String),
      target_fid: 42,
    });
    expect(mockAcceptSpeaker).not.toHaveBeenCalled();
    expect(mockApiPromoteParticipant).not.toHaveBeenCalled();
  });

  it("demoteParticipant on a native room signs a JFS bearer and POSTs to native-remove-speaker", async () => {
    const room = makeNativeRoom();
    useSpaceStore.getState().joinSpace(room, [], "host");
    mockApiRemoveSpeakerFarcasterNative.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSpace());

    await act(async () => {
      await result.current.demoteParticipant(42);
    });

    expect(mockSignFarcasterClientBearer).toHaveBeenCalledWith(999);
    expect(mockApiRemoveSpeakerFarcasterNative).toHaveBeenCalledWith(room.id, {
      user_jfs_bearer: expect.any(String),
      target_fid: 42,
    });
    expect(mockRemoveSpeaker).not.toHaveBeenCalled();
    expect(mockApiDemoteParticipant).not.toHaveBeenCalled();
  });

  it("endRoom on a native room calls Juke's endFarcasterNativeRoom (NOT Juke DELETE, NOT the dead Mini-App path)", async () => {
    const room = makeNativeRoom();
    useSpaceStore.getState().joinSpace(room, [], "host");
    mockApiEndFarcasterNativeRoom.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSpace());

    await act(async () => {
      await result.current.endRoom();
    });

    expect(mockApiEndFarcasterNativeRoom).toHaveBeenCalledWith(
      room.id,
      expect.objectContaining({ user_jfs_bearer: expect.any(String) }),
    );
    expect(mockEndAudioRoom).not.toHaveBeenCalled();
    expect(mockApiEndRoom).not.toHaveBeenCalled();
    expect(mockDisconnectFromRoom).toHaveBeenCalled();
  });

  it("sendReaction on a native room hits both LiveKit and the Farcaster HTTP endpoint", async () => {
    useSpaceStore.getState().joinSpace(makeNativeRoom(), [], "speaker");
    mockSendReactionLk.mockResolvedValue(undefined);
    mockSendReactionFc.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSpace());

    await act(async () => {
      await result.current.sendReaction("heart");
    });

    expect(mockSendReactionLk).toHaveBeenCalledWith("heart");
    expect(mockSendReactionFc).toHaveBeenCalledWith(FC_ROOM_ID, "heart");
  });
});

describe("useSpace — Juke-hosted regression", () => {
  it("joinRoom on a Juke-hosted room calls api.joinRoom and skips farcasterSpacesClient", async () => {
    mockApiGetRoom.mockResolvedValueOnce({
      room: makeJukeRoom(),
      participants: [],
      hand_queue: [],
    });
    mockApiJoinRoom.mockResolvedValueOnce({
      livekit_token: "juke-token",
      livekit_ws_url: "wss://juke.livekit.cloud",
      expires_at: null,
      role: "listener" as const,
      room: makeJukeRoom(),
      participants: [],
    });

    const { result } = renderHook(() => useSpace());

    await act(async () => {
      await result.current.joinRoom(JUKE_ROOM_ID);
    });

    expect(mockApiJoinRoom).toHaveBeenCalledWith(JUKE_ROOM_ID);
    expect(mockJoinAudioRoom).not.toHaveBeenCalled();
    expect(mockConnectToRoom).toHaveBeenCalledWith(
      "wss://juke.livekit.cloud",
      "juke-token",
    );
    // No heartbeat for Juke rooms.
    expect(mockHeartbeatAudioRoom).not.toHaveBeenCalled();
  });

  it("leaveRoom on a Juke-hosted room calls api.leaveRoom and skips farcasterSpacesClient", async () => {
    useSpaceStore.getState().joinSpace(makeJukeRoom(), [], "listener");
    mockApiLeaveRoom.mockResolvedValue({ status: "ok" });

    const { result } = renderHook(() => useSpace());

    await act(async () => {
      await result.current.leaveRoom(JUKE_ROOM_ID);
    });

    expect(mockApiLeaveRoom).toHaveBeenCalledWith(JUKE_ROOM_ID);
    expect(mockLeaveAudioRoom).not.toHaveBeenCalled();
  });
});
