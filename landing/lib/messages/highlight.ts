/**
 * Search highlighting for messages.
 *
 * The contract types `MessageSearchHit.highlights` as `string[]` without
 * specifying the format. We accept both plausible shapes:
 *   - plain matched terms/phrases ("pizza"), and
 *   - snippets with inline `<fc_highlight>`, `<em>`, `<b>`, `<strong>` or
 *     `<mark>` markup.
 * Prefer the server's `highlight_ranges` / `matched_terms` when present
 * ({@link rangeSegments}, {@link searchHitTerms}).
 * Markup is parsed into segments (never injected as HTML), and the terms are
 * then matched case-insensitively against the message text we render.
 */

import type { HighlightRange, MessageSearchHit } from "@/lib/api/messages.types";

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const MARK_TAG = /<\/?(fc_highlight|em|b|strong|mark)>/gi;
const MARKED_PHRASE = /<(fc_highlight|em|b|strong|mark)>(.*?)<\/\1>/gi;
/** Characters of context either side of the first match in a result snippet. */
const SNIPPET_RADIUS = 48;

/** Pull the marked phrases out of a highlight snippet; plain strings pass through. */
export function extractHighlightTerms(highlights: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const highlight of highlights) {
    const marked = [...highlight.matchAll(MARKED_PHRASE)].map((match) => match[2]);
    const phrases = marked.length > 0 ? marked : [highlight.replace(MARK_TAG, "")];
    for (const phrase of phrases) {
      const term = phrase.trim();
      if (term) terms.add(term);
    }
  }
  return [...terms];
}

/** Whitespace-separated query words (at least one character each). */
export function queryTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `text` into matched/unmatched segments for every occurrence of `terms`. */
export function highlightSegments(
  text: string,
  terms: readonly string[],
): HighlightSegment[] {
  const usable = terms.filter((term) => term.length > 0);
  if (!text || usable.length === 0) return [{ text, match: false }];
  // Longest first so "pizza party" wins over "pizza" at the same position.
  const pattern = new RegExp(
    `(${usable.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`,
    "gi",
  );
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ text: text.slice(lastIndex, index), match: false });
    segments.push({ text: match[0], match: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

/** True when `text` contains every query word (case-insensitive). */
export function matchesQuery(text: string, query: string): boolean {
  const words = queryTerms(query);
  if (words.length === 0) return false;
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word.toLowerCase()));
}

/**
 * Trim a long message to a window around its first match so the highlighted
 * term is visible in a one-line search result.
 */
export function snippetAround(
  text: string,
  terms: readonly string[],
  radius = SNIPPET_RADIUS,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= radius * 2) return flat;
  const lower = flat.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index !== -1 && (first === -1 || index < first)) first = index;
  }
  if (first === -1) return `${flat.slice(0, radius * 2).trimEnd()}…`;
  const start = Math.max(0, first - radius);
  const end = Math.min(flat.length, first + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** Terms to highlight for a search hit: server `matched_terms`, else parsed snippets. */
export function searchHitTerms(hit: Pick<MessageSearchHit, "matched_terms" | "highlights">): string[] {
  if (hit.matched_terms && hit.matched_terms.length > 0) return [...hit.matched_terms];
  return extractHighlightTerms(hit.highlights);
}

/**
 * Split `text` by server highlight ranges (UTF-16 `[start, end)`, sorted and
 * non-overlapping per the contract). Out-of-bounds, empty, and overlapping
 * ranges are clamped or skipped rather than trusted.
 */
export function rangeSegments(text: string, ranges: readonly HighlightRange[]): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

/**
 * One-line result snippet around the first highlight range, as segments.
 * Whitespace is flattened one character for one, so range offsets stay valid.
 */
export function rangeSnippetSegments(
  text: string,
  ranges: readonly HighlightRange[],
  radius = SNIPPET_RADIUS,
): HighlightSegment[] {
  const flat = text.replace(/\s/g, " ");
  if (flat.length <= radius * 2) return rangeSegments(flat, ranges);
  const first = ranges.find((range) => range.end > range.start && range.start < flat.length);
  if (!first) return [{ text: `${flat.slice(0, radius * 2).trimEnd()}…`, match: false }];
  const start = Math.max(0, first.start - radius);
  const end = Math.min(flat.length, first.start + radius);
  const shifted = ranges
    .map((range) => ({ start: range.start - start, end: range.end - start }))
    .filter((range) => range.end > 0);
  const segments = rangeSegments(flat.slice(start, end), shifted);
  return [
    ...(start > 0 ? [{ text: "…", match: false }] : []),
    ...segments,
    ...(end < flat.length ? [{ text: "…", match: false }] : []),
  ];
}

/**
 * Result-row snippet for a search hit: the server's `highlight_ranges` when
 * present, else term matching (`matched_terms`, parsed snippets, then the
 * query's own terms) around the first match.
 */
export function hitSnippetSegments(
  hit: Pick<MessageSearchHit, "matched_terms" | "highlights" | "highlight_ranges"> & {
    message: { text: string };
  },
  fallbackTerms: readonly string[],
  radius = SNIPPET_RADIUS,
): HighlightSegment[] {
  const text = hit.message.text;
  if (hit.highlight_ranges && hit.highlight_ranges.length > 0) {
    return rangeSnippetSegments(text, hit.highlight_ranges, radius);
  }
  const hitTerms = searchHitTerms(hit);
  const terms = hitTerms.length > 0 ? hitTerms : fallbackTerms;
  return highlightSegments(snippetAround(text, terms, radius), terms);
}
