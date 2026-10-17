import { create } from "zustand";
import type { Room, Participant, ParticipantRole } from "@/types/space";
import type { FarcasterNativeSpace } from "@/services/api";

export interface DiscoveryLists {
  activeLiveSpaces: Room[];
  scheduledSpaces: Room[];
  farcasterLiveSpaces: FarcasterNativeSpace[];
  farcasterScheduledSpaces: FarcasterNativeSpace[];
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

/** Enforce discovery invariants across all four endpoint snapshots at once. */
export function normalizeDiscoveryLists(
  lists: DiscoveryLists,
  nowMs = Date.now(),
): DiscoveryLists {
  const activeLiveSpaces = uniqueBy(
    lists.activeLiveSpaces.filter((room) => room.status === "active"),
    (room) =>
      room.farcaster_room_id
        ? `fc:${room.farcaster_room_id}`
        : `juke:${room.id}`,
  );
  const mirroredLiveIds = new Set(
    activeLiveSpaces.flatMap((room) =>
      room.farcaster_room_id ? [room.farcaster_room_id] : [],
    ),
  );
  const farcasterLiveSpaces = uniqueBy(
    lists.farcasterLiveSpaces.filter(
      (space) => space.state === "live" && !mirroredLiveIds.has(space.id),
    ),
    (space) => space.id,
  );
  const liveNativeIds = new Set([
    ...mirroredLiveIds,
    ...farcasterLiveSpaces.map((space) => space.id),
  ]);

  const scheduledSpaces = uniqueBy(
    lists.scheduledSpaces.filter(
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
    scheduledSpaces.flatMap((room) =>
      room.farcaster_room_id ? [room.farcaster_room_id] : [],
    ),
  );
  const farcasterScheduledSpaces = uniqueBy(
    lists.farcasterScheduledSpaces.filter(
      (space) =>
        space.state === "scheduled" &&
        !isPastScheduled(space.scheduled_at, nowMs) &&
        !liveNativeIds.has(space.id) &&
        !mirroredScheduledIds.has(space.id),
    ),
    (space) => space.id,
  );

  return {
    activeLiveSpaces,
    scheduledSpaces,
    farcasterLiveSpaces,
    farcasterScheduledSpaces,
  };
}

interface SpaceStore {
  // Current active space state
  room: Room | null;
  participants: Participant[];
  handQueue: number[];
  myRole: ParticipantRole | null;
  isConnected: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isRecording: boolean;

  // Live spaces for discovery rail
  activeLiveSpaces: Room[];
  scheduledSpaces: Room[];
  // Farcaster-native (proxied) discovery — separate from Juke-hosted so
  // the UI can render them with a different tap-handler / chip.
  farcasterLiveSpaces: FarcasterNativeSpace[];
  farcasterScheduledSpaces: FarcasterNativeSpace[];

  // Actions - space state
  setRoom: (room: Room) => void;
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (fid: number) => void;
  updateParticipant: (fid: number, updates: Partial<Participant>) => void;
  setSpeakingParticipants: (speakingFids: Set<number>) => void;
  setHandQueue: (queue: number[]) => void;
  setMyRole: (role: ParticipantRole) => void;
  setConnected: (connected: boolean) => void;
  setMuted: (muted: boolean) => void;
  setHandRaised: (raised: boolean) => void;
  setRecording: (recording: boolean) => void;

  // Actions - discovery
  setActiveLiveSpaces: (spaces: Room[]) => void;
  setDiscoverySpaces: (spaces: DiscoveryLists) => void;
  addActiveLiveSpace: (room: Room) => void;
  removeActiveLiveSpace: (roomId: string) => void;
  setScheduledSpaces: (spaces: Room[]) => void;
  setFarcasterLiveSpaces: (spaces: FarcasterNativeSpace[]) => void;
  setFarcasterScheduledSpaces: (spaces: FarcasterNativeSpace[]) => void;

  // Chat — incremented when a new reply data message arrives via LiveKit
  chatNewReplyTick: number;
  bumpChatNewReply: () => void;

  // Actions - lifecycle
  joinSpace: (
    room: Room,
    participants: Participant[],
    myRole: ParticipantRole,
  ) => void;
  leaveSpace: () => void;
  reset: () => void;
}

const INITIAL_STATE = {
  room: null,
  participants: [],
  handQueue: [],
  myRole: null,
  isConnected: false,
  isMuted: true,
  isHandRaised: false,
  isRecording: false,
  chatNewReplyTick: 0,
};

export const useSpaceStore = create<SpaceStore>((set) => ({
  ...INITIAL_STATE,
  activeLiveSpaces: [],
  scheduledSpaces: [],
  farcasterLiveSpaces: [],
  farcasterScheduledSpaces: [],

  // Space state actions
  setRoom: (room) => set({ room }),
  setParticipants: (participants) => set({ participants }),

  addParticipant: (participant) =>
    set((state) => ({
      participants: [
        ...state.participants.filter((p) => p.fid !== participant.fid),
        participant,
      ],
    })),

  removeParticipant: (fid) =>
    set((state) => ({
      participants: state.participants.filter((p) => p.fid !== fid),
      handQueue: state.handQueue.filter((f) => f !== fid),
    })),

  updateParticipant: (fid, updates) =>
    set((state) => ({
      participants: state.participants.map((p) =>
        p.fid === fid ? { ...p, ...updates } : p,
      ),
    })),

  setSpeakingParticipants: (speakingFids) =>
    set((state) => {
      let changed = false;
      const participants = state.participants.map((p) => {
        const isSpeaking = speakingFids.has(p.fid);
        if (p.is_speaking === isSpeaking) return p;
        changed = true;
        return { ...p, is_speaking: isSpeaking };
      });
      return changed ? { participants } : state;
    }),

  setHandQueue: (handQueue) => set({ handQueue }),
  setMyRole: (myRole) => set({ myRole }),
  setConnected: (isConnected) => set({ isConnected }),
  setMuted: (isMuted) => set({ isMuted }),
  setHandRaised: (isHandRaised) => set({ isHandRaised }),
  setRecording: (isRecording) =>
    set((state) => ({
      isRecording,
      room: state.room ? { ...state.room, recording: isRecording } : state.room,
    })),

  // Chat
  bumpChatNewReply: () =>
    set((state) => ({ chatNewReplyTick: state.chatNewReplyTick + 1 })),

  // Discovery
  setDiscoverySpaces: (spaces) => set(normalizeDiscoveryLists(spaces)),
  setActiveLiveSpaces: (activeLiveSpaces) =>
    set((state) => normalizeDiscoveryLists({ ...state, activeLiveSpaces })),
  addActiveLiveSpace: (room) =>
    set((state) =>
      normalizeDiscoveryLists({
        ...state,
        activeLiveSpaces: [
          room,
          ...state.activeLiveSpaces.filter((r) => r.id !== room.id),
        ],
      }),
    ),
  removeActiveLiveSpace: (roomId) =>
    set((state) => ({
      activeLiveSpaces: state.activeLiveSpaces.filter((r) => r.id !== roomId),
    })),
  setScheduledSpaces: (scheduledSpaces) =>
    set((state) => normalizeDiscoveryLists({ ...state, scheduledSpaces })),
  setFarcasterLiveSpaces: (farcasterLiveSpaces) =>
    set((state) => normalizeDiscoveryLists({ ...state, farcasterLiveSpaces })),
  setFarcasterScheduledSpaces: (farcasterScheduledSpaces) =>
    set((state) =>
      normalizeDiscoveryLists({ ...state, farcasterScheduledSpaces }),
    ),

  // Lifecycle
  joinSpace: (room, participants, myRole) =>
    set({
      room,
      participants,
      myRole,
      isConnected: true,
      isMuted: myRole === "listener",
      isHandRaised: false,
      handQueue: [],
      isRecording: room.recording ?? false,
    }),

  leaveSpace: () => set(INITIAL_STATE),

  reset: () =>
    set({
      ...INITIAL_STATE,
      activeLiveSpaces: [],
      scheduledSpaces: [],
      farcasterLiveSpaces: [],
      farcasterScheduledSpaces: [],
    }),
}));
