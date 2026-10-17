import {
  canTrustMiniappHost,
  isTrustedMiniappHostOrigin,
  readFrameContext,
} from "@/lib/miniapp-host-origin";

function frameWindow({
  framed,
  ancestorOrigins,
  referrer = "",
}: {
  framed: boolean;
  ancestorOrigins?: string[];
  referrer?: string;
}) {
  const win = {
    parent: undefined as unknown,
    location: { ancestorOrigins },
    document: { referrer },
  };
  win.parent = framed ? {} : win;
  return win;
}

describe("isTrustedMiniappHostOrigin", () => {
  it.each([
    "https://farcaster.xyz",
    "https://client.farcaster.xyz",
    "https://warpcast.com",
    "https://www.warpcast.com",
  ])("trusts %s", (origin) => {
    expect(isTrustedMiniappHostOrigin(origin)).toBe(true);
  });

  it.each([
    null,
    "",
    "http://farcaster.xyz",
    "https://evilfarcaster.xyz",
    "https://farcaster.xyz.evil.example",
    "https://attacker.example",
    "not a url",
  ])("does not trust %s", (origin) => {
    expect(isTrustedMiniappHostOrigin(origin)).toBe(false);
  });
});

describe("readFrameContext", () => {
  it("reports a top-level window as not framed", () => {
    expect(readFrameContext(frameWindow({ framed: false }))).toEqual({
      isFramed: false,
      parentOrigin: null,
    });
  });

  it("prefers ancestorOrigins over the referrer", () => {
    expect(
      readFrameContext(
        frameWindow({
          framed: true,
          ancestorOrigins: ["https://attacker.example"],
          referrer: "https://farcaster.xyz/~/mini-apps",
        }),
      ),
    ).toEqual({ isFramed: true, parentOrigin: "https://attacker.example" });
  });

  it("does not trust the referrer when ancestorOrigins is missing", () => {
    // The referrer names the navigation initiator, not the parent frame.
    expect(
      readFrameContext(
        frameWindow({
          framed: true,
          referrer: "https://farcaster.xyz/~/mini-apps/launch?x=1",
        }),
      ),
    ).toEqual({ isFramed: true, parentOrigin: null });
  });

  it("is safe outside a browser", () => {
    expect(readFrameContext()).toEqual({ isFramed: false, parentOrigin: null });
  });
});

describe("canTrustMiniappHost", () => {
  it("trusts top-level windows (native WebViews)", () => {
    expect(canTrustMiniappHost({ isFramed: false, parentOrigin: null })).toBe(
      true,
    );
  });

  it("trusts a frame inside a Farcaster client", () => {
    expect(
      canTrustMiniappHost({
        isFramed: true,
        parentOrigin: "https://farcaster.xyz",
      }),
    ).toBe(true);
  });

  it("refuses a frame inside an arbitrary site (fake host login CSRF)", () => {
    expect(
      canTrustMiniappHost({
        isFramed: true,
        parentOrigin: "https://attacker.example",
      }),
    ).toBe(false);
  });

  it("refuses a frame whose parent is undisclosed", () => {
    expect(canTrustMiniappHost({ isFramed: true, parentOrigin: null })).toBe(
      false,
    );
  });
});
