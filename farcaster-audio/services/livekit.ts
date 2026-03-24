import { AudioSession } from '@livekit/react-native';
import { Room, type RoomOptions } from 'livekit-client';

let activeRoom: Room | null = null;

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
  // Start LiveKit audio session
  await AudioSession.startAudioSession();

  const room = new Room(ROOM_OPTIONS);
  await room.connect(wsUrl, token, { autoSubscribe: true });
  activeRoom = room;
  return room;
}

export async function disconnectFromRoom(): Promise<void> {
  if (activeRoom) {
    await activeRoom.disconnect();
    activeRoom = null;
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

export function getActiveRoom(): Room | null {
  return activeRoom;
}
