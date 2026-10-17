import { shouldAutoPageReactors } from "@/lib/messages/reactors";

describe("shouldAutoPageReactors", () => {
  const base = { visibleCount: 0, cursor: "next", hasMore: true, isLoading: false, hasError: false };

  it("pages while the selected tab is empty and more exist", () => {
    expect(shouldAutoPageReactors(base)).toBe(true);
  });

  it("stops once the tab has entries, at the end, while loading, or after an error", () => {
    expect(shouldAutoPageReactors({ ...base, visibleCount: 1 })).toBe(false);
    expect(shouldAutoPageReactors({ ...base, hasMore: false })).toBe(false);
    expect(shouldAutoPageReactors({ ...base, cursor: null })).toBe(false);
    expect(shouldAutoPageReactors({ ...base, isLoading: true })).toBe(false);
    expect(shouldAutoPageReactors({ ...base, hasError: true })).toBe(false);
  });
});
