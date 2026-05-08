export type ColorScheme = "light" | "dark";

export interface ThemeColors {
  background: {
    main: string;
    surface: string;
    border: string;
    subtle: string;
  };
  text: {
    primary: string;
    body: string;
    secondary: string;
    placeholder: string;
    light: string;
  };
  accent: string;
  purple: string;
  danger: string;
  error: string;
  live: string;
  success: string;
  warning: string;
  info: string;
}

export interface ThemeGlass {
  blurIntensity: number;
  tint: "light" | "dark" | "default";
  overlayColor: string;
  accentOverlay: string;
  dangerOverlay: string;
  mutedOverlay: string;
  borderColor: string;
  shadow: {
    color: string;
    offset: { width: number; height: number };
    opacity: number;
    radius: number;
  };
  pillRadius: number;
  capsuleRadius: number;
}

export const darkColors: ThemeColors = {
  background: {
    main: "#0f0f23",
    surface: "#1a1a2e",
    border: "#2a2a4a",
    subtle: "#3a3a5a",
  },
  text: {
    primary: "#ffffff",
    body: "#e0e0e0",
    secondary: "#9898b8",
    placeholder: "#777799",
    light: "#cccccc",
  },
  accent: "#D85A30",
  purple: "#855DCD",
  danger: "#dc2626",
  error: "#ef4444",
  live: "#ef4444",
  success: "#22c55e",
  warning: "#fbbf24",
  info: "#3b82f6",
};

export const lightColors: ThemeColors = {
  background: {
    main: "#FFF8F0",
    surface: "#FFFFFF",
    border: "#E8DFD2",
    subtle: "#F0E6D6",
  },
  text: {
    primary: "#1A1F36",
    body: "#2D3450",
    secondary: "#6B7390",
    placeholder: "#6B7390",
    light: "#4A5070",
  },
  accent: "#B84A24",
  purple: "#855DCD",
  danger: "#B91C1C",
  error: "#B91C1C",
  live: "#DC2626",
  success: "#15803D",
  warning: "#B45309",
  info: "#1D4ED8",
};

export const darkGlass: ThemeGlass = {
  blurIntensity: 80,
  tint: "dark",
  overlayColor: "rgba(26, 26, 46, 0.45)",
  accentOverlay: "rgba(133, 93, 205, 0.35)",
  dangerOverlay: "rgba(220, 38, 38, 0.4)",
  mutedOverlay: "rgba(216, 90, 48, 0.4)",
  borderColor: "rgba(255, 255, 255, 0.12)",
  shadow: {
    color: "#000",
    offset: { width: 0, height: 8 },
    opacity: 0.35,
    radius: 24,
  },
  pillRadius: 28,
  capsuleRadius: 24,
};

export const lightGlass: ThemeGlass = {
  blurIntensity: 60,
  tint: "light",
  overlayColor: "rgba(255, 248, 240, 0.65)",
  accentOverlay: "rgba(133, 93, 205, 0.18)",
  dangerOverlay: "rgba(185, 28, 28, 0.20)",
  mutedOverlay: "rgba(216, 90, 48, 0.20)",
  borderColor: "rgba(26, 31, 54, 0.10)",
  shadow: {
    color: "#1A1F36",
    offset: { width: 0, height: 4 },
    opacity: 0.08,
    radius: 16,
  },
  pillRadius: 28,
  capsuleRadius: 24,
};

export const getColors = (scheme: ColorScheme): ThemeColors =>
  scheme === "light" ? lightColors : darkColors;

export const getGlass = (scheme: ColorScheme): ThemeGlass =>
  scheme === "light" ? lightGlass : darkGlass;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  "2xl": 24,
  "3xl": 32,
  "4xl": 40,
  "5xl": 60,
} as const;

export const radii = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  "2xl": 24,
  full: 9999,
} as const;

export const typography = {
  size: {
    xs: 10,
    sm: 12,
    body2: 13,
    body: 14,
    md: 15,
    lg: 16,
    xl: 17,
    "2xl": 22,
    "3xl": 36,
  },
  weight: {
    regular: "400" as const,
    semibold: "600" as const,
    bold: "700" as const,
  },
} as const;

export const touchTarget = {
  min: 44,
} as const;

/**
 * Apply an alpha channel (0–1) to a hex color. Returns 8-digit hex.
 * Throws if input isn't a 6-digit hex.
 */
export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`withAlpha: expected 6-digit hex, got "${hex}"`);
  }
  const a = Math.max(0, Math.min(1, alpha));
  const aHex = Math.round(a * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${aHex}`;
}
