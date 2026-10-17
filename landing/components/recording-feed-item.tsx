"use client";

import { useState } from "react";
import {
  formatRecordingDuration,
  type RecordingFeedItem as RecordingFeedItemType,
} from "@/lib/recordings";
import { formatTimestamp } from "@/lib/voice-notes";
import { RecordingAudioPlayer } from "@/components/recording-audio-player";

interface RecordingFeedItemProps {
  item: RecordingFeedItemType;
  /**
   * Optional "Part N of M" hint, populated by the feed page only when
   * a space has more than one finalized segment. Single-segment
   * recordings render without the badge to keep the common case clean.
   */
  partInfo?: { index: number; total: number };
}

/**
 * List row for a single recorded space segment.
 *
 * Tapping the row expands an inline `RecordingAudioPlayer`; a second
 * tap collapses it. The row itself is never a navigation link so that
 * the player can be used without leaving the profile / feed screen.
 * A dedicated share link to `/miniapp/r/<id>` is shown inside the
 * expanded player area for users who want the standalone view.
 */
export function RecordingFeedItem({ item, partInfo }: RecordingFeedItemProps) {
  const { recording, host } = item;
  const [expanded, setExpanded] = useState(false);

  // Prefer the segment UUID for routing — getRecording() tries the
  // canonical /by-id/ endpoint first. Falls back to room_id for
  // legacy rows so existing shared links keep resolving.
  const linkId = recording.id ?? recording.room_id;

  return (
    <div className="border-b border-white/10">
      {/* Collapsed row — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-white/5"
        aria-expanded={expanded}
      >
        {host.pfp_url ? (
          <img
            src={host.pfp_url}
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-white/70">
            {host.display_name.charAt(0).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-white/90">
              {recording.title}
            </p>
            {partInfo ? (
              <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white/60">
                Part {partInfo.index} of {partInfo.total}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-white/50">@{host.username}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="text-xs font-medium tabular-nums text-white/60">
              {formatRecordingDuration(recording.duration_seconds)}
            </p>
            <p className="text-[10px] text-white/30">
              {formatTimestamp(recording.started_at)}
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
        <div className="px-4 pb-4">
          <RecordingAudioPlayer
            audioUrl={recording.recording_url}
            title={recording.title}
            hostName={host.username}
            recordedAt={recording.started_at}
            durationSeconds={recording.duration_seconds}
            artworkUrl={host.pfp_url}
          />
          <a
            href={`/miniapp/r/${encodeURIComponent(linkId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block text-center text-[11px] text-white/30 underline underline-offset-2 hover:text-white/50"
          >
            Open standalone player
          </a>
        </div>
      )}
    </div>
  );
}
