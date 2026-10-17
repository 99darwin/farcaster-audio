"use client";

/**
 * Space session store for the Juke web app (`juke.audio/app`).
 *
 * Ported from `farcaster-audio/stores/spaceStore.ts` and adapted for the
 * browser. This is the single source of truth for the *active* space session:
 * the LiveKit-backed participant list, mute/hand/recording flags, the ephemeral
 * reaction buffer, and the connection lifecycle.
 *
 * The store — not the `useSpace` hook — owns the mute/leave actions so the
 * persistent `SpaceMiniBar` (Stream B) can drive them without mounting the full
 * space screen. Because zustand stores are module singletons, the session
 * survives route changes: navigating away from `/app/space/[id]` keeps the
 * LiveKit room connected (see `lib/space/livekit.ts` singletons) and the
 * mini-bar visible.
 *
 * Stream E (host/create) imports `useSpaceStore` for role/recording state and
 * the room reference. Do NOT rename the exported surface.
 */

import { create } from "zustand";
import type { Space } from "@/lib/spaces";
import { getUser } from "@/lib/auth/session";
import * as livekit from "@/lib/space/livekit";
import * as audioMixer from "@/lib/space/audioMixer";
import type { AudioSource } from "@/lib/space/audioMixer";
import { leaveRoom as leaveRoomApi } from "@/lib/space/spaceApi";

export type SpaceRole = "host" | "co_host" | "speaker" | "listener";

/**
 * The active room. Extends the canonical `Space` with the two optional
 * Farcaster-native discriminators the web app only *reads* (Phase 1 does not
 * support participating in native rooms — see the space screen's guard).
 */
export type SpaceRoom = Space & {
  is_farcaster_native?: boolean;
  farcaster_room_id?: string | null;
};

/**
 * Participant as tracked in the live session. Superset of the wire
 * `SpaceParticipant` (`@/lib/spaces`) with the client-only `is_speaking` flag
 * driven by LiveKit's `ActiveSpeakersChanged`.
 */
export interface SessionParticipant {
  fid: number;
  role: SpaceRole;
  is_muted: boolean;
  is_speaking: boolean;
  hand_raised: boolean;
  display_name: string;
  pfp_url: string | null;
}

export interface ReactionBubble {
  key: string;
  id: number;
  fid: number;
}

/**
 * A pending stage invite on a Farcaster-native room: the host promoted this
 * listener to speaker and we're waiting on their accept/decline. Juke-only
 * users don't get Farcaster's push, so the space screen polls the upstream
 * participant list and surfaces this banner when our own invite appears.
 */
export interface PendingStageInvite {
  inviterFid: number | null;
  inviterDisplayName: string | null;
  inviterPfpUrl: string | null;
  role: string;
}

const MAX_REACTION_BUFFER = 20;

export interface SpaceState {
  // ---- Active session state ------------------------------------------------
  /** The active room, or null when not connected to any space. */
  room: SpaceRoom | null;
  participants: SessionParticipant[];
  handQueue: number[];
  myRole: SpaceRole | null;
  isConnected: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isRecording: boolean;
  /**
   * Set when a mic-enable attempt is rejected by the browser
   * (`NotAllowedError`). The space screen surfaces a "mic blocked, retry"
   * gesture button; the user stays a speaker (not demoted), just muted.
   */
  micPermissionDenied: boolean;
  /** Ephemeral emoji-reaction bubbles (capped ring buffer). */
  reactions: ReactionBubble[];
  /** Bumped when a new space-chat reply arrives over the LiveKit data channel. */
  chatNewReplyTick: number;
  /**
   * Set on Farcaster-native rooms when the host has invited us to the stage and
   * we haven't accepted/declined yet. Null otherwise. Juke-hosted rooms never
   * set this (they use LiveKit permission changes directly).
   */
  pendingStageInvite: PendingStageInvite | null;
  /**
   * Mirror of the audio mixer's source list (mic + external devices + captured
   * computer/tab audio) for React reactivity. The mixer module
   * (`lib/space/audioMixer.ts`) is the source of truth; this slice is kept in
   * sync via `subscribeSources`. The host-console panel reads it to render the
   * per-source channel strips.
   */
  audioSources: AudioSource[];

  // ---- Participant mutations -----------------------------------------------
  setRoom: (room: SpaceRoom) => void;
  setParticipants: (participants: SessionParticipant[]) => void;
  addParticipant: (participant: SessionParticipant) => void;
  removeParticipant: (fid: number) => void;
  updateParticipant: (fid: number, updates: Partial<SessionParticipant>) => void;
  /** Flip `is_speaking` for known participants from an active-speaker fid set. */
  setSpeakingParticipants: (speakingFids: Set<number>) => void;
  setHandQueue: (queue: number[]) => void;

  // ---- Session flags -------------------------------------------------------
  setMyRole: (role: SpaceRole) => void;
  setConnected: (connected: boolean) => void;
  setMuted: (muted: boolean) => void;
  setHandRaised: (raised: boolean) => void;
  setRecording: (recording: boolean) => void;
  setMicPermissionDenied: (denied: boolean) => void;
  setPendingStageInvite: (invite: PendingStageInvite | null) => void;
  /** Replace the mirrored audio-source list (called by the mixer subscription). */
  setAudioSources: (sources: AudioSource[]) => void;

