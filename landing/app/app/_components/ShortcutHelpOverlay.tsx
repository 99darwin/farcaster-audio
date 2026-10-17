"use client";

/**
 * ShortcutHelpOverlay — modal listing all keyboard shortcuts grouped by
 * category.  Triggered by pressing `?`.  Uses the existing Modal component
 * (ESC + focus-trap included) and reads from the SHORTCUTS descriptor table so
 * the displayed list stays in sync with the actual bindings.
 */

import { Modal } from "@/components/ui/modal";
import {
  SHORTCUTS,
  splitChordKey,
  type ShortcutDescriptor,
  type ShortcutGroup,
} from "@/lib/keyboard/shortcuts";

interface ShortcutHelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

const GROUP_ORDER: ShortcutGroup[] = ["Navigation", "Actions", "Compose"];

/** Build a map of group → shortcuts, preserving GROUP_ORDER. */
function groupShortcuts(): Map<ShortcutGroup, ShortcutDescriptor[]> {
  const map = new Map<ShortcutGroup, ShortcutDescriptor[]>(
    GROUP_ORDER.map((g) => [g, []]),
  );
  for (const s of SHORTCUTS) {
    map.get(s.group)?.push(s);
  }
  return map;
}

const GROUPED = groupShortcuts();

/** Render a single key token as a <kbd> pill. */
function Key({ value }: { value: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-juke-border bg-juke-navy/60 px-1.5 py-0.5 font-mono text-xs font-medium text-juke-text-on-dark">
      {value}
    </kbd>
  );
}

/**
 * Renders a single key descriptor from the SHORTCUTS table.
 * Chord keys (e.g. `"g h"`) are split on space and each part is rendered as
 * its own <kbd> pill with a "then" arrow between them.
 */
function ShortcutKey({ value }: { value: string }) {
  const parts = splitChordKey(value);
  if (parts.length === 1) return <Key value={parts[0]} />;
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && (
            <span className="text-[10px] text-juke-text-on-dark-secondary/70">
              then
            </span>
          )}
          <Key value={part} />
        </span>
      ))}
    </span>
  );
}

export function ShortcutHelpOverlay({ open, onClose }: ShortcutHelpOverlayProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      className="max-w-sm"
    >
      <div className="space-y-5">
        {GROUP_ORDER.map((group) => {
          const shortcuts = GROUPED.get(group) ?? [];
          if (shortcuts.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`shortcut-group-${group}`}>
              <h3
                id={`shortcut-group-${group}`}
                className="mb-2 text-xs font-semibold uppercase tracking-wider text-juke-text-on-dark-secondary"
              >
                {group}
              </h3>
              <ul className="space-y-1.5" role="list">
                {shortcuts.map((s) => (
                  <li
                    key={s.action}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-sm text-juke-text-on-dark">
                      {s.description}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k) => (
                        <ShortcutKey key={k} value={k} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <p className="mt-5 text-center text-xs text-juke-text-on-dark-secondary">
        Press <Key value="?" /> to toggle this panel
      </p>
    </Modal>
  );
}
