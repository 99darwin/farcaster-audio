"use client";

/**
 * Central web hook for the audio-space session — ported from
 * `farcaster-audio/hooks/useSpace.ts`, with ALL React-Native / Farcaster-native
 * plumbing removed (Phase 1 is Juke-hosted only). Native rooms are surfaced as
 * an "open in the app" state by the space screen and never reach `joinRoom`.
 *
 * `setupRoomListeners` (the RoomEvent wiring) is attached ONCE per LiveKit room
 * via a module-level guard, and every handler dispatches to the zustand store
 * (a module singleton) rather than React state. That is what lets the session —
 * audio, participants, active-speaker rings, mute state — survive route changes
 * and keep driving the persistent mini-bar after this hook unmounts.
 *
 * Action signatures are kept identical to the mobile hook so the native branch
 * can be re-added later without touching call sites.
 */

import { useCallback, useEffect } from "react";
import {
  RoomEvent,
  DataPacket_Kind,
  DisconnectReason,
  type Room,
  type RemoteParticipant,
  type Participant,
  type TrackPublication,
} from "livekit-client";
import {
  useSpaceStore,
  type SessionParticipant,
  type SpaceRole,
  type SpaceRoom,
} from "@/lib/space/spaceStore";
import { getJwt, getUser } from "@/lib/auth/session";
import * as livekit from "@/lib/space/livekit";
import {
  getSpaceDetail,
  joinSpaceAsListener,
  raiseHand as raiseHandApi,
  promoteParticipant as promoteParticipantApi,
  demoteParticipant as demoteParticipantApi,
  endRoom as endRoomApi,
  refreshRoomToken,
} from "@/lib/space/spaceApi";
import {
  fetchFarcasterSpaceParticipants,
  type SpaceParticipant,
  type JoinSpaceResponse,
} from "@/lib/spaces";
import {
  nativeJoin,
  nativeRaiseHand,
  nativeAcceptSpeaker,
  nativeRemoveSpeaker,
  nativeAcceptStageInvite,
  nativeDeclineStageInvite,
  nativeEnd,
} from "@/lib/native/nativeSpaceApi";
import {
  ensureAppKeyApproved,
  AppKeyNotApprovedError,
} from "@/lib/native/appKeyApproval";
import { safeImageUrl } from "@/lib/safe-url";
import { useSpacesDiscoveryStore } from "@/lib/stores/spacesDiscoveryStore";
import { useReconnect } from "./useReconnect";

// Attach listeners once per Room instance (survives hook remounts).
const WIRED_ROOMS = new WeakSet<Room>();
// Module-level so the callback survives the mounting hook unmounting.
let onRoomEndedCb: (() => void) | null = null;

const SPEAKER_ROLES: ReadonlySet<SpaceRole> = new Set<SpaceRole>([
  "host",
  "co_host",
  "speaker",
]);

function isNotAllowed(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotAllowedError";
}

/**
 * Parse a participant fid from a LiveKit identity. Handles both the Juke-hosted
 * bare fid (`"3621"`) and the Farcaster-native `"fid:<n>"` encoding — see
 * `livekit.parseParticipantFid`.
 */
const participantFid = livekit.parseParticipantFid;

interface ParticipantMetadata {
  role?: string;
  pfp_url?: string;
  display_name?: string;
}

function parseMetadata(raw: string | undefined): ParticipantMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ParticipantMetadata;
  } catch {
    return {};
  }
}

function toSessionParticipant(p: SpaceParticipant): SessionParticipant {
  return {
    fid: p.fid,
    role: p.role as SpaceRole,
    is_muted: p.is_muted,
    is_speaking: false,
    hand_raised: p.hand_raised,
    display_name: p.display_name,
    pfp_url: p.pfp_url,
  };
}

const store = () => useSpaceStore.getState();

const NATIVE_ROLE_MAP: Record<string, SpaceRole> = {
  host: "host",
  cohost: "co_host",
  co_host: "co_host",
  speaker: "speaker",
  listener: "listener",
};

