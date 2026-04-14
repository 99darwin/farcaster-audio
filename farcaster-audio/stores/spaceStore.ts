import { create } from "zustand";
import type { Room, Participant, ParticipantRole } from "@/types/space";

interface SpaceStore {
  // Current active space state
  room: Room | null;
  participants: Participant[];
  handQueue: number[];
  myRole: ParticipantRole | null;
  isConnected: boolean;
  isMuted: boolean;
  isHandRaised: boolean;

  // Live spaces for discovery rail
  activeLiveSpaces: Room[];
  scheduledSpaces: Room[];

  // Actions - space state
  setRoom: (room: Room) => void;
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (fid: number) => void;
  updateParticipant: (fid: number, updates: Partial<Participant>) => void;
  setHandQueue: (queue: number[]) => void;
  setMyRole: (role: ParticipantRole) => void;
  setConnected: (connected: boolean) => void;
  setMuted: (muted: boolean) => void;
  setHandRaised: (raised: boolean) => void;

  // Actions - discovery
  setActiveLiveSpaces: (spaces: Room[]) => void;
  setScheduledSpaces: (spaces: Room[]) => void;

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
  chatNewReplyTick: 0,
};

export const useSpaceStore = create<SpaceStore>((set) => ({
  ...INITIAL_STATE,
  activeLiveSpaces: [],
  scheduledSpaces: [],

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

  setHandQueue: (handQueue) => set({ handQueue }),
  setMyRole: (myRole) => set({ myRole }),
  setConnected: (isConnected) => set({ isConnected }),
  setMuted: (isMuted) => set({ isMuted }),
  setHandRaised: (isHandRaised) => set({ isHandRaised }),

  // Chat
  bumpChatNewReply: () =>
    set((state) => ({ chatNewReplyTick: state.chatNewReplyTick + 1 })),

  // Discovery
  setActiveLiveSpaces: (activeLiveSpaces) => set({ activeLiveSpaces }),
  setScheduledSpaces: (scheduledSpaces) => set({ scheduledSpaces }),

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
    }),

  leaveSpace: () => set(INITIAL_STATE),

  reset: () =>
    set({ ...INITIAL_STATE, activeLiveSpaces: [], scheduledSpaces: [] }),
}));
