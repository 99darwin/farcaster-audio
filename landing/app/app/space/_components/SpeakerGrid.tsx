"use client";

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/components/ui/cn";
import type { SessionParticipant } from "@/lib/space/spaceStore";

interface SpeakerGridProps {
  speakers: SessionParticipant[];
}

const ROLE_BADGE: Record<string, string> = {
  host: "Host",
  co_host: "Co-host",
};

/**
 * Grid of active speakers/hosts. A warm ring animates around anyone LiveKit
 * reports as actively speaking (`is_speaking`), and a muted glyph marks anyone
 * currently muted.
 */
export function SpeakerGrid({ speakers }: SpeakerGridProps) {
  if (speakers.length === 0) {
    return (
      <p className="text-sm text-juke-text-on-dark-tertiary">No speakers yet.</p>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-4 sm:grid-cols-5">
      {speakers.map((p) => (
        <SpeakerCell key={p.fid} participant={p} />
      ))}
    </div>
  );
}

function SpeakerCell({ participant }: { participant: SessionParticipant }) {
  const badge = ROLE_BADGE[participant.role];
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative">
        <div
          className={cn(
            "rounded-full transition-all",
            participant.is_speaking
              ? "ring-2 ring-juke-orange ring-offset-2 ring-offset-juke-navy"
              : "ring-2 ring-transparent",
          )}
        >
          <Avatar
            src={participant.pfp_url}
            name={participant.display_name}
            size="lg"
          />
        </div>
        {participant.is_muted && (
          <span
            aria-label="Muted"
            className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-juke-surface text-juke-text-on-dark-secondary ring-2 ring-juke-navy"
          >
            <MicOffGlyph />
          </span>
        )}
        {badge && (
          <span className="absolute -top-1 left-1/2 -translate-x-1/2 rounded-full bg-juke-orange px-1.5 text-[8px] font-bold uppercase tracking-wide text-white">
            {badge}
          </span>
        )}
      </div>
      <span className="line-clamp-1 max-w-full text-center text-[11px] text-juke-text-on-dark-secondary">
        {participant.display_name}
      </span>
    </div>
  );
}

function MicOffGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden>
      <path
        d="M9 9v2a3 3 0 0 0 4.5 2.6M15 11V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 10.5 6M12 18v3M4 4l16 16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
