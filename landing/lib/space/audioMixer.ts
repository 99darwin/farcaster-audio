"use client";

/**
 * Browser audio mixer for the Juke web app.
 *
 * Sums multiple local audio sources (microphone, external input devices, and
 * captured computer/tab audio) through per-source GainNodes into a single
 * `MediaStreamAudioDestinationNode`, and publishes that ONE combined track to
 * LiveKit. Native app, miniapp, embed, and recording consumers therefore hear
 * the mix with zero changes — it's a normal single audio track.
 *
 * Design invariants:
 *  - The destination track is published EXACTLY ONCE (the first time a source is
 *    added) and reused. Adding/removing sources only rewires nodes — never
 *    republish, never renegotiate.
 *  - The mixer is the source of truth for the source list, gain, and mute; the
 *    zustand store mirrors it for React reactivity via `subscribeSources`.
 *  - `teardown()` releases every OS indicator (mic + screen-capture) by stopping
 *    all `MediaStreamTrack`s and disconnecting all nodes.
 *
 * The mixer shares the `AudioContext` singleton with `livekit.ts` so the iOS
 * unlock gesture and the mixing graph use one context.
 */

import { LocalAudioTrack, Track } from "livekit-client";
import type { TrackPublishOptions } from "livekit-client";
import { getSharedAudioContext, getActiveRoom } from "@/lib/space/livekit";

/** The kind of a mixer input source. */
export type SourceKind = "mic" | "device" | "system";

/** A single input channel in the mix (UI-facing, serializable shape). */
export interface AudioSource {
  /** Stable id for this source for the lifetime of the session. */
  id: string;
  kind: SourceKind;
  /** Human label (device name, "Computer audio", "Microphone"). */
  label: string;
  /** 0..1 fader position. */
  gain: number;
  /** Per-source mute (independent of gain). */
  muted: boolean;
}

/** Live per-source output level, keyed by source id. Values are 0..1. */
export type LevelMap = Record<string, number>;

/**
 * Thrown when the browser cannot capture computer/tab audio via
 * `getDisplayMedia` (Safari/Firefox). The UI maps this to a friendly inline
 * "not supported in this browser" state.
 */
export class SystemAudioUnsupportedError extends Error {
  constructor(message = "Computer audio capture is not supported in this browser.") {
    super(message);
    this.name = "SystemAudioUnsupportedError";
  }
}

// ---------------------------------------------------------------------------
// Internal graph state
// ---------------------------------------------------------------------------

/** Internal per-source record: the UI-facing shape plus live Web Audio nodes. */
interface SourceNode {
  id: string;
  kind: SourceKind;
  label: string;
  /** Fader position 0..1. Preserved across mute so unmute restores it. */
  gain: number;
  muted: boolean;
  stream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  analyser: AnalyserNode;
}

interface MixerGraph {
  ctx: AudioContext;
  master: GainNode;
  dest: MediaStreamAudioDestinationNode;
}

let graph: MixerGraph | null = null;
let publishedTrack: LocalAudioTrack | null = null;
/**
 * Which publish preset the mixed track is currently published with. Used to
 * drive the one-way voice→music upgrade in `reconcilePublishPreset` and to
 * guard against republish churn. `null` when nothing is published.
 */
let publishedMode: "voice" | "music" | null = null;

const sources = new Map<string, SourceNode>();
let sourceIdSeq = 0;

const sourceSubscribers = new Set<(sources: AudioSource[]) => void>();
const levelSubscribers = new Set<(levels: LevelMap) => void>();
let levelRafId: number | null = null;

// ---------------------------------------------------------------------------
// Capture constraints & publish presets
// ---------------------------------------------------------------------------

/** Voice processing chain — good for a talking mic, ruinous for music. */
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** No processing — line/device/system audio must pass through clean. */
const LINE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/** Current voice preset (mono, 48 kbps) — matches the pre-mixer behavior. */
const VOICE_PUBLISH_OPTIONS: TrackPublishOptions = {
  source: Track.Source.Microphone,
  name: "juke-mix",
  audioPreset: { maxBitrate: 48_000 },
  dtx: true,
  red: true,
};

