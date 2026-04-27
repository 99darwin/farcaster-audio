import Link from "next/link";
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

  return (
    <Link
      href={`/miniapp/r/${recording.room_id}`}
      className="flex items-center gap-3 border-b border-white/10 px-4 py-3 transition-colors active:bg-white/5"
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
    </Link>
  );
}
