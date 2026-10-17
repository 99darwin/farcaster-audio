/**
 * Recognize `https://farcaster.xyz/~/spaces/<uuid>` URLs and pull out
 * the space id. Matches both the standard UUID-v4 form and the
 * lowercase v7 form farcaster.xyz actually issues
 * (e.g. `019e7436-9abf-6395-ff65-c6eb7b3a8d89`).
 *
 * This regex is the gate that determines whether a URL is allowed to
 * influence in-Juke navigation. Any URL that doesn't match the strict
 * UUID-shaped pattern is rejected and the caller falls back to the
 * generic OG / link-out path. Keep this restrictive — anything that
 * relaxes the host check or the UUID character class widens the set of
 * URLs that drive `linkFarcasterRoom` + in-app navigation.
 */

const SPACE_URL_RE =
  /^https?:\/\/(?:www\.)?farcaster\.xyz\/~\/spaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function parseFarcasterSpaceUrl(
  url: string | undefined,
): { id: string } | null {
  if (!url) return null;
  const match = url.match(SPACE_URL_RE);
  return match ? { id: match[1].toLowerCase() } : null;
}
