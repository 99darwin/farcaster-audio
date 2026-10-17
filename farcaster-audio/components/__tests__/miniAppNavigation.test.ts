import { describe, expect, it } from "@jest/globals";
import {
  decideMiniAppNavigation,
  type MiniAppNavigationDecision,
} from "@/components/miniapp/miniAppNavigation";

const DOMAIN = "app.example.com";

const cases: Array<
  [string, string, boolean | undefined, MiniAppNavigationDecision]
> = [
  ["about:blank", "about:blank", true, "allow"],
  ["same domain", "https://app.example.com/next", true, "allow"],
  ["subdomain", "https://cdn.app.example.com/x", true, "allow"],
  ["look-alike suffix", "https://evilapp.example.com/x", true, "offer_external"],
  ["off-domain top frame", "https://other.com/", true, "offer_external"],
  ["off-domain, Android (no isTopFrame)", "https://other.com/", undefined, "offer_external"],
  ["off-domain sub-frame loads in place", "https://ads.other.com/", false, "allow"],
  ["custom scheme top frame", "otherapp://pay", true, "block"],
  ["custom scheme sub-frame", "tel:+15555550100", false, "block"],
  ["plain http", "http://other.com/", true, "block"],
  ["private host sub-frame", "https://192.168.1.1/", false, "block"],
  ["private host top frame", "https://localhost/", true, "block"],
  ["unparseable", "not a url", true, "block"],
];

describe("decideMiniAppNavigation", () => {
  it.each(cases)("%s", (_label, url, isTopFrame, expected) => {
    expect(decideMiniAppNavigation({ url, isTopFrame, domain: DOMAIN })).toBe(
      expected,
    );
  });

  it("matches the domain case-insensitively", () => {
    expect(
      decideMiniAppNavigation({
        url: "https://APP.Example.com/",
        isTopFrame: true,
        domain: "app.EXAMPLE.com",
      }),
    ).toBe("allow");
  });
});
