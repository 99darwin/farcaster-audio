"use client";

/**
 * Browser LiveKit service for the Juke web app.
 *
 * Ported from `farcaster-audio/services/livekit.ts`, dropping all React-Native
 * `AudioSession`/native-module plumbing. On the web, remote audio is rendered
 * by attaching subscribed tracks to hidden `<audio playsinline>` elements
 * appended to `document.body` — they persist across route re-renders so audio
 * keeps playing while the user navigates (the mini-bar experience).
 *
 * The `activeRoom` / `activeWsUrl` module singletons are the durable handle to
 * the connection: together with the zustand store they let the session outlive
 * any single React component mount.
 */

import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import type { RoomOptions } from "livekit-client";
import * as audioMixer from "@/lib/space/audioMixer";

let activeRoom: Room | null = null;
let activeWsUrl: string | null = null;
let audioCtx: AudioContext | null = null;

const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: false,
  publishDefaults: {
    audioPreset: {
      maxBitrate: 48_000,
    },
  },
};

/** Marks the hidden audio elements we own so we can clean them up on leave. */
const AUDIO_EL_MARKER = "data-juke-space-audio";

function handleTrackSubscribed(track: RemoteTrack): void {
  if (track.kind !== Track.Kind.Audio) return;
  const el = track.attach();
  el.setAttribute("playsinline", "true");
  el.setAttribute(AUDIO_EL_MARKER, "true");
  // Mounted but invisible — playback was unlocked by the join gesture.
  el.style.display = "none";
  document.body.appendChild(el);
}

function handleTrackUnsubscribed(track: RemoteTrack): void {
  track.detach().forEach((el) => el.remove());
}

function removeOrphanAudioElements(): void {
  if (typeof document === "undefined") return;
  document
    .querySelectorAll(`audio[${AUDIO_EL_MARKER}]`)
    .forEach((el) => el.remove());
}

/**
 * Synchronously unlock browser audio inside a user gesture. iOS/Safari require
 * the `AudioContext` to be created + resumed in the same task as the tap that
 * initiates playback, so the space screen calls this at the very top of its
 * join handler (before any `await`).
 */
export function unlockAudioContext(): void {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return;
  const ctx = new AudioCtx();
  audioCtx = ctx;
  const buffer = ctx.createBuffer(1, 1, 22050);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

/**
 * The shared `AudioContext` singleton used for both the iOS unlock gesture and
 * the mixing graph. Lazily created here (outside a gesture) if the unlock path
 * hasn't run yet — but callers that publish should prefer to run
 * {@link unlockAudioContext} inside a user gesture first so autoplay/iOS is
 * satisfied. Returns null only when the browser lacks `AudioContext`.
 */
export function getSharedAudioContext(): AudioContext | null {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;
  audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

/**
 * Ask LiveKit to (re)start audio playback. Must run inside a user gesture on
 * browsers that block autoplay; safe to call repeatedly.
 */
export async function startAudioPlayback(): Promise<void> {
  if (activeRoom && !activeRoom.canPlaybackAudio) {
    try {
      await activeRoom.startAudio();
    } catch {
      // Autoplay still blocked — the caller can retry on the next gesture.
    }
  }
}

export async function connectToRoom(
  wsUrl: string,
  token: string,
): Promise<Room> {
  // If a stale room is lingering, tear it down first so we never leak a
  // second connection into the singleton.
  if (activeRoom) {
    try {
      await activeRoom.disconnect();
    } catch {
      // Ignore.
    }
    activeRoom = null;
  }

  const room = new Room(ROOM_OPTIONS);
  // Register audio attach/detach BEFORE connect so already-published tracks
  // subscribed during `connect` are captured.
  room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

  await room.connect(wsUrl, token, { autoSubscribe: true });

  activeRoom = room;
  activeWsUrl = wsUrl;

  // Kick playback now that we're connected (join tap is the gesture).
  await startAudioPlayback();

  return room;
}

export async function disconnectFromRoom(): Promise<void> {
  // Tear down the local mixing graph FIRST so OS mic/screen-capture indicators
  // release and the mixed track is unpublished while we still hold the room.
  try {
    audioMixer.teardown();
  } catch {
    // Ignore — never block disconnect on mixer cleanup.
  }
  if (activeRoom) {
    try {
      await activeRoom.disconnect();
    } catch {
      // Ignore — we still clear the singleton + audio elements below.
    }
    activeRoom = null;
  }
  activeWsUrl = null;
  removeOrphanAudioElements();
}

/**
 * Toggle the local mic through the mixer. Returns the resulting muted state
 * (true = muted) so callers can mirror it into the store. May throw
 * `NotAllowedError` on the first enable if the user denies the mic prompt.
 *
 * Muting only silences the mic source (via GainNode) — any music/line/system
 * sources keep playing, which is the DJ-desirable behavior. The published
 * mixed track is never toggled or renegotiated.
 */
export async function toggleMicrophone(): Promise<boolean> {
  if (!activeRoom?.localParticipant) return true;

  // Determine current mic-mute state from the mixer's source list.
  const micSource = audioMixer
    .listSources()
    .find((s) => s.kind === "mic");

  if (!micSource) {
    // No mic yet — first unmute: create + publish it. May throw NotAllowedError.
    await audioMixer.addMicSource();
    audioMixer.setMicMuted(false);
    return false;
  }

  const nextMuted = !micSource.muted;
  audioMixer.setMicMuted(nextMuted);
  return nextMuted;
}

/**
 * Enable the mic: build the mixer, capture the mic, and publish the mixed
 * destination track (once). Idempotent — re-enabling an existing mic just
 * unmutes it. May throw `NotAllowedError` if the mic prompt is denied.
 */
export async function enableMicrophone(): Promise<void> {
  if (!activeRoom?.localParticipant) return;
  audioMixer.ensureMixer();
  await audioMixer.addMicSource();
  audioMixer.setMicMuted(false);
}

/**
 * Disable the mic by muting its source (gain→0). Any other sources keep
 * playing; the mixed track stays published. Full teardown happens on leave via
 * {@link disconnectFromRoom}.
 */
export async function disableMicrophone(): Promise<void> {
  if (!activeRoom?.localParticipant) return;
  audioMixer.setMicMuted(true);
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

/**
 * Parse a participant fid from a LiveKit identity, accepting both encodings we
 * connect to: Juke-hosted rooms use the bare stringified fid (`"3621"`), while
 * Farcaster-native rooms (Farcaster's own LiveKit project) prefix it as
 * `"fid:<n>"`. Returns null for anything else (agents, service identities).
 */
export function parseParticipantFid(
  identity: string | undefined,
): number | null {
  if (!identity) return null;
  const raw = identity.startsWith("fid:") ? identity.slice(4) : identity;
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getActiveRoom(): Room | null {
  return activeRoom;
}

export function getActiveWsUrl(): string | null {
  return activeWsUrl;
}
