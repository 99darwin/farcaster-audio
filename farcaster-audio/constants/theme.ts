export const colors = {
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
} as const;

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

export const theme = {
  colors,
  spacing,
  radii,
  typography,
  touchTarget,
} as const;
