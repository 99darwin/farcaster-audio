"use client";

import { useEffect, useRef } from "react";
import { formatRecordingDuration } from "@/lib/recordings";

const SEEK_BACK_SECONDS = 10;
const SEEK_FORWARD_SECONDS = 30;

interface RecordingAudioPlayerProps {
  audioUrl: string;
  title: string;
  hostName: string;
  /**
   * ISO date string for the recording (used for the timestamp display).
   * Optional — omit to suppress the date line.
   */
  recordedAt?: string | null;
  /**
   * Duration in seconds — shown next to the date. Optional.
   */
  durationSeconds?: number | null;
  artworkUrl?: string | null;
  className?: string;
}

/**
 * Styled recording player card for the profile / feed context.
 *
 * Renders:
 *   • Avatar / artwork + title + host row (metadata header)
 *   • Duration + recorded-date sub-row
 *   • Native <audio controls> wired to the Media Session API for
 *     lock-screen / Bluetooth remote controls + iOS background audio.
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
  recordedAt,
  durationSeconds,
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

    // Only pass artworkUrl to MediaMetadata when it is an absolute URL.
    // Relative paths would be rejected by the Media Session API in most
    // browsers; better to fall back to the known-good app icon.
    const isAbsoluteUrl =
      artworkUrl != null && /^https?:\/\//i.test(artworkUrl);
    const artwork = isAbsoluteUrl
      ? [
          { src: artworkUrl, sizes: "256x256", type: "image/png" },
          { src: artworkUrl, sizes: "512x512", type: "image/png" },
        ]
      : [{ src: "/app-icon.png", sizes: "512x512", type: "image/png" }];

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

  const formattedDate = recordedAt ? formatShortDate(recordedAt) : null;

  return (
    <div
      className={`rounded-lg border border-white/10 bg-white/5 p-3 ${className ?? ""}`}
    >
      {/* Metadata header */}
      <div className="mb-3 flex items-center gap-3">
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-white/70">
            {hostName.charAt(0).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white/90">{title}</p>
          <p className="truncate text-xs text-white/50">@{hostName}</p>
        </div>

        {(durationSeconds != null || formattedDate) && (
          <div className="shrink-0 text-right">
            {durationSeconds != null && (
              <p className="text-xs font-medium tabular-nums text-white/60">
                {formatRecordingDuration(durationSeconds)}
              </p>
            )}
            {formattedDate && (
              <p className="text-[10px] text-white/30">{formattedDate}</p>
            )}
          </div>
        )}
      </div>

      {/* Native audio controls */}
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={audioUrl}
        controlsList="nodownload"
        className="w-full"
        style={{ colorScheme: "dark" }}
      />
    </div>
  );
}

/** Format an ISO date string as "Jan 5" or "Jan 5, 2024" for older dates. */
function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    // new Date("") and new Date("invalid") return NaN-dates — they do NOT throw.
    // Guard explicitly so we return "" rather than the string "Invalid Date".
    if (!Number.isFinite(d.getTime())) return "";
    const now = new Date();
    // Use UTC year to avoid the timezone-crossing bug: date-only ISO strings
    // (e.g. "2026-01-01") parse as UTC midnight, so getFullYear() returns the
    // prior day's year in negative-UTC-offset locales. UTC year matches intent.
    const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  } catch {
    return "";
  }
}
