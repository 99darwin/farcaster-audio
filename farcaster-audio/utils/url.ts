/**
 * Returns true if the URL is safe to hand to `Linking.openURL` or the
 * in-app miniapp host: https-only, real public domain, no loopback /
 * private / link-local addresses, no bare IPs, no custom schemes.
 */
export function isValidMiniAppUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^\[?(::1|fe80:|fc00:|fd00:)/.test(host)) return false;
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    if (host.startsWith("[")) return false;
    if (!host.includes(".")) return false;
    return true;
  } catch {
    return false;
  }
}
