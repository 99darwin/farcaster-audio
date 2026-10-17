/**
 * Synchronous emoji search with ranked results.
 *
 * Ranking (highest → lowest):
 *   1. Exact name match
 *   2. Name prefix match
 *   3. Keyword prefix match  (any keyword starts with query)
 *   4. Name substring match
 *   5. Keyword substring match (any keyword contains query)
 *
 * Requires ≥2 query characters (caller should enforce; this function returns
 * [] for shorter inputs to avoid swamping the UI with all emojis).
 *
 * The EMOJIS dataset is bundled statically — callers should use a dynamic
 * import() so it stays out of the initial bundle:
 *
 *   const { searchEmoji } = await import('@/lib/compose/emoji-index');
 */

import type { EmojiEntry } from "./emoji-data";

export interface EmojiResult {
  emoji: string;
  name: string;
}

type RankTier = 1 | 2 | 3 | 4 | 5;

/**
 * Search the provided EMOJIS dataset for matches to `query`.
 *
 * Accepts the dataset as a parameter so callers can tree-shake or lazy-load
 * it. Use the EMOJIS export from emoji-data.ts.
 *
 * @param dataset  The EMOJIS array from emoji-data.ts.
 * @param query    Search string (without the leading `:` trigger char).
 * @param limit    Maximum results to return (default 8).
 */
export function searchEmoji(
  dataset: ReadonlyArray<EmojiEntry>,
  query: string,
  limit = 8,
): EmojiResult[] {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];

  type Candidate = { emoji: string; name: string; tier: RankTier };
  const candidates: Candidate[] = [];

  for (const [emoji, name, keywords] of dataset) {
    const nameLower = name.toLowerCase();
    const kwList = keywords.toLowerCase().split(" ").filter(Boolean);

    let tier: RankTier | null = null;

    if (nameLower === q) {
      tier = 1;
    } else if (nameLower.startsWith(q)) {
      tier = 2;
    } else if (kwList.some((kw) => kw.startsWith(q))) {
      tier = 3;
    } else if (nameLower.includes(q)) {
      tier = 4;
    } else if (kwList.some((kw) => kw.includes(q))) {
      tier = 5;
    }

    if (tier !== null) {
      candidates.push({ emoji, name, tier });
    }
  }

  // Sort by tier ascending (1 = best), then stable order within tier.
  candidates.sort((a, b) => a.tier - b.tier);

  return candidates.slice(0, limit).map(({ emoji, name }) => ({ emoji, name }));
}
