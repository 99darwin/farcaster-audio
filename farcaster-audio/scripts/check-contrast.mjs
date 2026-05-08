#!/usr/bin/env node
/**
 * WCAG AA contrast guard for the app's theme palettes.
 *
 * Asserts contrast ratios between text-foreground tokens and background-surface
 * tokens for both `lightColors` and `darkColors` in `constants/theme.ts`.
 *
 * Pure Node (no deps). Palette values below are inlined from
 * `constants/theme.ts` — KEEP IN SYNC with that file.
 *
 * Threshold tiers:
 *  - Body-text tier (AA, ratio >= 4.5):
 *      `text.primary`, `text.body` against `background.main`, `background.surface` ONLY.
 *  - All other pairs: AA-large (ratio >= 3.0).
 *
 * Skipped pairs (not real UI patterns; documented exclusions):
 *  - `accent`, `purple`, `danger`, `success`, `warning`, `info` against
 *    `background.subtle` and `background.border` — these are decorative-icon /
 *    border contexts at 20pt+ where the audit accepts AA-large failures as
 *    decorative.
 *  - `text.placeholder` against `background.subtle` and `background.border` —
 *    placeholder is only ever rendered against main/surface in this app.
 *
 * Exit 0 on all-pass, exit 1 on any failure.
 */

// ---------------------------------------------------------------------------
// Palette — keep in sync with constants/theme.ts
// ---------------------------------------------------------------------------

const darkColors = {
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
  success: "#22c55e",
  warning: "#fbbf24",
  info: "#3b82f6",
};

const lightColors = {
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
  success: "#15803D",
  warning: "#B45309",
  info: "#1D4ED8",
};

// ---------------------------------------------------------------------------
// Color math — sRGB relative luminance + WCAG contrast ratio
// ---------------------------------------------------------------------------

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

const FOREGROUND_KEYS = [
  "text.primary",
  "text.body",
  "text.secondary",
  "text.placeholder",
  "text.light",
  "accent",
  "purple",
  "danger",
  "success",
  "warning",
  "info",
];

const SURFACE_KEYS = [
  "background.main",
  "background.surface",
  "background.subtle",
  "background.border",
];

const BODY_TIER_FG = new Set(["text.primary", "text.body"]);
const BODY_TIER_BG = new Set(["background.main", "background.surface"]);

const DECORATIVE_FG = new Set([
  "accent",
  "purple",
  "danger",
  "success",
  "warning",
  "info",
]);
const DECORATIVE_SKIP_BG = new Set(["background.subtle", "background.border"]);
const PLACEHOLDER_SKIP_BG = new Set([
  "background.subtle",
  "background.border",
]);

function hexToRgb(hex) {
  const stripped = hex.replace(/^#/, "");
  if (stripped.length !== 6) {
    throw new Error(`Expected 6-digit hex, got "${hex}"`);
  }
  const intVal = parseInt(stripped, 16);
  return {
    r: (intVal >> 16) & 0xff,
    g: (intVal >> 8) & 0xff,
    b: intVal & 0xff,
  };
}

function srgbChannel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (
    0.2126 * srgbChannel(r) +
    0.7152 * srgbChannel(g) +
    0.0722 * srgbChannel(b)
  );
}

function contrastRatio(fgHex, bgHex) {
  const lFg = luminance(fgHex);
  const lBg = luminance(bgHex);
  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Pair iteration
// ---------------------------------------------------------------------------

function resolve(palette, key) {
  const parts = key.split(".");
  let cur = palette;
  for (const p of parts) cur = cur[p];
  if (typeof cur !== "string") {
    throw new Error(`Token "${key}" not found in palette`);
  }
  return cur;
}

function shouldSkip(fgKey, bgKey) {
  if (DECORATIVE_FG.has(fgKey) && DECORATIVE_SKIP_BG.has(bgKey)) return true;
  if (fgKey === "text.placeholder" && PLACEHOLDER_SKIP_BG.has(bgKey)) {
    return true;
  }
  return false;
}

function thresholdFor(fgKey, bgKey) {
  if (BODY_TIER_FG.has(fgKey) && BODY_TIER_BG.has(bgKey)) return AA_BODY;
  return AA_LARGE;
}

function checkPalette(name, palette) {
  const results = [];
  for (const fgKey of FOREGROUND_KEYS) {
    for (const bgKey of SURFACE_KEYS) {
      if (shouldSkip(fgKey, bgKey)) continue;
      const fg = resolve(palette, fgKey);
      const bg = resolve(palette, bgKey);
      const ratio = contrastRatio(fg, bg);
      const threshold = thresholdFor(fgKey, bgKey);
      const pass = ratio >= threshold;
      results.push({
        palette: name,
        fgKey,
        bgKey,
        fg,
        bg,
        ratio,
        threshold,
        pass,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function printPalette(name, results) {
  console.log("");
  console.log(`=== ${name} palette ===`);
  console.log(
    `${pad("foreground", 20)}${pad("background", 22)}${pad("ratio", 10)}${pad("min", 6)}status`,
  );
  console.log("-".repeat(70));
  for (const r of results) {
    const ratioStr = r.ratio.toFixed(2);
    const status = r.pass ? "PASS" : "FAIL";
    console.log(
      `${pad(r.fgKey, 20)}${pad(r.bgKey, 22)}${pad(ratioStr, 10)}${pad(r.threshold.toFixed(1), 6)}${status}`,
    );
  }
}

function main() {
  const all = [
    ...checkPalette("light", lightColors),
    ...checkPalette("dark", darkColors),
  ];

  const lightResults = all.filter((r) => r.palette === "light");
  const darkResults = all.filter((r) => r.palette === "dark");
  printPalette("light", lightResults);
  printPalette("dark", darkResults);

  const failures = all.filter((r) => !r.pass);
  const total = all.length;
  const passes = total - failures.length;

  console.log("");
  console.log("=== summary ===");
  console.log(`total checks: ${total}`);
  console.log(`passes:       ${passes}`);
  console.log(`fails:        ${failures.length}`);

  if (failures.length > 0) {
    console.log("");
    console.log("Failing pairs:");
    for (const f of failures) {
      console.log(
        `  [${f.palette}] ${f.fgKey} (${f.fg}) on ${f.bgKey} (${f.bg}) — ratio ${f.ratio.toFixed(2)} < ${f.threshold.toFixed(1)}`,
      );
    }
    process.exit(1);
  }

  console.log("");
  console.log("All contrast checks passed.");
  process.exit(0);
}

main();
