/**
 * Bubble palette. Own bubbles use the brand purple with white text
 * (4.72:1, WCAG AA for body text in both schemes); the terracotta accent is
 * only 3.87:1 against white, so it is not used behind message text.
 */

import type { ThemeColors } from "@/constants/theme";

/** Foreground on the purple own-bubble. */
export const ON_ACCENT = "#ffffff";

export interface BubbleColors {
  ownBackground: string;
  ownText: string;
  otherBackground: string;
  otherText: string;
  ownMeta: string;
  otherMeta: string;
}

export function getBubbleColors(
  colors: ThemeColors,
  scheme: "light" | "dark",
): BubbleColors {
  return {
    ownBackground: colors.purple,
    ownText: ON_ACCENT,
    otherBackground:
      scheme === "dark" ? colors.background.border : colors.background.subtle,
    otherText: colors.text.body,
    ownMeta: "rgba(255, 255, 255, 0.78)",
    otherMeta: colors.text.secondary,
  };
}
