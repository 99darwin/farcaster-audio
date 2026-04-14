"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Waveform,
  downsamplePeaks,
  BAR_COUNT,
} from "@/components/waveform";

interface WebPlayerProps {
  audioUrl: string;
  durationMs: number;
  waveformPeaks: number[] | null;
}

function formatTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}:${remainSecs.toString().padStart(2, "0")}`;
}

export function WebPlayer({
  audioUrl,
  durationMs,
  waveformPeaks,
}: WebPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const rafRef = useRef<number>(0);

  const peaks = waveformPeaks
    ? waveformPeaks
    : Array.from({ length: BAR_COUNT }, () => Math.random() * 0.6 + 0.1);

  const progress = durationMs > 0 ? currentTimeMs / durationMs : 0;

  const updateTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTimeMs(audio.currentTime * 1000);
    if (!audio.paused) {
      rafRef.current = requestAnimationFrame(updateTime);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      await audio.play();
      setIsPlaying(true);
      rafRef.current = requestAnimationFrame(updateTime);
    } else {
      audio.pause();
      setIsPlaying(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }
  }, [updateTime]);

  const handleSeek = useCallback(
    (fraction: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = (fraction * durationMs) / 1000;
      setCurrentTimeMs(fraction * durationMs);
    },
    [durationMs],
  );

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    setCurrentTimeMs(0);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    setIsLoaded(true);
  }, []);

  return (
    <div>
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onEnded={handleEnded}
        onLoadedMetadata={handleLoadedMetadata}
      />

      {/* Waveform + play button row */}
      <div className="flex items-center gap-4">
        {/* Play/Pause button */}
        <button
          onClick={togglePlay}
          disabled={!isLoaded && !audioUrl}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-juke-orange text-white transition-colors hover:bg-juke-orange-hover focus-visible:ring-2 focus-visible:ring-juke-orange focus-visible:ring-offset-2 focus-visible:ring-offset-juke-surface disabled:opacity-40"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0a.75.75 0 0 1 .75-.75H16.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="ml-0.5 h-5 w-5"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </button>

        {/* Waveform visualization */}
        <div className="flex-1">
          <Waveform peaks={peaks} progress={progress} onSeek={handleSeek} />
        </div>
      </div>

      {/* Time display */}
      <div className="mt-2 flex items-center justify-between text-xs tabular-nums text-juke-text-on-dark-tertiary">
        <span>{formatTime(currentTimeMs)}</span>
        <span>{formatTime(durationMs)}</span>
      </div>
    </div>
  );
}
