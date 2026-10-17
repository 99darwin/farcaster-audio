import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Regression guard: anything under these directories ships in the app bundle.
 * Farcaster data comes through the Juke backend, so the bundle must never read
 * a third-party provider API key or call a provider's keyed API host.
 */
const APP_ROOT = join(__dirname, "..", "..");
const BUNDLED_DIRS = [
  "app",
  "components",
  "constants",
  "contexts",
  "hooks",
  "services",
  "stores",
  "types",
  "utils",
];
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx)$/;
const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "EXPO_PUBLIC_NEYNAR_* env var", pattern: /EXPO_PUBLIC_NEYNAR_/ },
  { label: "Neynar keyed API host", pattern: /api\.neynar\.com/ },
];
// This file names the forbidden patterns, so it is excluded from the scan.
const SELF = relative(APP_ROOT, __filename);

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) return collectSourceFiles(fullPath);
    return SOURCE_EXTENSIONS.test(entry) ? [fullPath] : [];
  });
}

describe("bundled sources", () => {
  const files = BUNDLED_DIRS.flatMap((dir) =>
    collectSourceFiles(join(APP_ROOT, dir)),
  ).filter((file) => relative(APP_ROOT, file) !== SELF);

  it("finds sources to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_PATTERNS)("never reference $label", ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(APP_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
