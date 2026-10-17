/**
 * Twitter / X oembed parsing — the web port of the mobile app's
 * `getTwitterInfo` (farcaster-audio/components/feed/OgPreview.tsx).
 *
 * X blocks Open Graph scraping, so the read API instead returns an oembed record
 * (`metadata.html.oembed`, `type: "rich"`) whose `html` field is the classic
 * `<blockquote class="twitter-tweet">…</blockquote>` markup, alongside
 * `author_name` / `author_url`.
 *
 * SECURITY — why this can't inject:
 *   These functions only ever RETURN PLAIN STRINGS. Every HTML tag is stripped
 *   (`<[^>]+>` removed) and a small, fixed set of named entities is decoded to
 *   their literal characters (`&lt;` → "<", etc.). The result is handed to
 *   React as an ordinary text child, which React escapes on render. There is no
 *   `dangerouslySetInnerHTML`, no DOM insertion, and no `href`/`src` derived
 *   from the tweet body — so a decoded `<` can never become a live element.
 *   Author links are validated separately by the caller via `safeLinkUrl`
 *   (https-only) before ever hitting an anchor.
 */

export interface OembedInput {
  type?: string;
  html?: string;
  author_name?: string;
  author_url?: string;
  provider_name?: string;
}

export interface ParsedTweet {
  /** Display name of the tweet author (e.g. "Vitalik Buterin"). */
  author?: string;
  /** @handle derived from `author_url`'s last path segment (no leading @). */
  handle?: string;
  /** Author profile URL, only kept when it is a safe https URL. */
  authorUrl?: string;
  /** Plain-text tweet body with all markup stripped and entities decoded. */
  text?: string;
}

/** Decode the fixed set of named entities the mobile parser handles. */
function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/…/g, "...");
}

/**
 * Extract the tweet body from the oembed blockquote HTML.
 *
 * Mirrors mobile: grab the first `<p>…</p>` (the tweet text lives there),
 * convert `<br>` to newlines, unwrap `<a>` anchors to their label, then drop
 * every remaining tag and decode entities. Returns `undefined` when no tweet
 * paragraph is present.
 */
export function extractTweetText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const paragraph = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!paragraph) return undefined;

  const text = decodeEntities(
    paragraph[1]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      .replace(/<[^>]+>/g, ""),
  ).trim();

  return text.length > 0 ? text : undefined;
}

/** Derive the @handle from an oembed `author_url` (last non-empty path part). */
export function extractHandle(authorUrl: string | undefined): string | undefined {
  if (!authorUrl) return undefined;
  let pathname: string;
  try {
    pathname = new URL(authorUrl).pathname;
  } catch {
    return undefined;
  }
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  // Handles are 1–15 alphanumeric/underscore chars. Reject anything else, plus
  // all-digit segments (those are status IDs from a /status/<id> path, never a
  // username), so we never render a bogus @…
  if (!/^[A-Za-z0-9_]{1,15}$/.test(last)) return undefined;
  if (/^\d+$/.test(last)) return undefined;
  return last;
}

/**
 * Parse an oembed record into the plain-string fields a tweet card needs.
 * Returns an all-empty object when there is nothing usable, letting the caller
 * fall back to the generic OG card.
 */
export function parseTweetOembed(
  oembed: OembedInput | undefined,
): ParsedTweet {
  if (!oembed) return {};

  const authorUrl = safeHttpsUrl(oembed.author_url);
  return {
    author: nonEmpty(oembed.author_name),
    handle: extractHandle(oembed.author_url),
    authorUrl,
    text: extractTweetText(oembed.html),
  };
}

/** True when the parsed tweet has any renderable content. */
export function hasTweetContent(parsed: ParsedTweet): boolean {
  return !!(parsed.author || parsed.handle || parsed.text);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeHttpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
