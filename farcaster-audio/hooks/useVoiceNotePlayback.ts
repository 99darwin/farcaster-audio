import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { requireNativeModule } from "expo-modules-core";
import { useAudioPlayerStore } from "@/stores/audioPlayerStore";
import { recordPlay } from "@/services/voiceNotes";

const AudioSession = requireNativeModule("AudioSessionModule");

type PlaybackSpeed = 1 | 1.25 | 1.5 | 2;
const SPEEDS: PlaybackSpeed[] = [1, 1.25, 1.5, 2];
const ACTIVE_STATUS_INTERVAL_MS = 250;

export function useVoiceNotePlayback(
  voiceNoteId: string,
  audioUrl: string,
  durationMs: number,
) {
  const { activeVoiceNoteId, setActive, clearActive } = useAudioPlayerStore();
  const isActive = activeVoiceNoteId === voiceNoteId;

  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const playTrackedRef = useRef(false);

  // Only load audio for the active voice note
  const player = useAudioPlayer(isActive ? audioUrl : null, {
    updateInterval: ACTIVE_STATUS_INTERVAL_MS,
  });
  const status = useAudioPlayerStatus(player);

  const positionMs = isActive
    ? Math.round((status.currentTime ?? 0) * 1000)
    : 0;
  const isPlaying = isActive && status.playing;
  const isLoaded = isActive && status.isLoaded;

  const isFinished = isActive && !status.playing && positionMs >= durationMs - 200;

  // Reset play tracking when voice note changes
  useEffect(() => {
    if (!isActive) playTrackedRef.current = false;
  }, [isActive]);

  // Configure audio session when a voice note becomes active
  // and play once loaded (user already tapped play to activate)
  const wantsPlayRef = useRef(false);
  useEffect(() => {
    if (isActive) {
      AudioSession.configureForPlayback().catch(() => {});
    } else {
      wantsPlayRef.current = false;
    }
  }, [isActive]);

  useEffect(() => {
    if (isActive && isLoaded && wantsPlayRef.current) {
      wantsPlayRef.current = false;
      player.play();
    }
  }, [isActive, isLoaded, player]);

  // Recordings (space playback) reuse this hook with a `recording:<uuid>`
  // id prefix so they share the single-active-player state with voice
  // notes. The voice-notes analytics endpoint only accepts bare UUIDs,
  // and we don't track recording plays yet, so skip the beacon.
  const isRecording = voiceNoteId.startsWith("recording:");

  // Track play after 3 seconds of listening
  useEffect(() => {
    if (isActive && positionMs >= 3000 && !playTrackedRef.current) {
      playTrackedRef.current = true;
      if (!isRecording) {
        recordPlay(voiceNoteId, positionMs, false).catch(() => {});
      }
    }
  }, [isActive, positionMs, voiceNoteId, isRecording]);

  // Track completion
  useEffect(() => {
    if (isFinished && playTrackedRef.current && !isRecording) {
      recordPlay(voiceNoteId, durationMs, true).catch(() => {});
    }
  }, [isFinished, voiceNoteId, durationMs, isRecording]);

  const togglePlay = useCallback(() => {
    if (!isActive) {
      // Become the active voice note; play will start once loaded
      wantsPlayRef.current = true;
      setActive(voiceNoteId, audioUrl, durationMs);
      return;
    }
    if (isPlaying) {
      player.pause();
    } else {
      // If finished, seek to start before replaying
      if (isFinished) {
        player.seekTo(0);
        playTrackedRef.current = false;
      }
      player.play();
    }
  }, [
    isActive,
    isPlaying,
    isFinished,
    player,
    voiceNoteId,
    audioUrl,
    durationMs,
    setActive,
  ]);

  const play = useCallback(() => {
    if (!isActive) {
      wantsPlayRef.current = true;
      setActive(voiceNoteId, audioUrl, durationMs);
      return;
    }
    player.play();
  }, [isActive, player, voiceNoteId, audioUrl, durationMs, setActive]);

  const pause = useCallback(() => {
    if (!isActive) return;
    player.pause();
  }, [isActive, player]);

  const seekTo = useCallback(
    (ms: number) => {
      if (!isActive) return;
      player.seekTo(ms / 1000);
    },
    [isActive, player],
  );

  const cycleSpeed = useCallback(() => {
    const currentIdx = SPEEDS.indexOf(speed);
    const nextSpeed = SPEEDS[(currentIdx + 1) % SPEEDS.length];
    setSpeed(nextSpeed);
    if (isActive) {
      player.setPlaybackRate(nextSpeed);
    }
  }, [speed, isActive, player]);

  return {
    isPlaying,
    isLoaded,
    positionMs,
    durationMs,
    speed,
    play,
    pause,
    togglePlay,
    seekTo,
    cycleSpeed,
    progress: durationMs > 0 ? positionMs / durationMs : 0,
  };
}