/**
 * Overlay upstream Farcaster identity (display name / pfp / role) onto the
 * LiveKit-seeded participant list for a native room. LiveKit metadata from
 * Farcaster's SFU doesn't carry profile fields, and most listeners aren't
 * subscribed to LiveKit at all, so without this overlay we'd render
 * initials-only for speakers and miss listeners entirely.
 */
async function hydrateNativeParticipants(
  farcasterRoomId: string,
): Promise<void> {
  const upstream = await fetchFarcasterSpaceParticipants(farcasterRoomId);
  if (!upstream.length) return;
  const seen = new Set(store().participants.map((p) => p.fid));
  for (const p of upstream) {
    const u = p.user;
    if (!u?.fid) continue;
    const role = NATIVE_ROLE_MAP[p.role] ?? "listener";
    const displayName = u.display_name || u.username || `User ${u.fid}`;
    const safePfp = safeImageUrl(u.pfp_url);
    if (seen.has(u.fid)) {
      // Merge onto an existing LiveKit-seeded row. Guard pfp: upstream can
      // return null right after creation; don't clobber a good value.
      store().updateParticipant(u.fid, {
        role,
        display_name: displayName,
        hand_raised: !!p.hand_raised,
        ...(safePfp ? { pfp_url: safePfp } : {}),
      });
    } else {
      store().addParticipant({
        fid: u.fid,
        role,
        is_muted: role === "listener",
        is_speaking: false,
        hand_raised: !!p.hand_raised,
        display_name: displayName,
        pfp_url: safePfp,
      });
    }
  }
}

/**
 * Wire every RoomEvent → store dispatch. Idempotent per room via `WIRED_ROOMS`.
 * Handlers read/write the store singleton, so they keep working after the
 * mounting hook unmounts (mini-bar persistence).
 */