/** Music-grade preset: stereo, 128 kbps, no DTX (silence-gating kills music). */
const MUSIC_PUBLISH_OPTIONS: TrackPublishOptions = {
  source: Track.Source.Microphone,
  name: "juke-mix",
  audioPreset: { maxBitrate: 128_000 },
  forceStereo: true,
  dtx: false,
  red: true,
};

// ---------------------------------------------------------------------------
// Snapshot / subscription plumbing
// ---------------------------------------------------------------------------

function toAudioSource(s: SourceNode): AudioSource {
  return { id: s.id, kind: s.kind, label: s.label, gain: s.gain, muted: s.muted };
}

function snapshot(): AudioSource[] {
  return Array.from(sources.values()).map(toAudioSource);
}

function emitSources(): void {
  const snap = snapshot();
  for (const cb of sourceSubscribers) {
    try {
      cb(snap);
    } catch {
      // A misbehaving subscriber must not break the others.
    }
  }
}

/**
 * Apply a source's effective output gain to its GainNode: 0 when muted,
 * otherwise its fader value. Uses `setTargetAtTime` for a short ramp so mutes
 * don't click.
 */
function applyGain(s: SourceNode): void {
  if (!graph) return;
  const target = s.muted ? 0 : s.gain;
  const now = graph.ctx.currentTime;
  s.gainNode.gain.setTargetAtTime(target, now, 0.01);
}

// ---------------------------------------------------------------------------
// Level metering (AnalyserNode + rAF), mirrors VoiceRecorder.tsx pattern
// ---------------------------------------------------------------------------

