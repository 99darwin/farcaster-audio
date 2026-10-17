import { isValidMiniAppUrl } from "@/utils/url";

export type MiniAppNavigationDecision =
  | "allow"
  | "block"
  /** Block in the WebView; offer to open in the system browser. */
  | "offer_external";

function isSameSiteHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Decide what the mini app WebView does with a navigation request.
 *
 * Only top-frame navigations can ever leave the app, and only after the
 * user confirms. Sub-frame (iframe) requests used to be bounced to the
 * system browser too, which let any embedded or hidden iframe launch
 * Safari / other apps without a tap. They now either load in place
 * (public https) or are dropped.
 */
export function decideMiniAppNavigation({
  url,
  isTopFrame,
  domain,
}: {
  url: string;
  /** Android only reports top-frame requests; treat missing as top frame. */
  isTopFrame: boolean | undefined;
  domain: string;
}): MiniAppNavigationDecision {
  if (url.startsWith("about:")) return "allow";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "block";
  }
  if (parsed.protocol !== "https:") return "block";
  if (isSameSiteHost(parsed.hostname.toLowerCase(), domain.toLowerCase())) {
    return "allow";
  }

  const isPublicHttps = isValidMiniAppUrl(url);
  if (isTopFrame === false) return isPublicHttps ? "allow" : "block";
  return isPublicHttps ? "offer_external" : "block";
}
