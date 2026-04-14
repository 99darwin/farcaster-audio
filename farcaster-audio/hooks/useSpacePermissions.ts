import { useMemo } from "react";
import { useSpaceStore } from "@/stores/spaceStore";
import { useAuthStore } from "@/stores/authStore";
import type { ParticipantRole } from "@/types/space";

export function useSpacePermissions() {
  const myRole = useSpaceStore((s) => s.myRole);
  const room = useSpaceStore((s) => s.room);
  const user = useAuthStore((s) => s.user);

  const permissions = useMemo(() => {
    if (!myRole) {
      return {
        canPublishAudio: false,
        canSelfMute: false,
        canRaiseHand: false,
        canPromote: false,
        canDemote: false,
        canMuteOthers: false,
        canKick: false,
        canBan: false,
        canSetCohost: false,
        canEndRoom: false,
        canStartRecording: false,
        isHost: false,
        isCohost: false,
        isSpeaker: false,
        isListener: false,
      };
    }

    const isHost = myRole === "host";
    const isCohost = myRole === "co_host";
    const isSpeaker = myRole === "speaker";
    const isListener = myRole === "listener";

    return {
      canPublishAudio: isHost || isCohost || isSpeaker,
      canSelfMute: isHost || isCohost || isSpeaker,
      canRaiseHand: isListener,
      canPromote: isHost || isCohost,
      canDemote: isHost || isCohost,
      canMuteOthers: isHost || isCohost,
      canKick: isHost || isCohost,
      canBan: isHost || isCohost,
      canSetCohost: isHost,
      canEndRoom: isHost || isCohost,
      canStartRecording: isHost || isCohost,
      isHost,
      isCohost,
      isSpeaker,
      isListener,
    };
  }, [myRole]);

  const canActOnParticipant = useMemo(() => {
    return (targetRole: ParticipantRole) => {
      if (!myRole) return false;
      // Co-host cannot act on host
      if (myRole === "co_host" && targetRole === "host") return false;
      return myRole === "host" || myRole === "co_host";
    };
  }, [myRole]);

  return { ...permissions, canActOnParticipant };
}
