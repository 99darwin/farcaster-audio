"use client";

/**
 * Accessible toggle switch — role="switch", keyboard operable (Space / Enter).
 *
 * Track:  w-10 h-6 (40 × 24 px), rounded-full
 *   off → bg-white/10 (visible against the dark navy background)
 *   on  → bg-juke-orange
 *
 * Knob:  w-5 h-5 (20 × 20 px), bg-white, shadow-sm
 *   off → left-0.5 top-0.5  (2 px from each edge)
 *   on  → translate-x-[18px] (knob right-edge at 40 px = track width, 2 px margin)
 *
 * Usage:
 *   <Toggle checked={value} onChange={setValue} label="My option" />
 *   <Toggle checked={value} onChange={setValue} label="My option" labelId="some-id" />
 */

import { type KeyboardEvent } from "react";
import { cn } from "@/components/ui/cn";

export interface ToggleProps {
  /** Current on/off state. */
  checked: boolean;
  /** Called with the new value when the user toggles. */
  onChange: (next: boolean) => void;
  /** Accessible label — used as aria-label when no labelId is provided. */
  label: string;
  /**
   * ID of an external element that labels this toggle (sets aria-labelledby).
   * When provided, `label` is still required but is NOT rendered — it's only
   * used as a fallback for aria-label in environments that don't honour
   * aria-labelledby.
   */
  labelId?: string;
  /** HTML id placed on the button element (useful for <label htmlFor={id}>). */
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  labelId,
  id,
  disabled = false,
  className,
}: ToggleProps) {
  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    // Native <button> already fires click on Space and Enter; we only need to
    // suppress the default scroll-on-Space browser behaviour.
    if (e.key === " ") e.preventDefault();
  }

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={!labelId ? label : undefined}
      aria-labelledby={labelId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      onKeyDown={handleKeyDown}
      className={cn(
        // Track geometry
        "relative inline-flex h-6 w-10 shrink-0 rounded-full",
        // Track colour
        checked ? "bg-juke-orange" : "bg-white/10",
        // Transitions + interactions
        "transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange focus-visible:ring-offset-2 focus-visible:ring-offset-juke-surface",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {/* Knob — absolutely positioned so it stays within the track bounds */}
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm",
          "transition-transform duration-200",
          checked ? "translate-x-[18px]" : "translate-x-0",
        )}
      />
    </button>
  );
}

/**
 * Pre-composed row: label + optional description on the left, Toggle on the
 * right, separated from the element above by a top border + padding.
 *
 * Drop-in replacement for the inline ToggleRow used in space/create/page.tsx
 * and settings/page.tsx.
 */
export interface ToggleRowProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** Extra classes applied to the outer wrapper div. */
  className?: string;
}

export function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
  className,
}: ToggleRowProps) {
  const labelId = `${id}-label`;

  return (
    <div
      className={cn(
        "flex items-center gap-4 border-t border-juke-border py-4",
        className,
      )}
    >
      {/* Text block */}
      <label
        id={labelId}
        htmlFor={id}
        className={cn("min-w-0 flex-1 cursor-pointer", disabled && "opacity-40")}
      >
        <span className="block text-sm font-medium text-juke-text-on-dark">
          {label}
        </span>
        {description && (
          <span className="mt-0.5 block text-xs text-juke-text-on-dark-secondary">
            {description}
          </span>
        )}
      </label>

      {/* Switch */}
      <Toggle
        id={id}
        checked={checked}
        onChange={onChange}
        label={label}
        labelId={labelId}
        disabled={disabled}
      />
    </div>
  );
}
