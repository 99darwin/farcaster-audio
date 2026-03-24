import { Room, RoomOptions, AudioSession } from '@livekit/react-native';

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

  const audioTrack = Array.from(
    localParticipant.audioTrackPublications.values(),
  )[0];

  if (audioTrack?.track) {
    if (audioTrack.isMuted) {
      await audioTrack.track.unmute();
      return false; // not muted anymore
    } else {
      await audioTrack.track.mute();
      return true; // now muted
    }
  }
  return false;
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
