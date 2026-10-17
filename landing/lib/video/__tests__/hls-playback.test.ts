import { chooseHlsPlayback } from "@/lib/video/hls-playback";

describe("chooseHlsPlayback", () => {
  it("prefers MSE (hls.js) even when the browser claims native HLS support", () => {
    // Regression guard: Chromium's built-in HLS player reports "maybe" from
    // canPlayType but cannot play stream.farcaster.xyz's redirected manifests
    // (variant URIs resolve against the pre-redirect URL and get ORB-blocked).
    // Trusting canPlayType first left every Farcaster video as a dead player.
    expect(
      chooseHlsPlayback({ mseSupported: true, canPlayNativeHls: true }),
    ).toBe("mse");
  });

  it("uses MSE when native HLS is unavailable", () => {
    expect(
      chooseHlsPlayback({ mseSupported: true, canPlayNativeHls: false }),
    ).toBe("mse");
  });

  it("falls back to native HLS when MSE is unavailable (iOS Safari)", () => {
    expect(
      chooseHlsPlayback({ mseSupported: false, canPlayNativeHls: true }),
    ).toBe("native");
  });

  it("reports unsupported when neither path exists", () => {
    expect(
      chooseHlsPlayback({ mseSupported: false, canPlayNativeHls: false }),
    ).toBe("unsupported");
  });
});
