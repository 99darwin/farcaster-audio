import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/components/ui/cn";
import {
  entryDisplayName,
  entryUsername,
  type LeaderboardCategory,
} from "@/lib/api/leaderboard";
import { categoryIcon } from "./icons";

/** Subtle, on-brand winner treatment for the top 3 rows — no confetti. */
const RANK_BADGE_CLASSES: Record<number, string> = {
  1: "bg-juke-orange text-white",
  2: "bg-juke-purple text-white",
  3: "bg-white/15 text-juke-text-on-dark ring-1 ring-juke-orange/30",
};

const ROW_HIGHLIGHT_CLASSES: Record<number, string> = {
  1: "bg-juke-orange/[0.06] ring-1 ring-juke-orange/20",
  2: "bg-juke-purple/[0.06] ring-1 ring-juke-purple/20",
  3: "bg-white/[0.03] ring-1 ring-white/10",
};

function formatScore(score: number): string {
  // Round to 1 decimal first, then branch on the rounded value — otherwise a
  // score like 99.96 takes the "< 100" branch and toFixed(1) still prints
  // "100.0", contradicting the >= 100 (integer) branch right next to it.
  const rounded = Math.round(score * 10) / 10;
  return rounded >= 100 ? Math.round(rounded).toLocaleString() : rounded.toFixed(1);
}

export interface CategoryBoardProps {
  category: LeaderboardCategory;
  className?: string;
}

export function CategoryBoard({ category, className }: CategoryBoardProps) {
  const Icon = categoryIcon(category.key);

  return (
    <section
      aria-labelledby={`board-${category.key}`}
      className={cn(
        "rounded-3xl bg-juke-surface p-5 ring-1 ring-juke-border/60 sm:p-6",
        className,
      )}
    >
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-juke-navy text-juke-orange">
          <Icon className="h-4 w-4" />
        </span>
        <h3
          id={`board-${category.key}`}
          className="font-display text-lg font-bold text-juke-text-on-dark"
        >
          {category.label}
        </h3>
      </div>

      {category.entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-juke-text-on-dark-secondary">
          No placements yet this cycle.
        </p>
      ) : (
        <ol className="space-y-1">
          {category.entries.map((entry) => {
            const displayName = entryDisplayName(entry);
            const username = entryUsername(entry);
            return (
              <li key={entry.fid}>
                <Link
                  href={`/app/profile/${entry.fid}`}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl px-2.5 py-2 transition-colors hover:bg-white/5",
                    ROW_HIGHLIGHT_CLASSES[entry.rank],
                  )}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
                      RANK_BADGE_CLASSES[entry.rank] ??
                        "bg-juke-navy text-juke-text-on-dark-secondary",
                    )}
                  >
                    {entry.rank}
                  </span>
                  <Avatar src={entry.pfp_url} name={displayName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-juke-text-on-dark">
                      {displayName}
                    </span>
                    {username && (
                      <span className="block truncate text-xs text-juke-text-on-dark-secondary">
                        @{username}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm font-bold tabular-nums text-juke-text-on-dark-secondary">
                    {formatScore(entry.score)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
