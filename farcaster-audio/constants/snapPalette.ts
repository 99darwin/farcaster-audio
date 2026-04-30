import type { PaletteColor, SnapAccent } from "@/types/snap";

/** Dark-mode accent palette for Farcaster Snaps. */
export const SNAP_ACCENTS: Record<SnapAccent, string> = {
  gray: "#6b7280",
  blue: "#3b82f6",
  red: "#ef4444",
  amber: "#f59e0b",
  green: "#10b981",
  teal: "#14b8a6",
  // purple is brand-constant across light/dark
  purple: "#855DCD",
  pink: "#ec4899",
};

export const DEFAULT_SNAP_ACCENT: SnapAccent = "purple";

/** Resolve a PaletteColor (including 'accent') against the current snap accent. */
export function resolvePaletteColor(
  color: PaletteColor | undefined,
  accent: SnapAccent,
): string {
  if (!color || color === "accent") return SNAP_ACCENTS[accent];
  return SNAP_ACCENTS[color] ?? SNAP_ACCENTS[accent];
}
