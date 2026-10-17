import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules, NativeEventEmitter } from "react-native";
import { signFarcasterClientBearer } from "@/services/snapSigner";
import { RoomEvent, DataPacket_Kind, DisconnectReason } from "livekit-client";
import type {
  Room,
  RemoteParticipant,
  Participant,
  TrackPublication,
} from "livekit-client";
import { useSpaceStore } from "@/stores/spaceStore";
import { useAuthStore } from "@/stores/authStore";
import * as livekitService from "@/services/livekit";
import * as api from "@/services/api";
import {
  fidFromIdentity,
  NoBearerError,
  heartbeatAudioRoom,
  endAudioRoom as endFarcasterRoom,
  sendReaction as sendReactionFarcaster,
} from "@/services/farcasterSpacesClient";
import type { Room as JukeRoom, ParticipantRole } from "@/types/space";
import { useReconnect } from "@/hooks/useReconnect";
import { useFarcasterSync } from "@/hooks/useFarcasterSync";
import { useFarcasterAppKey } from "@/hooks/useFarcasterAppKey";
import { isSafeImageUrl } from "@/utils/url";

const { AudioSessionModule } = NativeModules;

/**
 * Thrown by `joinRoom` for native rooms when the caller's Ed25519 app
 * key isn't approved on their FID yet. The approval URL has already
 * been opened on the user's behalf (via `useFarcasterAppKey`); callers
 * just need to render a "approve then come back" affordance and stop
 * treating this as a generic join error.
 */
export class AppKeyNotApprovedError extends Error {
  constructor(public readonly approvalUrl: string | null) {
    super("Farcaster app key not approved");
    this.name = "AppKeyNotApprovedError";
  }
}

/**
 * Heartbeat cadence for Farcaster-native rooms. The upstream server uses
 * this to drive listener-side active-speaker rendering for clients that
 * are not directly subscribed to LiveKit.
 */
const FARCASTER_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Extract a participant fid that works for both Juke-hosted rooms (where
 * identity is a bare numeric string) and Farcaster-native rooms (where
 * identity is `fid:<n>`).
 */
