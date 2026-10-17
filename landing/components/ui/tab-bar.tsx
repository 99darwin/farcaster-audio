"use client";

import { cn } from "./cn";

export interface TabItem<T extends string = string> {
  key: T;
  label: string;
  /** Optional trailing count badge. */
  count?: number;
}

export interface TabBarProps<T extends string = string> {
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (key: T) => void;
  className?: string;
}

/**
 * Horizontal segmented tabs with an underline on the active tab. Uses the
 * ARIA tablist pattern so keyboard/AT users get proper semantics; the panels
 * themselves are rendered by the caller.
 */
export function TabBar<T extends string = string>({
  tabs,
  value,
  onChange,
  className,
}: TabBarProps<T>) {
  return (
    <div
      role="tablist"
      className={cn(
        "flex items-center gap-1 border-b border-juke-border",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={cn(
              "relative -mb-px flex items-center gap-1.5 px-4 py-3 text-sm font-semibold transition-colors",
              active
                ? "text-juke-text-on-dark"
                : "text-juke-text-on-dark-secondary hover:text-juke-text-on-dark",
            )}
          >
            {tab.label}
            {typeof tab.count === "number" && tab.count > 0 && (
              <span className="rounded-full bg-juke-surface px-1.5 py-0.5 text-[10px] tabular-nums text-juke-text-on-dark-secondary">
                {tab.count}
              </span>
            )}
            {active && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-juke-orange" />
            )}
          </button>
        );
      })}
    </div>
  );
}