  // ---- Reactions + chat ----------------------------------------------------
  pushReaction: (reaction: Omit<ReactionBubble, "id">) => void;
  bumpChatNewReply: () => void;

  // ---- Lifecycle -----------------------------------------------------------
  /** Seed the session from a join response (before the LiveKit connect). */
  joinSpace: (
    room: SpaceRoom,
    participants: SessionParticipant[],
    myRole: SpaceRole,
  ) => void;
  /** Toggle the local mic. Owned here so the mini-bar can call it directly. */
  toggleMute: () => Promise<void>;
  /** Leave: best-effort REST leave + LiveKit disconnect + reset. */
  leaveSpace: () => Promise<void>;
  /** Disconnect LiveKit + reset without the REST leave (host-ended rooms). */
  disconnect: () => Promise<void>;
  reset: () => void;
}

const INITIAL_SESSION = {
  room: null as SpaceRoom | null,
  participants: [] as SessionParticipant[],
  handQueue: [] as number[],
  myRole: null as SpaceRole | null,
  isConnected: false,
  isMuted: true,
  isHandRaised: false,
  isRecording: false,
  micPermissionDenied: false,
  reactions: [] as ReactionBubble[],
  chatNewReplyTick: 0,
  pendingStageInvite: null as PendingStageInvite | null,
  audioSources: [] as AudioSource[],
};

let reactionIdSeq = 0;

export const useSpaceStore = create<SpaceState>((set, get) => ({
  ...INITIAL_SESSION,

  // ---- Participant mutations ----
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

  // ---- Session flags ----
  setMyRole: (myRole) => set({ myRole }),
  setConnected: (isConnected) => set({ isConnected }),
  setMuted: (isMuted) => set({ isMuted }),
  setHandRaised: (isHandRaised) => set({ isHandRaised }),
  setMicPermissionDenied: (micPermissionDenied) => set({ micPermissionDenied }),
  setPendingStageInvite: (pendingStageInvite) => set({ pendingStageInvite }),
  setAudioSources: (audioSources) => set({ audioSources }),
  setRecording: (isRecording) =>
    set((state) => ({
      isRecording,
      room: state.room ? { ...state.room, recording: isRecording } : state.room,
    })),

  // ---- Reactions + chat ----
  pushReaction: (reaction) =>
    set((state) => {
      reactionIdSeq += 1;
      return {
        reactions: [
          ...state.reactions.slice(-(MAX_REACTION_BUFFER - 1)),
          { ...reaction, id: reactionIdSeq },
        ],
      };
    }),

  bumpChatNewReply: () =>
    set((state) => ({ chatNewReplyTick: state.chatNewReplyTick + 1 })),

  // ---- Lifecycle ----
  joinSpace: (room, participants, myRole) => {
    // (Re)attach the mixer subscription — `teardown()` on the previous leave
    // clears all mixer subscribers, so a fresh session must re-subscribe.
    subscribeToMixer();
    set({
      room,
      participants,
      myRole,
      isConnected: true,
      isMuted: myRole === "listener",
      isHandRaised: false,
      handQueue: [],
      isRecording: room.recording ?? false,
      micPermissionDenied: false,
      reactions: [],
      pendingStageInvite: null,
      audioSources: [],
    });
  },

  toggleMute: async () => {
    try {
      const isMuted = await livekit.toggleMicrophone();
      set({ isMuted, micPermissionDenied: false });
      const myFid = getUser()?.fid;
      if (myFid) get().updateParticipant(myFid, { is_muted: isMuted });
    } catch (err) {
      // First unmute triggers the browser mic prompt; a denial must not
      // demote the speaker — keep them muted and surface the retry affordance.
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        set({ micPermissionDenied: true, isMuted: true });
        return;
      }
      throw err;
    }
  },

  leaveSpace: async () => {
    const { room } = get();
    // Juke-hosted rooms need an explicit REST leave; native rooms treat a
    // LiveKit disconnect as the leave (and aren't participable on web anyway).
    if (room && !room.is_farcaster_native) {
      try {
        await leaveRoomApi(room.id);
      } catch {
        // Best-effort — a flaky leave shouldn't strand the local session.
      }
    }
    try {
      await livekit.disconnectFromRoom();
    } catch {
      // Ignore — we always fall through to a local reset.
    }
    set({ ...INITIAL_SESSION });
  },

  disconnect: async () => {
    try {
      await livekit.disconnectFromRoom();
    } catch {
      // Ignore.
    }
    set({ ...INITIAL_SESSION });
  },

  reset: () => set({ ...INITIAL_SESSION }),
}));

/**
 * Live subscription from the audio mixer into the store. The mixer is the
 * source of truth for the source list; this pushes each add/remove/gain/mute
 * change into `audioSources` for React reactivity. Held at module scope so a
 * single subscription survives component remounts; re-established on each
 * `joinSpace` because `teardown()` clears mixer subscribers on leave.
 */
let mixerUnsub: (() => void) | null = null;

function subscribeToMixer(): void {
  // Drop any stale handle. On leave, `teardown()` clears the mixer's subscriber
  // set (so our old callback is already detached), but the handle here is still
  // dangling — release it and attach a fresh subscription for the new session.
  if (mixerUnsub) {
    mixerUnsub();
    mixerUnsub = null;
  }
  mixerUnsub = audioMixer.subscribeSources((sources) => {
    useSpaceStore.getState().setAudioSources(sources);
  });
}
