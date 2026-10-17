import {
  extractMiniAppLaunch,
  isMiniAppEmbed,
  safeMiniAppUrl,
} from "../miniapp";

describe("safeMiniAppUrl", () => {
  it("accepts public HTTPS and normalizes it", () => {
    expect(safeMiniAppUrl("https://app.example/path?q=1")).toBe(
      "https://app.example/path?q=1",
    );
  });

  it("rejects active content, credentials, and private network targets", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "http://app.example",
      "https://user:pass@app.example",
      "https://localhost/app",
      "https://127.0.0.1/app",
      "https://192.168.1.1/app",
      "https://[::1]/app",
    ]) {
      expect(safeMiniAppUrl(value)).toBeNull();
    }
  });
});

describe("extractMiniAppLaunch", () => {
  it("extracts a Frames v2 launch action before the cast URL", () => {
    expect(
      extractMiniAppLaunch({
        url: "https://farcaster.xyz/miniapps/123/demo",
        metadata: {
          fc_frame: {
            button: {
              title: "Play",
              action: {
                type: "launch_frame",
                name: "Tiny Arcade",
                url: "https://arcade.example/play",
              },
            },
          },
        },
      }),
    ).toEqual({
      launchUrl: "https://arcade.example/play",
      domain: "arcade.example",
      title: "Tiny Arcade",
    });
  });

  it("supports legacy buttons and home URL variants", () => {
    expect(
      extractMiniAppLaunch({
        url: "https://fallback.example",
        metadata: {
          frame: {
            buttons: [
              { action_type: "post", target: "https://ignore.example" },
              {
                action_type: "launch_frame",
                target: "https://launch.example/start",
              },
            ],
          },
          html: { ogTitle: "Launch title" },
        },
      }),
    ).toMatchObject({
      launchUrl: "https://launch.example/start",
      title: "Launch title",
    });

    expect(
      extractMiniAppLaunch({
        metadata: { fc_frame: { home_url: "https://home.example/app" } },
      })?.launchUrl,
    ).toBe("https://home.example/app");
  });

  it("recognizes intermediary URLs without metadata", () => {
    const embed = { url: "https://farcaster.xyz/miniapps/123/demo" };
    expect(isMiniAppEmbed(embed)).toBe(true);
    expect(extractMiniAppLaunch(embed)?.domain).toBe("farcaster.xyz");
  });

  it("does not classify ordinary links or return an unsafe fallback", () => {
    expect(isMiniAppEmbed({ url: "https://example.com/article" })).toBe(false);
    expect(
      extractMiniAppLaunch({
        url: "http://fallback.example",
        metadata: { fc_frame: { homeUrl: "javascript:alert(1)" } },
      }),
    ).toBeNull();
  });
});
