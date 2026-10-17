import Link from "next/link";
import { cn } from "@/components/ui/cn";
import type { LeaderboardAward } from "@/lib/api/leaderboard";
import { TrophyIcon } from "./icons";
import { formatCycleLabel } from "@/lib/leaderboard-cycles";

export interface AwardBadgesProps {
  awards: LeaderboardAward[];
  className?: string;
}

/**
 * Recognition badges for a profile (e.g. "Top Host — June 2026"). Renders
 * nothing when there are no awards — no empty-state chrome on a profile.
 */
export function AwardBadges({ awards, className }: AwardBadgesProps) {
  if (awards.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {awards.map((award) => (
        <Link
          key={`${award.cycle}-${award.category}`}
          href={`/leaderboard?cycle=${encodeURIComponent(award.cycle)}`}
          title={`#${award.rank} ${award.label} — ${formatCycleLabel(award.cycle)}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-juke-orange/15 to-juke-purple/15 px-3 py-1 text-xs font-semibold text-juke-text-on-dark ring-1 ring-juke-orange/25 transition-opacity hover:opacity-80"
        >
          <TrophyIcon className="h-3.5 w-3.5 text-juke-orange" />
          {award.label} — {formatCycleLabel(award.cycle)}
        </Link>
      ))}
    </div>
  );
}
