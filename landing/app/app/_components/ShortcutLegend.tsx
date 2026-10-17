"use client";

/**
 * ShortcutLegend — a quiet, compact sidebar legend driven by the SHORTCUTS
 * descriptor table. Shows the most useful bindings at a glance, with a hint
 * to open the full overlay.
 *
 * Visibility rules:
 * - Desktop-only: `hidden xl:block` (right-rail breakpoint; sidebar is md+
 *   but the legend needs the extra vertical breathing room xl provides).
 * - Hidden when viewport height < 700 px (cramped sidebar).
 * - Hidden on touch-primary devices (`pointer: coarse`).
 *
 * The header row ("Shortcuts" + chevron) is always visible when the panel is
 * shown and is keyboard accessible. The shortcut list is collapsible; the
 * collapsed preference is persisted in localStorage under the key
 * `juke:shortcut-legend-collapsed`.
 */

import { useEffect, useId, useState } from "react";
import { SHORTCUTS, splitChordKey } from "@/lib/keyboard/shortcuts";
import { cn } from "@/components/ui/cn";

// Actions excluded from the legend:
// - "escape" is universal / self-evident
// - "help" is covered by the "Press ? for all shortcuts" hint below
const EXCLUDED_ACTIONS = new Set(["escape", "help"]);

const LEGEND_SHORTCUTS = SHORTCUTS.filter(
  (s) => !EXCLUDED_ACTIONS.has(s.action),
);

const STORAGE_KEY = "juke:shortcut-legend-collapsed";

function Key({ value }: { value: string }) {
  return (
    <kbd className="inline-flex min-w-[1.25rem] items-center justify-center rounded border border-juke-border bg-juke-navy/60 px-1 py-0.5 font-mono text-[10px] font-medium text-juke-text-on-dark/70">
      {value}
    </kbd>
  );
}

/**
 * Renders a single key descriptor. Chord keys (e.g. `"g h"`) are split and
 * each part is shown as its own <kbd> pill with a "then" separator.
 */
function ShortcutKey({ value }: { value: string }) {
  const parts = splitChordKey(value);
  if (parts.length === 1) return <Key value={parts[0]} />;
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && (
            <span className="text-[9px] text-juke-text-on-dark-secondary/50">
              then
            </span>
          )}
          <Key value={part} />
        </span>
      ))}
    </span>
  );
}

export function ShortcutLegend({ className }: { className?: string }) {
  const listId = useId();

  // `null` = not yet mounted (SSR / first paint); avoids hydration mismatch.
  // After mount we read localStorage and set the real value.
  const [collapsed, setCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    setCollapsed(stored === "true");
  }, []);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // localStorage blocked (private browsing, quota exceeded, etc.) — ignore.
      }
      return next;
    });
  }

  // Before mount: render nothing to avoid a flash of the wrong collapsed state.
  // The panel is small enough that a single-frame delay is imperceptible.
  if (collapsed === null) return null;

  return (
    <div
      className={cn(
        // Desktop-only + touch-primary hidden
        "hidden xl:block",
        // Hide when viewport height is too short
        "[@media(max-height:700px)]:hidden",
        // Hide on touch-primary devices (phones/tablets with no precise pointer)
        "[@media(pointer:coarse)]:hidden",
        "rounded-xl border border-juke-border/40 bg-juke-surface/20 p-3 mb-2",
        !collapsed && "pb-4",
        className,
      )}
    >
      {/* Header row — always visible; NOT aria-hidden so the button is reachable */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-juke-text-on-dark-secondary/70">
          Shortcuts
        </p>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={listId}
          title={collapsed ? "Expand shortcuts" : "Collapse shortcuts"}
          className="flex h-5 w-5 items-center justify-center rounded text-juke-text-on-dark-secondary/50 transition-colors hover:text-juke-text-on-dark-secondary/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-juke-border"
        >
          {/* Chevron: rotates 180° when expanded */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              "transition-transform duration-200",
              collapsed ? "rotate-0" : "rotate-180",
            )}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {/* Collapsible body — always rendered so aria-controls points at a stable
          node; hidden attribute + aria-hidden keep it out of the a11y tree and
          layout when collapsed (decorative; users see shortcuts in the ? overlay) */}
      <div id={listId} aria-hidden="true" hidden={collapsed}>
        <ul className="mt-2 space-y-1" role="list">
          {LEGEND_SHORTCUTS.map((s) => (
            <li
              key={s.action}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate text-xs text-juke-text-on-dark-secondary">
                {s.description}
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                {s.keys.map((k, i) => (
                  <span key={k} className="flex items-center gap-0.5">
                    {i > 0 && (
                      <span className="text-[10px] text-juke-text-on-dark-secondary/50">
                        /
                      </span>
                    )}
                    <ShortcutKey value={k} />
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-2.5 text-center text-[10px] text-juke-text-on-dark-secondary/60">
          Press <Key value="?" /> for all shortcuts
        </p>
      </div>
    </div>
  );
}
