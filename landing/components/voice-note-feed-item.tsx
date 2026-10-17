"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatDuration,
  formatTimestamp,
  type VoiceNoteDetail,
} from "@/lib/voice-notes";

const SEEK_BACK_SECONDS = 10;
const SEEK_FORWARD_SECONDS = 30;

interface VoiceNoteFeedItemProps {
  item: VoiceNoteDetail;
}

/**
 * Feed row for a single voice note.
 *
 * Clicking the row expands an inline `<audio controls>` player; a second
 * click collapses it. The row is never a navigation link — voice notes play
 * in-place. A secondary "Open in miniapp" anchor is shown below the player
 * for users who want the full standalone view.
 *
 * Information hierarchy mirrors the mobile VoiceNoteFeedItem:
 *   1. Author row — avatar · display name · @username · timestamp
 *   2. Caption (if present)
 *   3. Inline audio player (native <audio controls> + Media Session)
 *   4. Reaction / play counts (read-only)
 *   5. "Open in miniapp" link
 */
export function VoiceNoteFeedItem({ item }: VoiceNoteFeedItemProps) {
  const { voice_note, author, reaction_counts, play_count } = item;
  const [expanded, setExpanded] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Wire up the Media Session API so lock-screen / Bluetooth controls work
  // and iOS Safari keeps the audio session alive when the tab is backgrounded.
  useEffect(() => {
    if (!expanded) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }

    const ms = navigator.mediaSession;
    const isAbsoluteUrl =
      author.pfp_url != null && /^https?:\/\//i.test(author.pfp_url);
    const artwork = isAbsoluteUrl
      ? [
          { src: author.pfp_url!, sizes: "256x256", type: "image/png" },
          { src: author.pfp_url!, sizes: "512x512", type: "image/png" },
        ]
      : [{ src: "/app-icon.png", sizes: "512x512", type: "image/png" }];

    ms.metadata = new MediaMetadata({
      title: voice_note.caption ?? "Voice note",
      artist: author.username,
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
      audio.pause();
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
  }, [expanded, voice_note.audio_url, voice_note.caption, author.pfp_url, author.username]);

  const likeCount = reaction_counts?.like ?? 0;

  return (
    <div className="border-b border-white/10">
      {/* Collapsed row — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-white/5"
        aria-expanded={expanded}
        aria-controls={`vnote-${voice_note.id}`}
        aria-label={`${expanded ? "Collapse" : "Play"} voice note by ${author.display_name}`}
      >
        {/* Author avatar */}
        {author.pfp_url ? (
          <img
            src={author.pfp_url}
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-white/70">
            {(author.display_name || author.username || "?").charAt(0).toUpperCase()}
          </div>
        )}

        {/* Author name + username */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white/90">
            {author.display_name}
          </p>
          <p className="truncate text-xs text-white/50">@{author.username}</p>
        </div>

        {/* Duration + timestamp + chevron */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="text-xs font-medium tabular-nums text-white/60">
              {formatDuration(voice_note.duration_ms)}
            </p>
            <p className="text-[10px] text-white/30">
              {formatTimestamp(voice_note.created_at)}
            </p>
          </div>
          {/* Chevron indicator */}
          <svg
            className={`h-4 w-4 shrink-0 text-white/30 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </button>

      {/* Expanded inline player */}
      {expanded && (
        <div id={`vnote-${voice_note.id}`} className="px-4 pb-4">
          {/* Caption */}
          {voice_note.caption && (
            <p className="mb-3 text-sm text-white/70">{voice_note.caption}</p>
          )}

          {/* Native audio player */}
          <audio
            ref={audioRef}
            controls
            preload="metadata"
            src={voice_note.audio_url}
            controlsList="nodownload"
            className="w-full"
            style={{ colorScheme: "dark" }}
          />

          {/* Reaction / play counts (read-only) */}
          {(likeCount > 0 || play_count > 0) && (
            <div className="mt-2 flex items-center gap-4">
              {likeCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-white/40">
                  {/* Heart icon */}
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"
                    />
                  </svg>
                  {likeCount}
                </span>
              )}
              {play_count > 0 && (
                <span className="flex items-center gap-1 text-xs text-white/40">
                  {/* Play icon */}
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"
                    />
                  </svg>
                  {play_count}
                </span>
              )}
            </div>
          )}

          {/* Secondary standalone link */}
          <a
            href={`/miniapp/v/${encodeURIComponent(voice_note.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block text-center text-[11px] text-white/30 underline underline-offset-2 hover:text-white/50"
          >
            Open in miniapp
          </a>
        </div>
      )}
    </div>
  );
}
