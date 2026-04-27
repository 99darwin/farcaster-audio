"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { jukeRecordingUrl } from "@/lib/deeplink";
import { safeImageUrl } from "@/lib/safe-url";
import {
  formatRecordingDuration,
  type RecordingFeedItem,
} from "@/lib/recordings";
import { formatTimestamp } from "@/lib/voice-notes";

interface MiniAppRecordingPlayerProps {
  data: RecordingFeedItem;
}

export function MiniAppRecordingPlayer({ data }: MiniAppRecordingPlayerProps) {
  const { recording, host } = data;

  const [isAdded, setIsAdded] = useState(false);

  useEffect(() => {
    async function init() {
      const context = await sdk.context;
      if (context?.client?.added) {
        setIsAdded(true);
      }
      sdk.actions.ready().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[miniapp] sdk.actions.ready failed", err);
      });
    }
    init();
  }, []);

  const handleViewProfile = useCallback(() => {
    sdk.actions.viewProfile({ fid: host.fid });
  }, [host.fid]);

  const handleReply = useCallback(() => {
    if (recording.cast_hash) {
      sdk.actions.composeCast({
        parent: { type: "cast", hash: recording.cast_hash },
      });
    }
  }, [recording.cast_hash]);

  const handleShare = useCallback(() => {
    sdk.actions.composeCast({
      text: "",
      embeds: [`https://juke.audio/r/${recording.room_id}`],
    });
  }, [recording.room_id]);

  const handleAddMiniApp = useCallback(async () => {
    try {
      await sdk.actions.addMiniApp();
      setIsAdded(true);
    } catch {
      // User rejected or invalid manifest — no action needed
    }
  }, []);

  const openInJukeUrl = jukeRecordingUrl(recording.room_id);

  return (
    <div className="relative flex min-h-screen flex-col px-4 pb-24 pt-6">
      {/* Back to feed */}
      <Link
        href="/miniapp"
        className="mb-4 flex items-center gap-1 self-start text-xs text-white/40 transition-colors hover:text-white/60"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
            clipRule="evenodd"
          />
        </svg>
        Feed
      </Link>

      {/* Host chip */}
      <button
        onClick={handleViewProfile}
        className="mb-5 flex items-center gap-2.5 self-start"
      >
        {safeImageUrl(host.pfp_url) ? (
          <img
            src={safeImageUrl(host.pfp_url) as string}
            alt=""
            width={36}
            height={36}
            referrerPolicy="no-referrer"
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-sm font-bold">
            {host.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 text-left">
          <p className="truncate text-sm font-semibold">
            @{host.username}
            <span className="ml-1.5 font-normal text-white/40">on Juke</span>
          </p>
          <p className="text-xs text-white/40">
            {formatTimestamp(recording.started_at)} &middot;{" "}
            {formatRecordingDuration(recording.duration_seconds)}
          </p>
        </div>
      </button>

      {/* Title */}
      <h1 className="mb-5 text-lg font-semibold leading-snug text-white/90">
        {recording.title}
      </h1>

      {/* Native audio player — recordings can be hours long; the system
          control gives users seek + speed + scrub for free. */}
      <audio
        controls
        preload="metadata"
        src={recording.recording_url}
        className="mb-5 w-full"
        controlsList="nodownload"
      />

      {/* Action row */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={handleShare}
          className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/15"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path d="M13 4.5a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0zM13 15.5a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0zM2 10a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0z" />
            <path
              d="M7 9l5.5-3M7 11l5.5 3"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
            />
          </svg>
          Share
        </button>

        {recording.cast_hash && (
          <button
            onClick={handleReply}
            className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/15"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path
                fillRule="evenodd"
                d="M3.43 2.524A41.29 41.29 0 0110 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 01-5.183.501l-2.7 2.7A.75.75 0 017.5 16.06v-2.39c-.61-.052-1.215-.118-1.813-.197C4.236 13.242 3 11.987 3 10.574V5.426c0-1.413.993-2.67 2.43-2.902z"
                clipRule="evenodd"
              />
            </svg>
            Reply
          </button>
        )}
      </div>

      {/* Bottom CTA bar */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-white/10 bg-[#0f0f23]/95 px-4 py-3 backdrop-blur-sm">
        {!isAdded ? (
          <button
            onClick={handleAddMiniApp}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-[#6a3cff] py-3 text-sm font-bold text-white transition-colors hover:bg-[#5a30e0]"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
            </svg>
            Add Juke
          </button>
        ) : (
          <button
            onClick={() => {
              if (!openInJukeUrl) {
                console.warn(
                  "[mini-app-recording-player] refusing to open invalid recording id",
                  recording.room_id,
                );
                return;
              }
              sdk.actions.openUrl(openInJukeUrl);
            }}
            disabled={!openInJukeUrl}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-[#D85A30] py-3 text-sm font-bold text-white transition-colors hover:bg-[#c24e28] disabled:opacity-40"
          >
            Open in Juke
          </button>
        )}
      </div>
    </div>
  );
}
