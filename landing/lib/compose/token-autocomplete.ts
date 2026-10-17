/**
 * Cursor-aware token extraction for composer autocomplete triggers.
 *
 * Supports three trigger characters:
 *   @  — user mentions  (charset: [a-zA-Z0-9._-])
 *   /  — channel slugs  (charset: [a-zA-Z0-9._-])
 *   :  — emoji shortcodes (charset: [a-z0-9_+-], case-insensitive)
 *
 * Port of the walk-back approach from:
 *   farcaster-audio/components/common/MentionSuggestions.tsx (extractMentionQuery)
 *   farcaster-audio/components/feed/ChannelSuggestions.tsx  (extractChannelQuery)
 * Generalized to a single function that handles all three trigger types.
 */

export type Trigger = "@" | "/" | ":";

export interface TokenMatch {
  /** The query text after the trigger character (may be empty string). */
  query: string;
  /** Index of the trigger character in the original text. */
  start: number;
}

/** Allowed query charsets per trigger. */
const QUERY_RE: Record<Trigger, RegExp> = {
  "@": /^[a-zA-Z0-9._-]*$/,
  "/": /^[a-zA-Z0-9._-]*$/,
  ":": /^[a-z0-9_+\-]*$/i,
};

/**
 * Walk backwards from `cursor` to find a trigger character and extract the
 * partial query following it.
 *
 * Rules:
 *  - The trigger must be at position 0 OR immediately preceded by whitespace.
 *    This prevents matching `@` inside email addresses or `:` inside URLs.
 *  - Any whitespace between the trigger and the cursor aborts the match.
 *  - Characters that do not match the trigger's charset abort the match.
 *
 * @returns TokenMatch or null if the cursor is not in an autocomplete context.
 */
export function extractToken(
  text: string,
  cursor: number,
  trigger: Trigger,
): TokenMatch | null {
  const charsetRe = QUERY_RE[trigger];
  let i = cursor - 1;

  while (i >= 0) {
    const char = text[i];

    if (char === trigger) {
      // Trigger must be at start-of-text or preceded by whitespace.
      if (i !== 0 && !/\s/.test(text[i - 1])) {
        return null;
      }
      const query = text.slice(i + 1, cursor);
      // Validate the extracted query against the trigger's charset.
      if (!charsetRe.test(query)) {
        return null;
      }
      return { query, start: i };
    }

    // Whitespace between cursor and a potential trigger — abort.
    if (/\s/.test(char)) {
      return null;
    }

    // Charset violation — abort before we even find the trigger.
    if (!charsetRe.test(char)) {
      return null;
    }

    i--;
  }

  return null;
}

export interface CompletionResult {
  /** Full text with the token replaced by `inserted`. */
  text: string;
  /** New cursor position (immediately after the inserted text + one space). */
  cursor: number;
}

/**
 * Replace the full token at `[tokenStart, cursor)` (trigger char inclusive)
 * with `inserted`, appending a trailing space.
 *
 * The trigger character is NOT re-added automatically — callers must include it
 * in `inserted` when the output should start with it:
 *   - mention  → pass `"@username"`
 *   - channel  → pass `"/channel-id"`
 *   - emoji    → pass the raw glyph, e.g. `"🔥"` (no colon)
 *
 * @param text        Current text value.
 * @param tokenStart  Index of the trigger character (from TokenMatch.start).
 * @param cursor      Current cursor position (end of the partial token).
 * @param inserted    The full replacement string (including any desired trigger prefix).
 */
export function insertCompletion(
  text: string,
  tokenStart: number,
  cursor: number,
  inserted: string,
): CompletionResult {
  // Replace the entire token (trigger + query) with `inserted` + a trailing space.
  const before = text.slice(0, tokenStart);
  const after = text.slice(cursor);
  const replacement = inserted + " ";
  const newText = before + replacement + after;
  const newCursor = before.length + replacement.length;
  return { text: newText, cursor: newCursor };
}