function setupRoomListeners(room: Room): void {
  if (WIRED_ROOMS.has(room)) return;
  WIRED_ROOMS.add(room);

  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    const fid = participantFid(participant.identity);
    if (fid === null) return;
    const metadata = parseMetadata(participant.metadata);
    store().addParticipant({
      fid,
      role: (metadata.role as SpaceRole) || "listener",
      is_muted: true,
      is_speaking: false,
      hand_raised: false,
      display_name: metadata.display_name || `User ${fid}`,
      pfp_url: safeImageUrl(metadata.pfp_url),
    });
  });

  room.on(
    RoomEvent.ParticipantDisconnected,
    (participant: RemoteParticipant) => {
      const fid = participantFid(participant.identity);
      if (fid !== null) store().removeParticipant(fid);
    },
  );

  room.on(
    RoomEvent.TrackMuted,
    (_pub: TrackPublication, participant: Participant) => {
      const fid = participantFid(participant.identity);
      if (fid !== null)
        store().updateParticipant(fid, { is_muted: true, is_speaking: false });
    },
  );

  room.on(
    RoomEvent.TrackUnmuted,
    (_pub: TrackPublication, participant: Participant) => {
      const fid = participantFid(participant.identity);
      if (fid !== null) store().updateParticipant(fid, { is_muted: false });
    },
  );

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    const fids: number[] = [];
    const known = new Set(store().participants.map((p) => p.fid));
    for (const p of speakers) {
      const fid = participantFid(p.identity);
      if (fid === null) continue;
      fids.push(fid);
      // Self-heal: audio is flowing for a fid we don't have — add them so
      // they stop being a ghost speaker (LiveKit silent reconnect drop).
      if (!known.has(fid)) {
        const metadata = parseMetadata(p.metadata);
        store().addParticipant({
          fid,
          role: (metadata.role as SpaceRole) || "speaker",
          is_muted: false,
          is_speaking: true,
          hand_raised: false,
          display_name: metadata.display_name || p.name || `User ${fid}`,
          pfp_url: safeImageUrl(metadata.pfp_url),
        });
        known.add(fid);
      }
    }
    store().setSpeakingParticipants(new Set(fids));
  });

  room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    store().setConnected(false);
    if (
      reason === DisconnectReason.SERVER_SHUTDOWN ||
      reason === DisconnectReason.ROOM_DELETED
    ) {
      WIRED_ROOMS.delete(room);
      void store().disconnect();
      onRoomEndedCb?.();
    }
  });

  room.on(RoomEvent.Reconnecting, () => store().setConnected(false));
  room.on(RoomEvent.Reconnected, () => store().setConnected(true));

  room.on(
    RoomEvent.ParticipantMetadataChanged,
    (_prev: string | undefined, participant: Participant) => {
      const fid = participantFid(participant.identity);
      if (fid === null) return;
      const metadata = parseMetadata(participant.metadata);
      const known = store().participants.some((p) => p.fid === fid);
      if (!known) {
        store().addParticipant({
          fid,
          role: (metadata.role as SpaceRole) || "listener",
          is_muted: true,
          is_speaking: false,
          hand_raised: false,
          display_name:
            metadata.display_name || participant.name || `User ${fid}`,
          pfp_url: safeImageUrl(metadata.pfp_url),
        });
        return;
      }
      if (metadata.role) {
        store().updateParticipant(fid, { role: metadata.role as SpaceRole });
      }
    },
  );

  // Local promotion/demotion via LiveKit permission changes.
  room.on(
    RoomEvent.ParticipantPermissionsChanged,
    (prevPermissions, participant: Participant) => {
      if (participant !== room.localParticipant) return;
      const canPublish = participant.permissions?.canPublish ?? false;
      const couldPublish = prevPermissions?.canPublish ?? false;
      const myFid = getUser()?.fid;
      if (!myFid) return;

      if (canPublish && !couldPublish) {
        store().setMyRole("speaker");
        store().updateParticipant(myFid, { role: "speaker", is_muted: false });
        livekit
          .enableMicrophone()
          .then(() => {
            store().setMuted(false);
            store().setMicPermissionDenied(false);
          })
          .catch((err) => {
            if (isNotAllowed(err)) store().setMicPermissionDenied(true);
          });
      } else if (!canPublish && couldPublish) {
        store().setMyRole("listener");
        store().updateParticipant(myFid, { role: "listener", is_muted: true });
        livekit.disableMicrophone().then(() => store().setMuted(true));
      }
    },
  );

  // Chat notifications + emoji reactions + recording state.
  room.on(
    RoomEvent.DataReceived,
    (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: DataPacket_Kind,
      topic?: string,
    ) => {
      let data: {
        type?: string;
        key?: string;
        recording?: unknown;
      };
      try {
        data = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }

      if (topic === "space_chat" && data.type === "new_reply") {
        store().bumpChatNewReply();
        return;
      }

      if (
        topic === "space_state" &&
        data.type === "recording_state" &&
        typeof data.recording === "boolean"
      ) {
        // Only trust a server-side broadcast (no participant) or a
        // host/co-host — a speaker with can_publish_data must not be able to
        // spoof the REC badge.
        const senderFid = participant
          ? participantFid(participant.identity)
          : null;
        const isServerSend = !participant;
        const senderRole = senderFid
          ? store().participants.find((p) => p.fid === senderFid)?.role
          : null;
        const trusted =
          isServerSend || senderRole === "host" || senderRole === "co_host";
        if (trusted) {
          store().setRecording(data.recording as boolean);
        } else {
          // Refetch authoritative state so a spoof can't stick.
          const currentRoom = store().room;
          if (currentRoom) {
            getSpaceDetail(currentRoom.id)
              .then((detail) => {
                if (detail?.room?.recording !== undefined) {
                  store().setRecording(!!detail.room.recording);
                }
              })
              .catch(() => {});
          }
        }
        return;
      }

      if (
        topic === "reactions" &&
        data.type === "reaction" &&
        typeof data.key === "string" &&
        // Bound the key: emoji are 1–8 UTF-16 units. Rejecting longer strings
        // stops a peer from spamming arbitrary text through the reaction
        // overlay (React already escapes it, so this is anti-abuse, not XSS).
        data.key.length > 0 &&
        data.key.length <= 8 &&
        participant
      ) {
        const senderFid = participantFid(participant.identity);
        if (senderFid !== null) {
          store().pushReaction({ key: data.key, fid: senderFid });
        }
      }
    },
  );

  store().setConnected(true);
}

