import { useCallback, useState } from "react";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useAudioPlayerStore } from "@/stores/audioPlayerStore";

type PlaybackSpeed = 1 | 1.25 | 1.5 | 2;
const SPEEDS: PlaybackSpeed[] = [1, 1.25, 1.5, 2];

export function useVoiceNotePlayback(
  voiceNoteId: string,
  audioUrl: string,
  durationMs: number,
) {
  const { activeVoiceNoteId, setActive, clearActive } = useAudioPlayerStore();
  const isActive = activeVoiceNoteId === voiceNoteId;

  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  // Only load audio for the active voice note
  const player = useAudioPlayer(isActive ? audioUrl : null, {
    updateInterval: 100,
  });
  const status = useAudioPlayerStatus(player);

  const positionMs = isActive
    ? Math.round((status.currentTime ?? 0) * 1000)
    : 0;
  const isPlaying = isActive && status.playing;
  const isLoaded = isActive && status.isLoaded;

  const togglePlay = useCallback(() => {
    if (!isActive) {
      // Become the active voice note and start playing
      setActive(voiceNoteId, audioUrl, durationMs);
      // Player will load on next render; play is triggered after load
      return;
    }
    if (isPlaying) {
      player.pause();
    } else {
      player.play();
    }
  }, [
    isActive,
    isPlaying,
    player,
    voiceNoteId,
    audioUrl,
    durationMs,
    setActive,
  ]);

  const play = useCallback(() => {
    if (!isActive) {
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
      player.playbackRate = nextSpeed;
    }
  }, [speed, isActive, player]);

  // Auto-play when this note becomes active and player loads
  // (handled by the player loading the URL automatically)

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
