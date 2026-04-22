import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules, NativeEventEmitter } from "react-native";
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
import type { ParticipantRole } from "@/types/space";
import { useReconnect } from "@/hooks/useReconnect";

const { AudioSessionModule } = NativeModules;

export function useSpace() {
  const store = useSpaceStore();
  const user = useAuthStore((s) => s.user);
  const roomRef = useRef<Room | null>(null);
  const { reconnect, setToken } = useReconnect();
  const reactionIdRef = useRef(0);
  const [reactions, setReactions] = useState<
    Array<{ key: string; id: number; fid: number }>
  >([]);
  const onRoomEndedRef = useRef<(() => void) | null>(null);

  const setupRoomListeners = useCallback(
    (room: Room) => {
      roomRef.current = room;

      room.on("participantConnected", (participant: RemoteParticipant) => {
        const fid = parseInt(participant.identity, 10);
        if (isNaN(fid)) return;
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
        const fid = parseInt(participant.identity, 10);
        store.removeParticipant(fid);
      });

      room.on(
        "trackMuted",
        (publication: TrackPublication, participant: Participant) => {
          const fid = parseInt(participant.identity, 10);
          store.updateParticipant(fid, { is_muted: true, is_speaking: false });
        },
      );

      room.on(
        "trackUnmuted",
        (publication: TrackPublication, participant: Participant) => {
          const fid = parseInt(participant.identity, 10);
          store.updateParticipant(fid, { is_muted: false });
        },
      );

      room.on(
        RoomEvent.ActiveSpeakersChanged,
        (activeSpeakers: Participant[]) => {
          const speakingFids = new Set(
            activeSpeakers.map((p) => parseInt(p.identity, 10)),
          );
          const allParticipants = useSpaceStore.getState().participants;
          for (const p of allParticipants) {
            const isSpeaking = speakingFids.has(p.fid);
            if (p.is_speaking !== isSpeaking) {
              store.updateParticipant(p.fid, { is_speaking: isSpeaking });
            }
          }
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

      // Detect role changes on remote participants via metadata updates
      room.on(
        RoomEvent.ParticipantMetadataChanged,
        (prevMetadata: string | undefined, participant: Participant) => {
          const fid = parseInt(participant.identity, 10);
          if (isNaN(fid)) return;
          try {
            const metadata = participant.metadata
              ? JSON.parse(participant.metadata)
              : {};
            if (metadata.role) {
              store.updateParticipant(fid, {
                role: metadata.role as ParticipantRole,
              });
            }
          } catch {
            // Ignore malformed metadata
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
              const senderFid = participant
                ? parseInt(participant.identity, 10)
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
                const roomId = useSpaceStore.getState().room?.id;
                if (roomId) {
                  api
                    .getRoom(roomId)
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
              const senderFid = parseInt(participant.identity, 10);
              if (!isNaN(senderFid)) {
                reactionIdRef.current += 1;
                setReactions((prev) => [
                  ...prev.slice(-19),
                  { key: data.key, id: reactionIdRef.current, fid: senderFid },
                ]);
              }
            }
          } catch {
            // Ignore malformed data messages
          }
        },
      );

      store.setConnected(true);
    },
    [store],
  );

  const connect = useCallback(
    async (roomId: string, token: string, wsUrl: string) => {
      const room = await livekitService.connectToRoom(wsUrl, token);
      setupRoomListeners(room);

      // Auto-enable mic for hosts/speakers/co-hosts
      const role = store.myRole;
      if (role === "host" || role === "co_host" || role === "speaker") {
        await livekitService.enableMicrophone();
        store.setMuted(false);
      }
    },
    [store, setupRoomListeners],
  );

  const disconnect = useCallback(async () => {
    try {
      await livekitService.disconnectFromRoom();
    } catch (e) {
      console.warn("[useSpace] LiveKit disconnect error:", e);
    }
    roomRef.current = null;
    store.leaveSpace();
  }, [store]);

  const joinRoom = useCallback(
    async (roomId: string) => {
      const response = await api.joinRoom(roomId);
      store.joinSpace(response.room, response.participants, response.role);
      await connect(roomId, response.livekit_token, response.livekit_ws_url);
      // Seed the reconnect engine with the initial token.
      // expires_at is not returned by /join, so pass empty string;
      // useReconnect will refresh proactively on the next minute-interval check.
      setToken(response.livekit_token, "");
      return response;
    },
    [connect, store, setToken],
  );

  const leaveRoom = useCallback(
    async (roomId: string) => {
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
    await livekitService.sendReaction(key);
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
    }
  }, [setupRoomListeners]);

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
    joinRoom,
    leaveRoom,
    connect,
    disconnect,
    toggleMute,
    sendReaction,
    startSpeaking,
    attachListeners,
    setOnRoomEnded,
  };
}