export function useSpace() {
  const room = useSpaceStore((s) => s.room);
  const participants = useSpaceStore((s) => s.participants);
  const handQueue = useSpaceStore((s) => s.handQueue);
  const myRole = useSpaceStore((s) => s.myRole);
  const isConnected = useSpaceStore((s) => s.isConnected);
  const isMuted = useSpaceStore((s) => s.isMuted);
  const isHandRaised = useSpaceStore((s) => s.isHandRaised);
  const isRecording = useSpaceStore((s) => s.isRecording);
  const micPermissionDenied = useSpaceStore((s) => s.micPermissionDenied);
  const reactions = useSpaceStore((s) => s.reactions);
  const pendingStageInvite = useSpaceStore((s) => s.pendingStageInvite);

  const { reconnect, setToken } = useReconnect();

  const connect = useCallback(
    async (_roomId: string, token: string, wsUrl: string) => {
      const liveRoom = await livekit.connectToRoom(wsUrl, token);
      setupRoomListeners(liveRoom);

      // Hydrate everyone already in the room — `ParticipantConnected` only
      // fires for joins AFTER we subscribe.
      for (const participant of liveRoom.remoteParticipants.values()) {
        const fid = participantFid(participant.identity);
        if (fid === null) continue;
        const metadata = parseMetadata(participant.metadata);
        const canPublish = participant.permissions?.canPublish ?? false;
        const role: SpaceRole =
          (metadata.role as SpaceRole) || (canPublish ? "speaker" : "listener");
        store().addParticipant({
          fid,
          role,
          is_muted: !participant.isMicrophoneEnabled,
          is_speaking: false,
          hand_raised: false,
          display_name:
            metadata.display_name || participant.name || `User ${fid}`,
          pfp_url: safeImageUrl(metadata.pfp_url),
        });
      }

      // Seed the local participant — they aren't in `remoteParticipants`.
      const me = getUser();
      const currentRole = store().myRole;
      if (me?.fid && currentRole) {
        store().addParticipant({
          fid: me.fid,
          role: currentRole,
          is_muted: !SPEAKER_ROLES.has(currentRole),
          is_speaking: false,
          hand_raised: false,
          display_name: me.display_name || me.username || `User ${me.fid}`,
          pfp_url: safeImageUrl(me.pfp_url),
        });
      }

      // Native rooms: overlay Farcaster identity (display name / pfp / the full
      // listener list) onto the LiveKit-seeded participants. Farcaster's SFU
      // metadata carries no profile fields and most listeners aren't subscribed
      // to LiveKit at all, so without this every remote renders as `User <fid>`
      // with no avatar. Centralised here so EVERY native connect path (listener
      // join, host go-live, host create) hydrates identically. Non-blocking.
      const connectedRoom = store().room;
      if (connectedRoom?.is_farcaster_native && connectedRoom.farcaster_room_id) {
        void hydrateNativeParticipants(connectedRoom.farcaster_room_id).catch(
          () => {},
        );
      }

      // Auto-enable mic for host/co-host/speaker (inside the join gesture).
      if (currentRole && SPEAKER_ROLES.has(currentRole)) {
        try {
          await livekit.enableMicrophone();
          store().setMuted(false);
          store().setMicPermissionDenied(false);
        } catch (err) {
          if (isNotAllowed(err)) {
            store().setMicPermissionDenied(true);
            store().setMuted(true);
          } else {
            throw err;
          }
        }
      }
    },
    [],
  );

  const joinRoom = useCallback(
    async (roomId: string): Promise<JoinSpaceResponse> => {
      // Synchronously unlock audio inside the tap before any await.
      livekit.unlockAudioContext();

      const detail = await getSpaceDetail(roomId);
      if (!detail) throw new Error("Space not found");
      const roomShape = detail.room as SpaceRoom;

      // --- Farcaster-native path: connect to Farcaster's own LiveKit ---
      //
      // We mint a JFS bearer with the on-device Ed25519 app key (inside
      // `nativeJoin`), hand it to the backend's native-join endpoint, and
      // connect directly to Farcaster's LiveKit project with the returned
      // ws_url + token — Juke's LiveKit is NOT used. A JWT-less token refresh
      // (useReconnect) is intentionally skipped for these rooms.
      if (roomShape.is_farcaster_native) {
        const me = getUser();
        if (!me?.fid) throw new Error("Sign in to join this space");

        // Gate: signing a valid JFS bearer needs an approved app key. If it
        // isn't approved yet, surface the approval URL so the screen can drive
        // the Farcaster approval flow and retry the join.
        const gate = await ensureAppKeyApproved(me.fid);
        if (!gate.approved) {
          throw new AppKeyNotApprovedError(gate.approvalUrl);
        }

        const join = await nativeJoin(roomId, me.fid);
        const role: SpaceRole =
          roomShape.host_fid === me.fid
            ? "host"
            : (NATIVE_ROLE_MAP[join.role ?? ""] ?? "listener");

        store().joinSpace(
          roomShape,
          [
            {
              fid: me.fid,
              role,
              is_muted: !SPEAKER_ROLES.has(role),
              is_speaking: false,
              hand_raised: false,
              display_name: me.display_name || me.username || `User ${me.fid}`,
              pfp_url: safeImageUrl(me.pfp_url),
            },
          ],
          role,
        );
        await connect(roomId, join.token, join.ws_url);
        // No `setToken` — native rooms ride Farcaster's LiveKit; there is no
        // Juke token to top up. LiveKit's own auto-reconnect covers drops.
        // (`connect` hydrates the native participant identities.)
        return {
          livekit_token: join.token,
          livekit_ws_url: join.ws_url,
          role,
          room: roomShape,
          participants: [],
        };
      }

      const jwt = getJwt();
      if (!jwt) throw new Error("Sign in to join this space");

      const response = await joinSpaceAsListener(roomId, jwt);
      if (!response) throw new Error("Couldn't join this space");

      store().joinSpace(
        response.room as SpaceRoom,
        response.participants.map(toSessionParticipant),
        response.role as SpaceRole,
      );
      await connect(roomId, response.livekit_token, response.livekit_ws_url);
      setToken(
        response.livekit_token,
        response.expires_at ?? null,
        response.livekit_ws_url,
      );
      return response;
    },
    [connect, setToken],
  );

  const leaveRoom = useCallback(async (_roomId?: string) => {
    await store().leaveSpace();
  }, []);

  const disconnect = useCallback(async () => {
    await store().disconnect();
  }, []);

  const toggleMute = useCallback(async () => {
    await store().toggleMute();
  }, []);

  const startSpeaking = useCallback(async () => {
    try {
      await livekit.enableMicrophone();
      store().setMuted(false);
      store().setMicPermissionDenied(false);
      const myFid = getUser()?.fid;
      if (myFid) store().updateParticipant(myFid, { is_muted: false });
    } catch (err) {
      if (isNotAllowed(err)) {
        store().setMicPermissionDenied(true);
        return;
      }
      throw err;
    }
  }, []);

  /** Retry enabling the mic after a browser permission denial (user gesture). */
  const retryMic = useCallback(async () => {
    livekit.unlockAudioContext();
    await livekit.startAudioPlayback();
    await startSpeaking();
  }, [startSpeaking]);

  const sendReaction = useCallback(async (key: string) => {
    await livekit.sendReaction(key);
    const myFid = getUser()?.fid;
    if (myFid) store().pushReaction({ key, fid: myFid });
  }, []);

  const toggleRaiseHand = useCallback(async () => {
    const currentRoom = store().room;
    if (!currentRoom) return;
    const next = !store().isHandRaised;
    if (currentRoom.is_farcaster_native) {
      const myFid = getUser()?.fid;
      if (!myFid) return;
      await nativeRaiseHand(currentRoom.id, myFid, next);
      store().setHandRaised(next);
      return;
    }
    await raiseHandApi(currentRoom.id, next);
    store().setHandRaised(next);
  }, []);

  const promoteParticipant = useCallback(async (fid: number) => {
    const currentRoom = store().room;
    if (!currentRoom) return;
    if (currentRoom.is_farcaster_native) {
      const myFid = getUser()?.fid;
      if (!myFid) return;
      await nativeAcceptSpeaker(currentRoom.id, myFid, fid);
      return;
    }
    await promoteParticipantApi(currentRoom.id, fid);
  }, []);

  const demoteParticipant = useCallback(async (fid: number) => {
    const currentRoom = store().room;
    if (!currentRoom) return;
    if (currentRoom.is_farcaster_native) {
      const myFid = getUser()?.fid;
      if (!myFid) return;
      await nativeRemoveSpeaker(currentRoom.id, myFid, fid);
      return;
    }
    await demoteParticipantApi(currentRoom.id, fid);
  }, []);

  /** Accept a pending stage invite on a native room (listener → speaker). */
  const acceptStageInvite = useCallback(async () => {
    const currentRoom = store().room;
    if (!currentRoom?.is_farcaster_native) return;
    const myFid = getUser()?.fid;
    if (!myFid) return;
    await nativeAcceptStageInvite(currentRoom.id, myFid);
    store().setPendingStageInvite(null);
    // LiveKit's ParticipantPermissionsChanged flips our role + enables the mic
    // shortly after; nothing else to do here.
  }, []);

  /** Decline a pending stage invite on a native room. */
  const declineStageInvite = useCallback(async () => {
    const currentRoom = store().room;
    if (!currentRoom?.is_farcaster_native) return;
    const myFid = getUser()?.fid;
    if (!myFid) return;
    await nativeDeclineStageInvite(currentRoom.id, myFid);
    store().setPendingStageInvite(null);
  }, []);

  const endRoom = useCallback(async () => {
    const currentRoom = store().room;
    if (!currentRoom) return;
    if (currentRoom.is_farcaster_native) {
      const myFid = getUser()?.fid;
      if (!myFid) return;
      await nativeEnd(currentRoom.id, myFid);
    } else {
      await endRoomApi(currentRoom.id);
    }
    // Optimistically drain the "Live now" rail so the just-ended space
    // disappears immediately instead of lingering until the WS `room_ended`
    // push or the 30s poll. Drop both the Juke row id and the upstream
    // Farcaster room id so native cards clear too. Reconciled by next refresh.
    const drop = useSpacesDiscoveryStore.getState().dropRoom;
    drop(currentRoom.id);
    if (currentRoom.farcaster_room_id) drop(currentRoom.farcaster_room_id);
    await store().disconnect();
  }, []);

  /** Re-attach listeners to an already-connected room (e.g. host create flow). */
  const attachListeners = useCallback(() => {
    const activeRoom = livekit.getActiveRoom();
    if (activeRoom && !WIRED_ROOMS.has(activeRoom)) {
      setupRoomListeners(activeRoom);
      const currentRoom = store().room;
      if (currentRoom) {
        refreshRoomToken(currentRoom.id)
          .then(({ livekit_token, expires_at }) => {
            setToken(livekit_token, expires_at, livekit.getActiveWsUrl());
          })
          .catch(() => {});
      }
    }
  }, [setToken]);

  /**
   * Re-fetch the upstream Farcaster participant list and merge display names /
   * pfps / newly-joined listeners into the store. No-op for Juke-hosted rooms.
   * Callers poll this so late joiners (who arrive as `User <fid>` over LiveKit,
   * or never subscribe to LiveKit at all) get enriched and appear in the list.
   */
  const refreshNativeParticipants = useCallback(async () => {
    const currentRoom = store().room;
    if (currentRoom?.is_farcaster_native && currentRoom.farcaster_room_id) {
      await hydrateNativeParticipants(currentRoom.farcaster_room_id);
    }
  }, []);

  const setOnRoomEnded = useCallback((cb: () => void) => {
    onRoomEndedCb = cb;
  }, []);

  // Clear the module-level ended callback when the owning screen unmounts.
  useEffect(() => {
    return () => {
      onRoomEndedCb = null;
    };
  }, []);

  return {
    room,
    participants,
    handQueue,
    myRole,
    isConnected,
    isMuted,
    isHandRaised,
    isRecording,
    micPermissionDenied,
    reactions,
    pendingStageInvite,
    reconnect,
    joinRoom,
    leaveRoom,
    connect,
    disconnect,
    toggleMute,
    startSpeaking,
    retryMic,
    sendReaction,
    toggleRaiseHand,
    acceptStageInvite,
    declineStageInvite,
    promoteParticipant,
    demoteParticipant,
    endRoom,
    attachListeners,
    refreshNativeParticipants,
    setOnRoomEnded,
  };
}