function computeLevel(analyser: AnalyserNode, buf: Uint8Array): number {
  analyser.getByteTimeDomainData(buf);
  // RMS of the centered (±128) waveform, normalized to 0..1.
  let sumSquares = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = (buf[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / buf.length);
  return Math.min(1, rms);
}

function runLevelLoop(): void {
  if (levelRafId !== null) return;
  if (typeof requestAnimationFrame === "undefined") return;

  const tick = () => {
    if (levelSubscribers.size === 0 || sources.size === 0) {
      levelRafId = null;
      return;
    }
    const levels: LevelMap = {};
    for (const s of sources.values()) {
      const buf = new Uint8Array(s.analyser.frequencyBinCount);
      // Report post-fader/mute level so the meter matches what listeners hear.
      const raw = computeLevel(s.analyser, buf);
      levels[s.id] = s.muted ? 0 : raw * s.gain;
    }
    for (const cb of levelSubscribers) {
      try {
        cb(levels);
      } catch {
        // Ignore a bad subscriber.
      }
    }
    levelRafId = requestAnimationFrame(tick);
  };

  levelRafId = requestAnimationFrame(tick);
}

function stopLevelLoop(): void {
  if (levelRafId !== null && typeof cancelAnimationFrame !== "undefined") {
    cancelAnimationFrame(levelRafId);
  }
  levelRafId = null;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** True if any active source is NOT the mic (music/line/system present). */
function hasNonMicSource(): boolean {
  for (const s of sources.values()) {
    if (s.kind !== "mic") return true;
  }
  return false;
}

/**
 * Publish the destination track exactly once, choosing the preset from the
 * source mix at publish time. Once published we never republish — see the
 * bitrate tradeoff note in the module header and the team report.
 */
async function ensurePublished(): Promise<void> {
  if (publishedTrack) return;
  if (!graph) return;
  const room = getActiveRoom();
  const localParticipant = room?.localParticipant;
  if (!localParticipant) return;

  const rawTrack = graph.dest.stream.getAudioTracks()[0];
  if (!rawTrack) return;

  const music = hasNonMicSource();
  const options = music ? MUSIC_PUBLISH_OPTIONS : VOICE_PUBLISH_OPTIONS;

  // Wrap as a user-provided LocalAudioTrack sharing our AudioContext so LiveKit
  // does not spin up a second context or reprocess the already-mixed audio.
  const localTrack = new LocalAudioTrack(rawTrack, undefined, true, graph.ctx);
  await localParticipant.publishTrack(localTrack, options);

  publishedTrack = localTrack;
  publishedMode = music ? "music" : "voice";
}

/**
 * One-way preset upgrade: if the mix is currently published as voice-grade but
 * now contains a non-mic (music/line/system) source, republish ONCE with the
 * music preset (128 kbps stereo, no DTX). This is deliberately monotonic —
 * it only ever goes voice→music, at most once per session, and never downgrades
 * back to voice — to avoid republish churn as sources toggle.
 *
 * CRITICAL: the published track wraps the mixer's live destination track. We
 * unpublish WITHOUT stopping it, then re-wrap the SAME destination track, so
 * the running mix is never interrupted.
 *
 * Safety: the upgrade must NEVER leave the host silently unpublished. The
 * publisher's audio is what upstream (e.g. Farcaster native rooms) uses to
 * detect host activity; a host with no live track reads as silent and the room
 * can be auto-ended for inactivity. So if the music-preset publish fails, we
 * restore the voice publication rather than sit with nothing published. A
 * re-entrancy guard prevents a burst of add-source calls from racing two
 * republishes.
 */
let reconciling = false;

async function reconcilePublishPreset(): Promise<void> {
  if (reconciling) return;
  if (!publishedTrack) return;
  if (publishedMode !== "voice") return;
  if (!hasNonMicSource()) return;
  if (!graph) return;

  const room = getActiveRoom();
  const localParticipant = room?.localParticipant;
  if (!localParticipant) return;

  const rawTrack = graph.dest.stream.getAudioTracks()[0];
  if (!rawTrack) return;

  reconciling = true;
  const oldTrack = publishedTrack;
  try {
    // stopOnUnpublish=false — the dest track is the live mixer output; stopping
    // it would kill the whole mix.
    await localParticipant.unpublishTrack(oldTrack, false);

    try {
      const musicTrack = new LocalAudioTrack(rawTrack, undefined, true, graph.ctx);
      await localParticipant.publishTrack(musicTrack, MUSIC_PUBLISH_OPTIONS);
      publishedTrack = musicTrack;
      publishedMode = "music";
    } catch {
      // Music-preset publish failed — restore the voice publication so the host
      // is never left silent. publishedMode stays "voice" so a later add-source
      // can retry the upgrade.
      const restored = new LocalAudioTrack(rawTrack, undefined, true, graph.ctx);
      await localParticipant.publishTrack(restored, VOICE_PUBLISH_OPTIONS);
      publishedTrack = restored;
    }
  } catch {
    // Unpublish failed (mix still published as voice), or the restore publish
    // also failed (extreme: the connection is likely broken and LiveKit's own
    // reconnect owns recovery). Log-free to match the file's style.
  } finally {
    reconciling = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Lazily build the mixing graph on the shared AudioContext. Idempotent. */
export function ensureMixer(): void {
  if (graph) return;
  const ctx = getSharedAudioContext();
  if (!ctx) {
    throw new Error("audioMixer: no AudioContext available in this browser.");
  }
  const master = ctx.createGain();
  master.gain.value = 1;
  const dest = ctx.createMediaStreamDestination();
  master.connect(dest);
  graph = { ctx, master, dest };
}

/**
 * Wire a captured MediaStream into the graph as a new source, publish (first
 * source only), notify subscribers, and start the level loop.
 */
function wireSource(
  kind: SourceKind,
  label: string,
  stream: MediaStream,
): string {
  if (!graph) throw new Error("audioMixer: graph not initialized.");
  const { ctx, master } = graph;

  const sourceNode = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;

  // source → gain → master (summed) and source → gain → analyser (metering).
  sourceNode.connect(gainNode);
  gainNode.connect(master);
  gainNode.connect(analyser);

  sourceIdSeq += 1;
  const id = `src-${sourceIdSeq}`;
  const record: SourceNode = {
    id,
    kind,
    label,
    gain: 1,
    muted: false,
    stream,
    sourceNode,
    gainNode,
    analyser,
  };
  sources.set(id, record);
  applyGain(record);

  // Stop-driven cleanup: if the OS/user ends the track (e.g. "stop sharing"
  // browser bar), remove the source so state stays consistent.
  stream.getAudioTracks().forEach((t) => {
    t.addEventListener("ended", () => {
      if (sources.has(id)) removeSource(id);
    });
  });

  return id;
}

/** Add the microphone as a source. Returns the new source id. */
export async function addMicSource(deviceId?: string): Promise<string> {
  ensureMixer();
  // If a mic already exists, don't add a duplicate — just unmute it.
  for (const s of sources.values()) {
    if (s.kind === "mic") {
      setMicMuted(false);
      return s.id;
    }
  }
  const audio: MediaTrackConstraints = { ...MIC_CONSTRAINTS };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const id = wireSource("mic", "Microphone", stream);
  await ensurePublished();
  emitSources();
  runLevelLoop();
  return id;
}

/** Add a selected input device (audio interface / DJ rig). Returns source id. */
export async function addDeviceSource(deviceId: string): Promise<string> {
  if (!deviceId) throw new Error("audioMixer: addDeviceSource requires a deviceId.");
  ensureMixer();
  const audio: MediaTrackConstraints = {
    ...LINE_CONSTRAINTS,
    deviceId: { exact: deviceId },
  };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const track = stream.getAudioTracks()[0];
  const label = track?.label || "Audio device";
  const id = wireSource("device", label, stream);
  await ensurePublished();
  await reconcilePublishPreset();
  emitSources();
  runLevelLoop();
  return id;
}

/**
 * Capture computer/tab audio via getDisplayMedia. Returns source id.
 * @throws {SystemAudioUnsupportedError} when the browser lacks support.
 */
export async function addSystemAudioSource(): Promise<string> {
  ensureMixer();
  const md = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  };
  if (typeof md.getDisplayMedia !== "function") {
    throw new SystemAudioUnsupportedError();
  }

  // Request video too — most browsers only surface a tab/window's audio when
  // video is also requested — then immediately drop the video track.
  let display: MediaStream;
  try {
    display = await md.getDisplayMedia({ audio: LINE_CONSTRAINTS, video: true });
  } catch (err) {
    // A user cancel (NotAllowedError) is a real cancel — rethrow it. Anything
    // else on a browser with weak support degrades to "unsupported".
    if (err instanceof DOMException && err.name === "NotAllowedError") throw err;
    throw new SystemAudioUnsupportedError();
  }

  // Stop and discard the video track immediately — we only want the audio.
  display.getVideoTracks().forEach((t) => {
    t.stop();
    display.removeTrack(t);
  });

  const audioTracks = display.getAudioTracks();
  if (audioTracks.length === 0) {
    // Browser prompted but shared no audio (e.g. Safari, or the user didn't
    // tick "share tab audio"). Nothing to mix.
    throw new SystemAudioUnsupportedError(
      "No computer audio was shared. Pick a tab and enable “Share tab audio.”",
    );
  }

  // Rebuild a clean audio-only stream for the graph.
  const audioStream = new MediaStream(audioTracks);
  const id = wireSource("system", "Computer audio", audioStream);
  await ensurePublished();
  await reconcilePublishPreset();
  emitSources();
  runLevelLoop();
  return id;
}

/** Remove a source, stop its MediaStreamTrack, and unwire its nodes. */
export function removeSource(id: string): void {
  const s = sources.get(id);
  if (!s) return;
  try {
    s.sourceNode.disconnect();
  } catch {
    // Already disconnected.
  }
  try {
    s.gainNode.disconnect();
  } catch {
    // Already disconnected.
  }
  try {
    s.analyser.disconnect();
  } catch {
    // Already disconnected.
  }
  s.stream.getTracks().forEach((t) => t.stop());
  sources.delete(id);
  emitSources();
  if (sources.size === 0) stopLevelLoop();
}

/** Set a source's fader position (0..1). Clamped. */
export function setSourceGain(id: string, gain: number): void {
  const s = sources.get(id);
  if (!s) return;
  const clamped = Math.max(0, Math.min(1, gain));
  s.gain = clamped;
  applyGain(s);
  emitSources();
}

/** Per-source mute toggle. Preserves the fader value for restore on unmute. */
export function setSourceMuted(id: string, muted: boolean): void {
  const s = sources.get(id);
  if (!s || s.muted === muted) return;
  s.muted = muted;
  applyGain(s);
  emitSources();
}

/**
 * Mute/unmute the microphone source specifically (drives the main Controls
 * mute button). Leaves music/line sources playing. No-op when no mic source
 * exists yet.
 */
export function setMicMuted(muted: boolean): void {
  let changed = false;
  for (const s of sources.values()) {
    if (s.kind !== "mic") continue;
    if (s.muted !== muted) {
      s.muted = muted;
      applyGain(s);
      changed = true;
    }
  }
  if (changed) emitSources();
}

/** Current snapshot of all sources. */
export function listSources(): AudioSource[] {
  return snapshot();
}

/** The single published mixed track, or null if nothing is publishing yet. */
export function getPublishedTrack(): LocalAudioTrack | null {
  return publishedTrack;
}

/**
 * True when the mixer is publishing and at least one source is live (unmuted,
 * fader above zero) — i.e. the host intends to be producing audio right now.
 *
 * Intent-based on purpose: it does NOT sample instantaneous levels, so it stays
 * correct when the browser tab is backgrounded (where rAF-driven metering
 * throttles) and doesn't flap on brief musical rests. Callers use it to gate
 * the Farcaster host-activity heartbeat.
 */
export function isProducingAudio(): boolean {
  if (!publishedTrack) return false;
  for (const s of sources.values()) {
    if (!s.muted && s.gain > 0) return true;
  }
  return false;
}

/** Stop every source, unpublish, and release OS mic/screen-capture indicators. */
export function teardown(): void {
  stopLevelLoop();

  // Unpublish the mixed track (best-effort) and stop it.
  if (publishedTrack) {
    const room = getActiveRoom();
    const localParticipant = room?.localParticipant;
    const track = publishedTrack;
    if (localParticipant) {
      // unpublishTrack(track, stopOnUnpublish=true) stops the sender track too.
      localParticipant.unpublishTrack(track, true).catch(() => {});
    } else {
      track.stop();
    }
    publishedTrack = null;
    publishedMode = null;
  }

  // Stop + disconnect every source.
  for (const s of sources.values()) {
    try {
      s.sourceNode.disconnect();
    } catch {
      // Ignore.
    }
    try {
      s.gainNode.disconnect();
    } catch {
      // Ignore.
    }
    try {
      s.analyser.disconnect();
    } catch {
      // Ignore.
    }
    s.stream.getTracks().forEach((t) => t.stop());
  }
  sources.clear();

  // Tear down the graph nodes (but NOT the shared AudioContext — livekit.ts
  // owns its lifecycle and reuses it for the unlock gesture on the next join).
  if (graph) {
    try {
      graph.master.disconnect();
    } catch {
      // Ignore.
    }
    try {
      graph.dest.disconnect();
    } catch {
      // Ignore.
    }
    graph = null;
  }

  emitSources();
  sourceSubscribers.clear();
  levelSubscribers.clear();
}

/**
 * Subscribe to source-list changes (add/remove/gain/mute). Fires with the
 * current snapshot immediately on subscribe. Returns an unsubscribe fn.
 */
export function subscribeSources(cb: (sources: AudioSource[]) => void): () => void {
  sourceSubscribers.add(cb);
  try {
    cb(snapshot());
  } catch {
    // Ignore a throwing initial callback.
  }
  return () => {
    sourceSubscribers.delete(cb);
  };
}

/**
 * Subscribe to live per-source output levels for meters. Fires on an animation
 * cadence while publishing. Returns an unsubscribe fn.
 */
export function subscribeLevels(cb: (levels: LevelMap) => void): () => void {
  levelSubscribers.add(cb);
  if (sources.size > 0) runLevelLoop();
  return () => {
    levelSubscribers.delete(cb);
    if (levelSubscribers.size === 0) stopLevelLoop();
  };
}
