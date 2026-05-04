import { Room, type RoomOptions } from "livekit-client";
import { AudioSession } from "@livekit/react-native";
import { NativeModules } from "react-native";

const { AudioSessionModule } = NativeModules;

let activeRoom: Room | null = null;
let activeWsUrl: string | null = null;

const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: false,
  dynacast: false,
  publishDefaults: {
    audioPreset: {
      maxBitrate: 48_000,
    },
  },
};

export async function connectToRoom(
  wsUrl: string,
  token: string,
): Promise<Room> {
  // Start LiveKit audio session first
  await AudioSession.startAudioSession();

  const room = new Room(ROOM_OPTIONS);
  await room.connect(wsUrl, token, { autoSubscribe: true });

  // Configure native audio session AFTER LiveKit connects
  // so our settings aren't overridden
  if (AudioSessionModule) {
    await AudioSessionModule.configureForVoiceChat();
  }

  activeRoom = room;
  activeWsUrl = wsUrl;
  return room;
}

export async function disconnectFromRoom(): Promise<void> {
  if (activeRoom) {
    await activeRoom.disconnect();
    activeRoom = null;
  }
  activeWsUrl = null;
  if (AudioSessionModule) {
    await AudioSessionModule.deactivate();
  }
  await AudioSession.stopAudioSession();
}

export async function toggleMicrophone(): Promise<boolean> {
  const localParticipant = activeRoom?.localParticipant;
  if (!localParticipant) return false;

  const isCurrentlyEnabled = localParticipant.isMicrophoneEnabled;
  await localParticipant.setMicrophoneEnabled(!isCurrentlyEnabled);
  return isCurrentlyEnabled; // returns true (muted) when we just disabled
}

export async function enableMicrophone(): Promise<void> {
  const localParticipant = activeRoom?.localParticipant;
  if (!localParticipant) return;
  await localParticipant.setMicrophoneEnabled(true);
}

export async function disableMicrophone(): Promise<void> {
  const localParticipant = activeRoom?.localParticipant;
  if (!localParticipant) return;
  await localParticipant.setMicrophoneEnabled(false);
}

export async function sendReaction(key: string): Promise<void> {
  const localParticipant = activeRoom?.localParticipant;
  if (!localParticipant) return;

  const payload = new TextEncoder().encode(
    JSON.stringify({ type: "reaction", key }),
  );
  await localParticipant.publishData(payload, {
    topic: "reactions",
    reliable: false,
  });
}

export function getActiveRoom(): Room | null {
  return activeRoom;
}

export function getActiveWsUrl(): string | null {
  return activeWsUrl;
}
