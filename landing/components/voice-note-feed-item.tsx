import Link from "next/link";
import {
  formatDuration,
  formatTimestamp,
  type VoiceNoteDetail,
} from "@/lib/voice-notes";

interface VoiceNoteFeedItemProps {
  item: VoiceNoteDetail;
}

export function VoiceNoteFeedItem({ item }: VoiceNoteFeedItemProps) {
  const { voice_note, author } = item;

  return (
    <Link
      href={`/miniapp/v/${voice_note.id}`}
      className="flex items-center gap-3 border-b border-white/10 px-4 py-3 transition-colors active:bg-white/5"
    >
      {author.pfp_url ? (
        <img
          src={author.pfp_url}
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold">
          {author.display_name.charAt(0).toUpperCase()}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white/90">
          @{author.username}
        </p>
        {voice_note.caption && (
          <p className="truncate text-xs text-white/50">{voice_note.caption}</p>
        )}
      </div>

      <div className="shrink-0 text-right">
        <p className="text-xs font-medium tabular-nums text-white/60">
          {formatDuration(voice_note.duration_ms)}
        </p>
        <p className="text-[10px] text-white/30">
          {formatTimestamp(voice_note.created_at)}
        </p>
      </div>
    </Link>
  );
}