function participantFid(
  identity: string | undefined,
  isFarcasterNative: boolean,
): number | null {
  if (isFarcasterNative) return fidFromIdentity(identity);
  if (!identity) return null;
  const n = parseInt(identity, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isFarcasterNative(room: JukeRoom | null | undefined): boolean {
  return !!room?.is_farcaster_native;
}

export function useSpace() {
  const store = useSpaceStore();
  const user = useAuthStore((s) => s.user);
  const roomRef = useRef<Room | null>(null);
  const { reconnect, setToken } = useReconnect();
  const farcasterSync = useFarcasterSync();
  // App-key gate for native writes (create / join / end). When the
  // user's Ed25519 app key isn't approved on their FID yet,
  // `ensureApproved` opens the Farcaster approval URL on their behalf
  // and an AppState watcher flips status when they return.
  const { ensureApproved: ensureFarcasterAppKey } = useFarcasterAppKey(
    user?.fid ?? 0,
  );
  const reactionIdRef = useRef(0);
  const [reactions, setReactions] = useState<
    Array<{ key: string; id: number; fid: number }>
  >([]);
  const [needsFarcasterSync, setNeedsFarcasterSync] = useState(false);
  const onRoomEndedRef = useRef<(() => void) | null>(null);

  // Pending stage-invite (Farcaster app shows this as a push;
  // Juke-only users don't get the push, so we poll the participants
  // endpoint and surface it via this state). Cleared on accept /
  // decline / disconnect.
  const [pendingStageInvite, setPendingStageInvite] = useState<{
    inviterFid: number | null;
    inviterDisplayName: string | null;
    inviterPfpUrl: string | null;
    role: string;
  } | null>(null);
  const pendingInviteRoomIdRef = useRef<string | null>(null);
  const pendingInvitePollRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  // ---------------------------------------------------------------------
  // Farcaster-native heartbeat
  // ---------------------------------------------------------------------
  //
  // We keep the most recent set of active-speaker fids in a ref so the
  // heartbeat interval has access without re-creating itself every time
  // ActiveSpeakersChanged fires.
  const activeSpeakerFidsRef = useRef<number[]>([]);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(
    (farcasterRoomId: string) => {
      stopHeartbeat();
      // Fire once immediately so the server marks us as present before
      // the first interval tick lands.
      void heartbeatAudioRoom(
        farcasterRoomId,
        activeSpeakerFidsRef.current,
      ).catch(() => {
        // Swallow — transient heartbeat failures should never crash the
        // hook. The next tick will retry.
      });
      heartbeatIntervalRef.current = setInterval(() => {
        void heartbeatAudioRoom(
          farcasterRoomId,
          activeSpeakerFidsRef.current,
        ).catch(() => {});
      }, FARCASTER_HEARTBEAT_INTERVAL_MS);
    },
    [stopHeartbeat],
  );

  // Clean up the heartbeat on unmount.
  useEffect(() => stopHeartbeat, [stopHeartbeat]);

  // ---------------------------------------------------------------------
  // Pending stage-invite poller (Farcaster-native rooms)
  // ---------------------------------------------------------------------
  //
  // When a host promotes a listener to speaker, upstream Farcaster sends
  // a push notification to the target's Farcaster app. Juke-only users
  // don't receive that push, so we poll the upstream participants list
  // every 5s and watch for our own `pending_invite` field appearing.
  // When it does, we surface the accept/decline UI; when it clears
  // (host cancelled, we accepted/declined elsewhere, etc.) we hide it.
  const PENDING_INVITE_POLL_INTERVAL_MS = 5_000;

  const stopPendingInvitePoll = useCallback(() => {
    if (pendingInvitePollRef.current) {
      clearInterval(pendingInvitePollRef.current);
      pendingInvitePollRef.current = null;
    }
    pendingInviteRoomIdRef.current = null;
    setPendingStageInvite(null);
  }, []);

  const startPendingInvitePoll = useCallback(
    (farcasterRoomId: string) => {
      // Idempotent — re-entry with the same room is a no-op.
      if (pendingInviteRoomIdRef.current === farcasterRoomId) return;
      stopPendingInvitePoll();
      pendingInviteRoomIdRef.current = farcasterRoomId;

      const tick = async () => {
        // Guard against late tick after stop / room swap.
        if (pendingInviteRoomIdRef.current !== farcasterRoomId) return;
        const myFid = useAuthStore.getState().user?.fid;
        if (!myFid) return;
        try {
          const participants =
            await api.fetchFarcasterNativeSpaceParticipants(farcasterRoomId);
          if (pendingInviteRoomIdRef.current !== farcasterRoomId) return;
          const me = participants.find((p) => p.user?.fid === myFid);
          const invite = me?.pending_invite ?? null;
          if (invite) {
            // Resolve inviter display info from the participants list
            // so the UX can render "X invited you to speak" without
            // another fetch.
            const inviter = invite.inviter_fid
              ? participants.find((p) => p.user?.fid === invite.inviter_fid)
              : null;
            setPendingStageInvite({
              inviterFid: invite.inviter_fid ?? null,
              inviterDisplayName:
                inviter?.user?.display_name ||
                inviter?.user?.username ||
                null,
              inviterPfpUrl: inviter?.user?.pfp_url ?? null,
              role: String(invite.role || "speaker"),
            });
          } else {
            setPendingStageInvite(null);
          }
        } catch {
          // Best-effort — a flaky upstream just delays the surface;
          // the next tick will retry.
        }
      };
      void tick();
      pendingInvitePollRef.current = setInterval(
        () => void tick(),
        PENDING_INVITE_POLL_INTERVAL_MS,
      );
    },
    [stopPendingInvitePoll],
  );

  // Clean up the poll on unmount.
  useEffect(() => stopPendingInvitePoll, [stopPendingInvitePoll]);

  /**
   * Accept a pending stage invite. Signs a fresh JFS bearer on-device
   * and posts to Juke's authenticated native-accept-stage-invite
   * endpoint, which proxies upstream. On success the local UI is
   * cleared optimistically; LiveKit will push
   * `ParticipantPermissionsChanged` shortly after which flips role +
   * enables the mic via the existing handler.
   */
  const acceptStageInvite = useCallback(async () => {
    const currentRoom = useSpaceStore.getState().room;
    if (!currentRoom?.is_farcaster_native || !currentRoom.farcaster_room_id) {
      return;
    }
    const myFid = useAuthStore.getState().user?.fid;
    if (!myFid) return;
    const bearer = await signFarcasterClientBearer(myFid);
    await api.acceptStageInviteFarcasterNative(currentRoom.id, {
      user_jfs_bearer: bearer,
    });
    setPendingStageInvite(null);
  }, []);

  /** Decline a pending stage invite. Same shape as accept. */
  const declineStageInvite = useCallback(async () => {
    const currentRoom = useSpaceStore.getState().room;
    if (!currentRoom?.is_farcaster_native || !currentRoom.farcaster_room_id) {
      return;
    }
    const myFid = useAuthStore.getState().user?.fid;
    if (!myFid) return;
    const bearer = await signFarcasterClientBearer(myFid);
    await api.declineStageInviteFarcasterNative(currentRoom.id, {
      user_jfs_bearer: bearer,
    });
    setPendingStageInvite(null);
  }, []);

  const setupRoomListeners = useCallback(
    (room: Room) => {
      if (roomRef.current === room) return;
      roomRef.current = room;

      room.on("participantConnected", (participant: RemoteParticipant) => {
        const native = isFarcasterNative(useSpaceStore.getState().room);
        const fid = participantFid(participant.identity, native);
        if (fid === null) return;
        let metadata: { role?: string; pfp_url?: string } = {};
        try {
          metadata = participant.metadata
            ? JSON.parse(participant.metadata)
            : {};
        } catch {
          // Ignore malformed metadata
        }
        store.addParticipant({
          fid,
          role: (metadata.role as ParticipantRole) || "listener",
          is_muted: true,
          is_speaking: false,
          hand_raised: false,
          display_name: participant.name || `User ${fid}`,
          pfp_url: metadata.pfp_url || null,
        });
      });

      room.on("participantDisconnected", (participant: RemoteParticipant) => {
        const native = isFarcasterNative(useSpaceStore.getState().room);
        const fid = participantFid(participant.identity, native);
        if (fid === null) return;
        store.removeParticipant(fid);
      });

      room.on(
        "trackMuted",
        (publication: TrackPublication, participant: Participant) => {
          const native = isFarcasterNative(useSpaceStore.getState().room);
          const fid = participantFid(participant.identity, native);
          if (fid === null) return;
          store.updateParticipant(fid, { is_muted: true, is_speaking: false });
        },
      );

      room.on(
        "trackUnmuted",
        (publication: TrackPublication, participant: Participant) => {
          const native = isFarcasterNative(useSpaceStore.getState().room);
          const fid = participantFid(participant.identity, native);
          if (fid === null) return;
          store.updateParticipant(fid, { is_muted: false });
        },
      );

      room.on(
        RoomEvent.ActiveSpeakersChanged,
        (activeSpeakers: Participant[]) => {
          const native = isFarcasterNative(useSpaceStore.getState().room);
          const fids: number[] = [];
          const knownFids = new Set(
            useSpaceStore.getState().participants.map((p) => p.fid),
          );
          for (const p of activeSpeakers) {
            const fid = participantFid(p.identity, native);
            if (fid === null) continue;
            fids.push(fid);
            // Self-heal: a fid that's actively speaking but not in the
            // store means we lost them at some point (LiveKit silent
            // reconnect after `participantDisconnected` removed them,
            // or upstream Farcaster shuffled their identity). Audio is
            // flowing, so they're definitely a speaker — add them so
            // they show up on the speakers list and stop being a ghost.
            if (!knownFids.has(fid)) {
              let metadata: { role?: string; pfp_url?: string; display_name?: string } = {};
              try {
                metadata = p.metadata ? JSON.parse(p.metadata) : {};
              } catch {
                /* malformed metadata — fall through */
              }
              store.addParticipant({
                fid,
                role: (metadata.role as ParticipantRole) || "speaker",
                is_muted: false,
                is_speaking: true,
                hand_raised: false,
                display_name:
                  metadata.display_name || p.name || `User ${fid}`,
                pfp_url: metadata.pfp_url || null,
              });
              knownFids.add(fid);
            }
          }
          activeSpeakerFidsRef.current = fids;
          store.setSpeakingParticipants(new Set(fids));
        },
      );

      room.on("disconnected", (reason?: DisconnectReason) => {
        store.setConnected(false);
        // Server deleted the room (host ended the space) — auto-leave
        if (
          reason === DisconnectReason.SERVER_SHUTDOWN ||
          reason === DisconnectReason.ROOM_DELETED
        ) {
          roomRef.current = null;
          stopHeartbeat();
          stopPendingInvitePoll();
          store.leaveSpace();
          onRoomEndedRef.current?.();
        }
      });

      room.on("reconnecting", () => {
        store.setConnected(false);
      });

      room.on("reconnected", () => {
        store.setConnected(true);
      });

      // Detect role changes on remote participants via metadata updates.
      // Also self-heals: if the participant isn't in the store yet (we
      // dropped them on a stale `participantDisconnected` and LiveKit
      // silently re-subscribed them), add them rather than no-op the
      // role update against nothing.
      room.on(
        RoomEvent.ParticipantMetadataChanged,
        (prevMetadata: string | undefined, participant: Participant) => {
          const native = isFarcasterNative(useSpaceStore.getState().room);
          const fid = participantFid(participant.identity, native);
          if (fid === null) return;
          let metadata: { role?: string; pfp_url?: string; display_name?: string } = {};
          try {
            metadata = participant.metadata
              ? JSON.parse(participant.metadata)
              : {};
          } catch {
            return;
          }
          const known = useSpaceStore
            .getState()
            .participants.some((p) => p.fid === fid);
          if (!known) {
            store.addParticipant({
              fid,
              role: (metadata.role as ParticipantRole) || "listener",
              is_muted: true,
              is_speaking: false,
              hand_raised: false,
              display_name:
                metadata.display_name || participant.name || `User ${fid}`,
              pfp_url: metadata.pfp_url || null,
            });
            return;
          }
          if (metadata.role) {
            store.updateParticipant(fid, {
              role: metadata.role as ParticipantRole,
            });
          }
        },
      );

      // Detect promotion/demotion via LiveKit permission changes
      room.on(
        RoomEvent.ParticipantPermissionsChanged,
        (prevPermissions: any, participant: Participant) => {
          // Only care about the local participant's permissions changing
          if (participant !== room.localParticipant) return;

          const canPublish = participant.permissions?.canPublish ?? false;
          const couldPublish = prevPermissions?.canPublish ?? false;
          const myFid = useAuthStore.getState().user?.fid;
          if (!myFid) return;

          if (canPublish && !couldPublish) {
            // Promoted to speaker — update role and enable mic
            console.log("[useSpace] Local participant promoted to speaker");
            store.setMyRole("speaker");
            store.updateParticipant(myFid, {
              role: "speaker",
              is_muted: false,
            });
            livekitService.enableMicrophone().then(() => {
              store.setMuted(false);
            });
          } else if (!canPublish && couldPublish) {
            // Demoted to listener — update role and disable mic
            console.log("[useSpace] Local participant demoted to listener");
            store.setMyRole("listener");
            store.updateParticipant(myFid, {
              role: "listener",
              is_muted: true,
            });
            livekitService.disableMicrophone().then(() => {
              store.setMuted(true);
            });
          }
        },
      );

      // Handle data messages (chat notifications + emoji reactions)
      room.on(
        RoomEvent.DataReceived,
        (
          payload: Uint8Array,
          participant?: Participant,
          kind?: DataPacket_Kind,
          topic?: string,
        ) => {
          try {
            const data = JSON.parse(new TextDecoder().decode(payload));

            if (topic === "space_chat" && data.type === "new_reply") {
              store.bumpChatNewReply();
            }

            if (
              topic === "space_state" &&
              data.type === "recording_state" &&
              typeof data.recording === "boolean"
            ) {
              // Security: space_state messages can be sent by any participant
              // with can_publish_data (hosts/co-hosts/speakers). Only trust
              // the payload if it came from a server-side broadcast
              // (undefined participant — LiveKit SDK reports room-level
              // sends from our backend this way) or from a verified
              // host/co-host. Otherwise, ignore and refetch authoritative
              // state from our API so the REC badge can't be spoofed by a
              // malicious speaker.
              const native = isFarcasterNative(
                useSpaceStore.getState().room,
              );
              const senderFid = participant
                ? participantFid(participant.identity, native)
                : null;
              const isServerSend = !participant;
              const senderRole = senderFid
                ? useSpaceStore
                    .getState()
                    .participants.find((p) => p.fid === senderFid)?.role
                : null;
              const trusted =
                isServerSend ||
                senderRole === "host" ||
                senderRole === "co_host";

              if (trusted) {
                store.setRecording(data.recording);
              } else {
                console.warn(
                  "[useSpace] Ignoring space_state from untrusted sender",
                  { senderFid, senderRole },
                );
                const currentRoom = useSpaceStore.getState().room;
                // Recording state is a Juke-only concept; only refetch
                // for Juke-hosted rooms. Farcaster-native rooms have no
                // equivalent server-side recording flag we can fetch.
                if (currentRoom && !currentRoom.is_farcaster_native) {
                  api
                    .getRoom(currentRoom.id)
                    .then((detail) => {
                      if (detail?.room?.recording !== undefined) {
                        store.setRecording(!!detail.room.recording);
                      }
                    })
                    .catch(() => {});
                }
              }
            }

            if (
              topic === "reactions" &&
              data.type === "reaction" &&
              data.key &&
              participant
            ) {
              const native = isFarcasterNative(
                useSpaceStore.getState().room,
              );
              const senderFid = participantFid(participant.identity, native);
              if (senderFid !== null) {
                reactionIdRef.current += 1;
                setReactions((prev) => [
                  ...prev.slice(-19),
                  { key: data.key, id: reactionIdRef.current, fid: senderFid },
                ]);
              }
            }

            // Diagnostic: on Farcaster-native rooms, log any topic we
            // don't already handle. Goal is to discover whether upstream
            // pushes stage-invite events (or other useful signals) via
            // the LiveKit data channel — if so, we can wire instant
            // pushes in a follow-up and drop the participants poll.
            if (__DEV__) {
              const native = isFarcasterNative(
                useSpaceStore.getState().room,
              );
              const KNOWN_TOPICS = new Set([
                "space_chat",
                "space_state",
                "reactions",
              ]);
              if (native && topic && !KNOWN_TOPICS.has(topic)) {
                console.log(
                  "[useSpace][native-data] unknown topic — capture for follow-up",
                  { topic, kind, data, fromFid: participant?.identity },
                );
              }
            }
          } catch {
            // Ignore malformed data messages
          }
        },
      );

      store.setConnected(true);
    },
    [store, stopHeartbeat],
  );

  const connect = useCallback(
    async (roomId: string, token: string, wsUrl: string) => {
      const room = await livekitService.connectToRoom(wsUrl, token);
      setupRoomListeners(room);

      // Hydrate participants from the LiveKit room state. `participantConnected`
      // events only fire for joins that happen AFTER our subscribe, so the
      // listeners/speakers who were already in the room when we connected
      // would otherwise be invisible. For native rooms this is the only
      // source of truth — there is no Juke /v1/rooms/{id}/participants list
      // because the participants live on Farcaster's LiveKit project.
      const native = isFarcasterNative(useSpaceStore.getState().room);
      for (const participant of room.remoteParticipants.values()) {
        const fid = participantFid(participant.identity, native);
        if (fid === null) continue;
        let metadata: { role?: string; pfp_url?: string; display_name?: string } = {};
        try {
          metadata = participant.metadata
            ? JSON.parse(participant.metadata)
            : {};
        } catch {
          // Ignore malformed metadata.
        }
        // Derive role from LiveKit capabilities when metadata is silent —
        // Farcaster's upstream sets `canPublish` on speakers/hosts and
        // leaves it false for listeners. Local participant gets a similar
        // capability-based role below.
        const canPublish = participant.permissions?.canPublish ?? false;
        const role: ParticipantRole =
          (metadata.role as ParticipantRole) ||
          (canPublish ? "speaker" : "listener");
        store.addParticipant({
          fid,
          role,
          is_muted: !participant.isMicrophoneEnabled,
          is_speaking: false,
          hand_raised: false,
          display_name:
            metadata.display_name || participant.name || `User ${fid}`,
          pfp_url: metadata.pfp_url || null,
        });
      }

      // Seed the local participant — they don't appear in `remoteParticipants`
      // but should still show up in the speakers/listeners list.
      const myFid = useAuthStore.getState().user?.fid;
      const me = useAuthStore.getState().user;
      const myRole = useSpaceStore.getState().myRole;
      if (myFid && myRole) {
        store.addParticipant({
          fid: myFid,
          role: myRole,
          is_muted: !(
            myRole === "host" ||
            myRole === "co_host" ||
            myRole === "speaker"
          ),
          is_speaking: false,
          hand_raised: false,
          display_name: me?.display_name || me?.username || `User ${myFid}`,
          pfp_url: me?.pfp_url ?? null,
        });
      }

      // Auto-enable mic for hosts/speakers/co-hosts. Read role from
      // the live store rather than the captured snapshot — within the
      // native-join flow `joinSpace` is dispatched immediately before
      // `connect`, so the closure-captured `store.myRole` is stale.
      const role = useSpaceStore.getState().myRole;
      if (role === "host" || role === "co_host" || role === "speaker") {
        await livekitService.enableMicrophone();
        store.setMuted(false);
      }
    },
    [store, setupRoomListeners],
  );

  const disconnect = useCallback(async () => {
    stopHeartbeat();
    stopPendingInvitePoll();
    try {
      await livekitService.disconnectFromRoom();
    } catch (e) {
      console.warn("[useSpace] LiveKit disconnect error:", e);
    }
    roomRef.current = null;
    store.leaveSpace();
  }, [store, stopHeartbeat, stopPendingInvitePoll]);

  const joinRoom = useCallback(
    async (roomId: string) => {
      // Fetch the Juke room first so we know whether this is a native
      // wrapper or a Juke-hosted room. We use getRoom (not joinRoom)
      // for the lookup — joining a Farcaster-native room must NOT go
      // through the Juke /join endpoint because there's no Juke
      // LiveKit room to issue a token for.
      const detail = await api.getRoom(roomId);

      if (detail.room.is_farcaster_native && detail.room.farcaster_room_id) {
        // --- Farcaster-native path: in-Juke LiveKit connect ---
        //
        // We sign a JFS bearer with the on-device Ed25519 app key, hand
        // it to the backend's native-join endpoint, and connect directly
        // to Farcaster's LiveKit project using the returned ws_url +
        // token. The ws_url points at Farcaster's LiveKit infra, NOT
        // Juke's — Juke's own LiveKit quota is not used.
        //
        // Role derivation: the upstream room is hosted by the user's
        // FID when they created it, otherwise they're a listener.
        // Speaker promotion (post-listener-join) is a follow-up.
        setNeedsFarcasterSync(false);
        if (!user?.fid) {
          throw new Error("Not signed in");
        }
        // Gate: signing a JFS bearer needs an approved Ed25519 app key
        // on the caller's FID. Without it, upstream Farcaster 401s the
        // bearer and the backend surfaces 502 "Couldn't join on
        // Farcaster" — visible to the user as a generic error.
        // `ensureApproved` short-circuits if already approved; if not,
        // it opens the approval URL and arms an AppState watcher.
        const gate = await ensureFarcasterAppKey();
        if (!gate.approved) {
          throw new AppKeyNotApprovedError(gate.approvalUrl ?? null);
        }
        const bearer = await signFarcasterClientBearer(user.fid);
        const join = await api.joinFarcasterNativeRoom(roomId, {
          user_jfs_bearer: bearer,
        });
        const role: ParticipantRole =
          detail.room.host_fid === user.fid ? "host" : "listener";
        // Seed the local user immediately so their pfp and display name
        // are visible from the first render. The async upstream hydration
        // below will fill in other participants; the guard on pfp_url
        // there prevents overwriting a good value with null if the
        // upstream hasn't enriched the profile yet.
        store.joinSpace(
          detail.room,
          [
            {
              fid: user.fid,
              role,
              is_muted: role === "listener",
              is_speaking: false,
              hand_raised: false,
              display_name:
                user.display_name || user.username || `User ${user.fid}`,
              pfp_url: user.pfp_url ?? null,
            },
          ],
          role,
        );
        await connect(roomId, join.token, join.ws_url);
        setToken(join.token, null, join.ws_url);
        // Heartbeat drives upstream's active-speaker rendering for
        // listeners that aren't directly subscribed to LiveKit.
        startHeartbeat(detail.room.farcaster_room_id);
        // Pending stage-invite poller — Juke-only users don't receive
        // Farcaster's push notification when the host promotes them, so
        // we poll the upstream participants list and surface the
        // accept/decline UI when our own `pending_invite` field appears.
        startPendingInvitePoll(detail.room.farcaster_room_id);
        // Hydrate display_name + pfp_url for every participant from the
        // upstream API. LiveKit participant metadata from Farcaster's
        // upstream doesn't carry these fields, so without this overlay
        // we'd render initials-only for every speaker / listener. Done
        // AFTER connect() so `setupRoomListeners` has already seeded
        // the store with LiveKit's view; we just merge identity data.
        void api
          .fetchFarcasterNativeSpaceParticipants(detail.room.farcaster_room_id)
          .then((upstream) => {
            if (!upstream.length) return;
            const seenFids = new Set(
              useSpaceStore.getState().participants.map((p) => p.fid),
            );
            for (const p of upstream) {
              const u = p.user;
              if (!u?.fid) continue;
              const role: ParticipantRole = ((): ParticipantRole => {
                switch (p.role) {
                  case "host":
                    return "host";
                  case "cohost":
                    return "co_host";
                  case "speaker":
                    return "speaker";
                  default:
                    return "listener";
                }
              })();
              if (seenFids.has(u.fid)) {
                // Merge identity onto an existing LiveKit-seeded row.
                // Guard pfp_url: upstream can return null immediately
                // after creation (profile not yet enriched). Only
                // overwrite when the value is a safe public https URL.
                store.updateParticipant(u.fid, {
                  role,
                  display_name:
                    u.display_name || u.username || `User ${u.fid}`,
                  ...(isSafeImageUrl(u.pfp_url) ? { pfp_url: u.pfp_url } : {}),
                  hand_raised: !!p.hand_raised,
                });
              } else {
                // Listener not subscribed to LiveKit (most listeners
                // aren't) — add them so they show up in the list.
                store.addParticipant({
                  fid: u.fid,
                  role,
                  is_muted: role === "listener",
                  is_speaking: false,
                  hand_raised: !!p.hand_raised,
                  display_name:
                    u.display_name || u.username || `User ${u.fid}`,
                  pfp_url: isSafeImageUrl(u.pfp_url) ? u.pfp_url : null,
                });
              }
            }
          });
        return null;
      }

      // --- Juke-hosted path (existing behavior) ---
      const response = await api.joinRoom(roomId);
      store.joinSpace(response.room, response.participants, response.role);
      await connect(roomId, response.livekit_token, response.livekit_ws_url);
      // Seed the reconnect engine with the initial token and backend-provided
      // LiveKit endpoint so foreground reconnect uses the same SFU URL.
      setToken(
        response.livekit_token,
        response.expires_at,
        response.livekit_ws_url,
      );
      return response;
    },
    [
      connect,
      store,
      setToken,
      startHeartbeat,
      user?.fid,
      ensureFarcasterAppKey,
    ],
  );

  const leaveRoom = useCallback(
    async (roomId: string) => {
      const currentRoom = useSpaceStore.getState().room;
      if (currentRoom?.is_farcaster_native && currentRoom.farcaster_room_id) {
        // Native rooms: disconnect from the upstream LiveKit room.
        // The upstream server treats a LiveKit disconnect as a leave —
        // no separate HTTP leave call is needed for listeners.
        await disconnect();
        return;
      }
      await api.leaveRoom(roomId);
      await disconnect();
    },
    [disconnect],
  );

  const toggleMute = useCallback(async () => {
    const isMuted = await livekitService.toggleMicrophone();
    store.setMuted(isMuted);
    const myFid = useAuthStore.getState().user?.fid;
    if (myFid) store.updateParticipant(myFid, { is_muted: isMuted });
  }, [store]);

  const sendReaction = useCallback(async (key: string) => {
    // Always send via LiveKit data channel — both Juke-hosted and
    // Farcaster-native rooms connect to a LiveKit SFU, so peers will
    // see the bubble immediately.
    await livekitService.sendReaction(key);

    // For Farcaster-native rooms, ALSO fire the HTTP endpoint so the
    // upstream server can fan out the reaction to non-LiveKit listeners
    // (e.g. embedded watch surfaces).
    const currentRoom = useSpaceStore.getState().room;
    if (currentRoom?.is_farcaster_native && currentRoom.farcaster_room_id) {
      try {
        await sendReactionFarcaster(currentRoom.farcaster_room_id, key);
      } catch (err) {
        // Reaction HTTP failure is non-critical; the LiveKit fan-out
        // already covered same-room peers.
        console.warn("[useSpace] Farcaster reaction HTTP error:", err);
      }
    }

    const myFid = useAuthStore.getState().user?.fid;
    if (myFid) {
      reactionIdRef.current += 1;
      setReactions((prev) => [
        ...prev.slice(-19),
        { key, id: reactionIdRef.current, fid: myFid },
      ]);
    }
  }, []);

  const startSpeaking = useCallback(async () => {
    await livekitService.enableMicrophone();
    store.setMuted(false);
    const myFid = useAuthStore.getState().user?.fid;
    if (myFid) store.updateParticipant(myFid, { is_muted: false });
  }, [store]);

  /**
   * Toggle hand-raise on a Farcaster-native room. Juke-hosted rooms use
   * a separate raise-hand surface (managed elsewhere); this helper is a
   * no-op for those and surfaces a warn in dev so the wrong code path
   * is easy to catch.
   */
  const toggleRaiseHand = useCallback(async () => {
    const currentRoom = useSpaceStore.getState().room;
    if (!currentRoom) return;
    const next = !store.isHandRaised;
    if (currentRoom.is_farcaster_native && currentRoom.farcaster_room_id) {
      // Native rooms — sign a fresh JFS bearer on-device and post
      // to Juke's authenticated raise-hand endpoint. Backend
      // cross-checks the JFS fid against the JWT fid before
      // proxying to upstream.
      const myFid = useAuthStore.getState().user?.fid;
      if (!myFid) return;
      const bearer = await signFarcasterClientBearer(myFid);
      await api.raiseHandFarcasterNative(currentRoom.id, {
        user_jfs_bearer: bearer,
        raised: next,
      });
      store.setHandRaised(next);
      return;
    }
    // Juke-hosted rooms: this hook doesn't expose a raise-hand UX
    // (managed by the Juke admin surface elsewhere). Bail with a
    // dev-only warn so a wrong-path call is easy to spot.
    if (__DEV__) {
      console.warn(
        "[useSpace] toggleRaiseHand called on non-native room — use the Juke /raise-hand endpoint instead",
      );
    }
  }, [store]);

  /**
   * Host-only: promote a participant to speaker. Branches on the
   * current room — Juke-hosted goes through the Juke admin API,
   * Farcaster-native signs a JFS bearer and posts to Juke's
   * native-accept-speaker endpoint (which proxies upstream).
   */
  const promoteParticipant = useCallback(async (fid: number) => {
    const currentRoom = useSpaceStore.getState().room;
    if (!currentRoom) return;
    if (currentRoom.is_farcaster_native && currentRoom.farcaster_room_id) {
      const myFid = useAuthStore.getState().user?.fid;
      if (!myFid) return;
      const bearer = await signFarcasterClientBearer(myFid);
      await api.acceptSpeakerFarcasterNative(currentRoom.id, {
        user_jfs_bearer: bearer,
        target_fid: fid,
      });
      return;
    }
    await api.promoteParticipant(currentRoom.id, fid);
  }, []);

  /** Host-only: demote a speaker back to listener. */
  const demoteParticipant = useCallback(async (fid: number) => {
    const currentRoom = useSpaceStore.getState().room;
    if (!currentRoom) return;
    if (currentRoom.is_farcaster_native && currentRoom.farcaster_room_id) {
      const myFid = useAuthStore.getState().user?.fid;
      if (!myFid) return;
      const bearer = await signFarcasterClientBearer(myFid);
      await api.removeSpeakerFarcasterNative(currentRoom.id, {
        user_jfs_bearer: bearer,
        target_fid: fid,
      });
      return;
    }
    await api.demoteParticipant(currentRoom.id, fid);
  }, []);

  /**
   * Host-only: end the room for everyone. Branches on
   * `is_farcaster_native`. Native rooms minted via the user-FID path
   * (the default since the JFS-write infra shipped) are upstream-hosted
   * by the user, so the upstream end call needs the user's own JFS
   * bearer — Juke's service bearer 403s. We sign a fresh bearer here
   * and forward it through the backend.
   */
  const endRoom = useCallback(async () => {
    const currentRoom = useSpaceStore.getState().room;
    if (!currentRoom) return;
    if (currentRoom.is_farcaster_native && currentRoom.farcaster_room_id) {
      const myFid = useAuthStore.getState().user?.fid;
      // No fid → caller isn't signed in, can't be the host, shouldn't
      // reach this branch. Bail gracefully rather than minting a bearer
      // for fid 0.
      if (!myFid) return;
      const userBearer = await signFarcasterClientBearer(myFid);
      await api.endFarcasterNativeRoom(currentRoom.id, {
        user_jfs_bearer: userBearer,
      });
    } else {
      await api.endRoom(currentRoom.id);
    }
    await disconnect();
  }, [disconnect]);

  // Native audio session event listeners
  useEffect(() => {
    if (!AudioSessionModule) return;

    const emitter = new NativeEventEmitter(AudioSessionModule);

    const interruptionSub = emitter.addListener(
      "onAudioInterruption",
      (event: { type: "began" | "ended"; shouldResume?: boolean }) => {
        if (event.type === "ended" && event.shouldResume) {
          reconnect();
        }
      },
    );

    const routeChangeSub = emitter.addListener(
      "onRouteChange",
      (event: { reason: number; outputType: string }) => {
        console.log("[AudioSession] Route changed — output:", event.outputType);
      },
    );

    return () => {
      interruptionSub.remove();
      routeChangeSub.remove();
    };
  }, [reconnect]);

  // If a LiveKit room is already connected (e.g. from create flow)
  // but listeners aren't attached yet, attach them now.
  const attachListeners = useCallback(() => {
    const activeRoom = livekitService.getActiveRoom();
    if (activeRoom && !roomRef.current) {
      setupRoomListeners(activeRoom);
      const currentRoom = useSpaceStore.getState().room;
      if (currentRoom && !currentRoom.is_farcaster_native) {
        api
          .refreshRoomToken(currentRoom.id)
          .then(({ livekit_token, expires_at }) => {
            setToken(livekit_token, expires_at, livekitService.getActiveWsUrl());
          })
          .catch(() => {});
      }
      if (currentRoom?.is_farcaster_native && currentRoom.farcaster_room_id) {
        startHeartbeat(currentRoom.farcaster_room_id);
      }
    }
  }, [setupRoomListeners, setToken, startHeartbeat]);

  const setOnRoomEnded = useCallback((cb: () => void) => {
    onRoomEndedRef.current = cb;
  }, []);

  return {
    room: store.room,
    participants: store.participants,
    handQueue: store.handQueue,
    myRole: store.myRole,
    isConnected: store.isConnected,
    isMuted: store.isMuted,
    isHandRaised: store.isHandRaised,
    reactions,
    needsFarcasterSync,
    joinRoom,
    leaveRoom,
    connect,
    disconnect,
    toggleMute,
    sendReaction,
    startSpeaking,
    toggleRaiseHand,
    promoteParticipant,
    demoteParticipant,
    endRoom,
    attachListeners,
    setOnRoomEnded,
    // Stage invite (Farcaster-native rooms): pending invite (null when
    // nothing pending) + accept/decline actions. Poll lifecycle is
    // managed inside `useSpace` — callers just render the UI when
    // `pendingStageInvite` is non-null.
    pendingStageInvite,
    acceptStageInvite,
    declineStageInvite,
  };
}
