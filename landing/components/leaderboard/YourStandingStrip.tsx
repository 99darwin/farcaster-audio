import Link from "next/link";
import { cn } from "@/components/ui/cn";
import {
  LEADERBOARD_CATEGORY_LABELS,
  type LeaderboardCategory,
  type LeaderboardCategoryKey,
  type LeaderboardMeResponse,
} from "@/lib/api/leaderboard";

export interface YourStandingStripProps {
  me: LeaderboardMeResponse;
  /** Current cycle's categories, used to resolve display labels by key. */
  categories: LeaderboardCategory[];
  className?: string;
}

/** Small personalized strip shown to signed-in visitors above the boards. */
export function YourStandingStrip({ me, categories, className }: YourStandingStripProps) {
  // Prefer the live board's label; fall back to the static map (rather than
  // the raw key) for the brief window before the public board has loaded.
  const labelFor = (key: string) =>
    categories.find((c) => c.key === key)?.label ??
    LEADERBOARD_CATEGORY_LABELS[key as LeaderboardCategoryKey] ??
    key;

  return (
    <div
      className={cn(
        "rounded-2xl bg-juke-surface p-4 ring-1 ring-juke-border/60 sm:p-5",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-juke-text-on-dark">Your standing</p>
        {me.opt_out && (
          <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-juke-text-on-dark-secondary">
            Hidden from public boards
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {me.categories.map((c) => (
          <div key={c.key} className="rounded-xl bg-juke-navy px-3 py-2.5">
            <p className="truncate text-xs text-juke-text-on-dark-secondary">
              {labelFor(c.key)}
            </p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-juke-text-on-dark">
              {c.rank != null ? `#${c.rank}` : "—"}
            </p>
          </div>
        ))}
      </div>

      {me.opt_out && (
        <p className="mt-3 text-xs text-juke-text-on-dark-secondary">
          Change this anytime in{" "}
          <Link
            href="/app/settings"
            className="font-semibold text-juke-purple underline underline-offset-2 hover:text-juke-purple-hover"
          >
            Settings
          </Link>
          .
        </p>
      )}
    </div>
  );
}
