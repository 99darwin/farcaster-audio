"use client";

import { useEffect, useRef } from "react";

const SEEK_BACK_SECONDS = 10;
const SEEK_FORWARD_SECONDS = 30;

interface RecordingAudioPlayerProps {
  audioUrl: string;
  title: string;
  hostName: string;
  artworkUrl?: string | null;
  className?: string;
}

/**
 * Native <audio controls> with Media Session API wiring.
 *
 * The Media Session metadata + action handlers are required for two
 * distinct reasons:
 *   1. iOS Safari needs them to keep the audio session alive when the
 *      tab is backgrounded or the device is locked. Without metadata
 *      iOS treats the page as silent and may suspend playback.
 *   2. Lock-screen / control-center / Bluetooth remote controls need
 *      action handlers (play/pause/seek) to drive the underlying
 *      <audio> element.
 *
 * The audio element itself owns transport state — we just register
 * handlers that delegate to it and update metadata when the source
 * changes. Cleanup clears handlers/metadata so a navigation away
 * doesn't leave stale info on the lock screen.
 */
export function RecordingAudioPlayer({
  audioUrl,
  title,
  hostName,
  artworkUrl,
  className,
}: RecordingAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;

    const artwork =
      artworkUrl
        ? [
            { src: artworkUrl, sizes: "256x256", type: "image/png" },
            { src: artworkUrl, sizes: "512x512", type: "image/png" },
          ]
        : [
            { src: "/app-icon.png", sizes: "512x512", type: "image/png" },
          ];

    ms.metadata = new MediaMetadata({
      title,
      artist: hostName,
      album: "Juke",
      artwork,
    });

    ms.setActionHandler("play", () => {
      audio.play().catch(() => {});
    });
    ms.setActionHandler("pause", () => {
      audio.pause();
    });
    ms.setActionHandler("seekbackward", (event) => {
      const offset = event.seekOffset ?? SEEK_BACK_SECONDS;
      audio.currentTime = Math.max(0, audio.currentTime - offset);
    });
    ms.setActionHandler("seekforward", (event) => {
      const offset = event.seekOffset ?? SEEK_FORWARD_SECONDS;
      audio.currentTime = Math.min(
        audio.duration || Number.MAX_SAFE_INTEGER,
        audio.currentTime + offset,
      );
    });
    ms.setActionHandler("seekto", (event) => {
      if (event.seekTime == null) return;
      audio.currentTime = event.seekTime;
    });

    const updatePosition = () => {
      if (!ms.setPositionState) return;
      if (!Number.isFinite(audio.duration)) return;
      try {
        ms.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: audio.currentTime,
        });
      } catch {
        // Some browsers throw on rapid updates; the next tick will recover.
      }
    };

    const handlePlay = () => {
      ms.playbackState = "playing";
      updatePosition();
    };
    const handlePause = () => {
      ms.playbackState = "paused";
      updatePosition();
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("timeupdate", updatePosition);
    audio.addEventListener("loadedmetadata", updatePosition);
    audio.addEventListener("ratechange", updatePosition);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("timeupdate", updatePosition);
      audio.removeEventListener("loadedmetadata", updatePosition);
      audio.removeEventListener("ratechange", updatePosition);
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("seekbackward", null);
      ms.setActionHandler("seekforward", null);
      ms.setActionHandler("seekto", null);
      ms.metadata = null;
      ms.playbackState = "none";
    };
  }, [audioUrl, title, hostName, artworkUrl]);

  return (
    <audio
      ref={audioRef}
      controls
      preload="metadata"
      src={audioUrl}
      className={className}
      controlsList="nodownload"
    />
  );
}
