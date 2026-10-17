"use client";

import { cn } from "@/components/ui/cn";
import {
  clampToRange,
  earliestBrowsableCycle,
  formatCycleLabel,
  getCurrentCycle,
  isCycleBefore,
  shiftCycle,
} from "@/lib/leaderboard-cycles";

export interface CycleSwitcherProps {
  cycle: string;
  /** Accepts a functional updater (like `setCycle` from `useState`) so
   * rapid/batched clicks always shift from the freshest cycle value
   * instead of a stale `cycle` prop. */
  onChange: (updater: (cycle: string) => string) => void;
  className?: string;
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d={direction === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"}
      />
    </svg>
  );
}

/** Prev/next month control for browsing past leaderboard cycles. */
export function CycleSwitcher({ cycle, onChange, className }: CycleSwitcherProps) {
  const currentCycle = getCurrentCycle();
  const earliest = earliestBrowsableCycle();
  const isCurrent = cycle === currentCycle;
  const canGoBack = isCycleBefore(earliest, cycle);
  const canGoForward = isCycleBefore(cycle, currentCycle);

  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        aria-label="Previous cycle"
        disabled={!canGoBack}
        onClick={() => onChange((c) => clampToRange(shiftCycle(c, -1)))}
        className="flex h-9 w-9 items-center justify-center rounded-full text-juke-text-tertiary transition-colors hover:bg-juke-navy/[0.06] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronIcon direction="left" />
      </button>

      <span className="min-w-[9rem] text-center text-sm font-semibold text-juke-text-primary">
        {formatCycleLabel(cycle)}
        {isCurrent && (
          <span className="ml-1.5 rounded-full bg-juke-orange/[0.12] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-juke-orange align-middle">
            In progress
          </span>
        )}
      </span>

      <button
        type="button"
        aria-label="Next cycle"
        disabled={!canGoForward}
        onClick={() => onChange((c) => clampToRange(shiftCycle(c, 1)))}
        className="flex h-9 w-9 items-center justify-center rounded-full text-juke-text-tertiary transition-colors hover:bg-juke-navy/[0.06] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronIcon direction="right" />
      </button>
    </div>
  );
}
