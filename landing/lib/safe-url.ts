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
