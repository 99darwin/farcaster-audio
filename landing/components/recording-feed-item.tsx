"use client";

import { useState } from "react";
import {
  formatRecordingDuration,
  type RecordingFeedItem as RecordingFeedItemType,
} from "@/lib/recordings";
import { formatTimestamp } from "@/lib/voice-notes";

interface RecordingFeedItemProps {
  item: RecordingFeedItemType;
}

export function RecordingFeedItem({ item }: RecordingFeedItemProps) {
  const { recording, host } = item;
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-white/10">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-white/5"
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
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold">
            {host.display_name.charAt(0).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white/90">
            {recording.title}
          </p>
          <p className="truncate text-xs text-white/50">@{host.username}</p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-xs font-medium tabular-nums text-white/60">
            {formatRecordingDuration(recording.duration_seconds)}
          </p>
          <p className="text-[10px] text-white/30">
            {formatTimestamp(recording.started_at)}
          </p>
        </div>
      </button>

      {isOpen && (
        <div className="px-4 pb-3">
          <audio
            controls
            preload="none"
            src={recording.recording_url}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}
