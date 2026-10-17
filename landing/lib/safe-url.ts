/**
 * Validates a user-controlled URL is safe to use as an `<img src>`.
 *
 * We only allow `https:` (no `javascript:`, `data:`, `file:`, etc.). Any
 * malformed URL returns `null` so the caller can fall back to a placeholder.
 */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Validates a user-controlled URL is safe to use as an anchor `href`.
 *
 * Allows `http:` and `https:` only — never `javascript:`, `data:`, etc.
 * React escapes text but does not sanitize URL protocols, so any
 * user-supplied link must pass through here before rendering.
 */
export function safeLinkUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? url
      : null;
  } catch {
    return null;
  }
}
