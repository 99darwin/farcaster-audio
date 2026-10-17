export type MiniAppWindowMode = "standard" | "maximized" | "docked";

/**
 * Central policy for when the MiniApp shell must isolate the Juke background.
 * Mobile is always modal. Desktop releases the background only after an
 * explicit Browse action or when the window is docked.
 */
export function miniAppUsesModal({
  isDesktop,
  windowMode,
  backgroundInteractive,
}: {
  isDesktop: boolean;
  windowMode: MiniAppWindowMode;
  backgroundInteractive: boolean;
}): boolean {
  return !isDesktop || (windowMode !== "docked" && !backgroundInteractive);
}
