export const WINAMP = {
  // Shell — dark industrial
  bg: "#080812",
  chrome: "#141428",
  chromeMid: "#1c1c36",
  chromeLight: "#242448",
  titleBar: "#6B3FA0",
  titleBarActive: "#855DCD",
  titleBarDark: "#3d2060",

  // LCD / text displays
  lcd: {
    bg: "#06060f",
    text: "#B88AFF",
    textBright: "#d4b8ff",
    textDim: "#5a4a7e",
    glow: "rgba(184, 138, 255, 0.4)",
  },
  time: {
    text: "#00E5FF",
    textDim: "#0a2030",
    glow: "rgba(0, 229, 255, 0.5)",
  },

  // Playlist
  playlist: {
    bg: "#06060f",
    text: "#8866cc",
    textAlt: "#7755bb",
    current: "#ffffff",
    host: "#FF6B35",
    hostGlow: "rgba(255, 107, 53, 0.4)",
    speaking: "#00E5FF",
    speakingGlow: "rgba(0, 229, 255, 0.5)",
    selectedBg: "#1a1040",
    hoverBg: "#0f0f25",
  },

  // Visualizer bars
  visualizer: {
    bg: "#04040c",
    barLow: "#4a2080",
    barMid: "#8855cc",
    barHigh: "#00E5FF",
    barPeak: "#ff44ff",
    peak: "#00ffcc",
    scanline: "rgba(0, 0, 0, 0.3)",
  },

  // Beveled 3D chrome — more aggressive
  bevel: {
    light: "#5a4a7b",
    mid: "#3a2a5a",
    dark: "#060610",
    face: "#1e1e3a",
  },
  button: {
    face: "#1e1e3a",
    faceHover: "#282850",
    pressed: "#0e0e1e",
    highlight: "#6B3FA0",
    highlightBright: "#855DCD",
    glow: "rgba(133, 93, 205, 0.3)",
  },

  // Accent colors
  accent: {
    cyan: "#00E5FF",
    purple: "#B88AFF",
    pink: "#ff44ff",
    orange: "#FF6B35",
    red: "#ff2244",
    green: "#00ff88",
  },

  // Fonts
  fonts: {
    pixel: "PressStart2P-Regular",
    segment: "DSEG7Classic-Bold",
  },

  // Common dimensions — deeper bevels
  insetBorder: {
    borderWidth: 2,
    borderTopColor: "#060610",
    borderLeftColor: "#060610",
    borderBottomColor: "#3a2a5a",
    borderRightColor: "#3a2a5a",
  },
  raisedBorder: {
    borderWidth: 2,
    borderTopColor: "#5a4a7b",
    borderLeftColor: "#5a4a7b",
    borderBottomColor: "#060610",
    borderRightColor: "#060610",
  },
  // Double groove for panels
  grooveBorder: {
    borderWidth: 1,
    borderColor: "#060610",
  },
} as const;

// Reusable decorative elements
export const RIVET_SIZE = 4;
export const GROOVE_HEIGHT = 1;
export const PANEL_MARGIN = 6;
export const PANEL_PADDING = 3;
