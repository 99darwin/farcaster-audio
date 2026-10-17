/**
 * Decide how an HLS (.m3u8) stream should be played in the current browser.
 *
 * Order matters, and it is the opposite of what `canPlayType` suggests:
 * modern Chromium answers `canPlayType("application/vnd.apple.mpegurl")`
 * with "maybe" (it ships a built-in HLS player), but that player breaks on
 * CDNs that serve manifests through redirects with relative variant URIs.
 * stream.farcaster.xyz — where most Farcaster video lives — 302s every
 * manifest to a signed Cloudflare Stream URL; Chromium's native player
 * resolves the variant playlist against the pre-redirect URL, the fetch is
 * rejected (ERR_BLOCKED_BY_ORB), and the <video> dies with a
 * MEDIA_ERR_SRC_NOT_SUPPORTED. hls.js resolves segment URIs against the
 * post-redirect response URL and plays the same stream fine.
 *
 * So: MSE + hls.js always wins when available; a truthy `canPlayType` is
 * only trusted as a fallback for browsers without MSE (iOS Safari).
 */
export type HlsPlaybackStrategy = "mse" | "native" | "unsupported";

export function chooseHlsPlayback({
  mseSupported,
  canPlayNativeHls,
}: {
  /** `Hls.isSupported()` — MSE (or ManagedMediaSource) is available. */
  mseSupported: boolean;
  /** `video.canPlayType("application/vnd.apple.mpegurl") !== ""`. */
  canPlayNativeHls: boolean;
}): HlsPlaybackStrategy {
  if (mseSupported) return "mse";
  if (canPlayNativeHls) return "native";
  return "unsupported";
}
