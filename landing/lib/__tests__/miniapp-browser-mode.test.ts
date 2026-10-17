import { miniAppUsesModal } from "@/lib/embeds/miniapp-browser-mode";

describe("miniAppUsesModal", () => {
  it("keeps standard and maximized desktop windows modal by default", () => {
    expect(
      miniAppUsesModal({
        isDesktop: true,
        windowMode: "standard",
        backgroundInteractive: false,
      }),
    ).toBe(true);
    expect(
      miniAppUsesModal({
        isDesktop: true,
        windowMode: "maximized",
        backgroundInteractive: false,
      }),
    ).toBe(true);
  });

  it("releases the desktop background only after explicit user control", () => {
    expect(
      miniAppUsesModal({
        isDesktop: true,
        windowMode: "standard",
        backgroundInteractive: true,
      }),
    ).toBe(false);
    expect(
      miniAppUsesModal({
        isDesktop: true,
        windowMode: "docked",
        backgroundInteractive: false,
      }),
    ).toBe(false);
  });

  it("always retains modal behavior on mobile", () => {
    for (const windowMode of ["standard", "maximized", "docked"] as const) {
      expect(
        miniAppUsesModal({
          isDesktop: false,
          windowMode,
          backgroundInteractive: true,
        }),
      ).toBe(true);
    }
  });
});
