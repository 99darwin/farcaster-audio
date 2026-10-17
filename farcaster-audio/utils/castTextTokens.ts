export type CastTextSegment =
  | { type: "text"; value: string }
  | { type: "mention"; value: string; username: string }
  | { type: "url"; value: string; href: string };

interface EntityMatch {
  start: number;
  end: number;
  segment: Exclude<CastTextSegment, { type: "text" }>;
}

const MENTION_PATTERN = /(?<!\w)@[\w](?:[\w.]*[\w])?/gu;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = `(?:${HOST_LABEL}\\.)+${HOST_LABEL}`;
const IPV4 = "(?:\\d{1,3}\\.){3}\\d{1,3}";
const HOST = `(?:localhost|${IPV4}|${DOMAIN})(?::\\d{1,5})?`;
const URL_PATTERN = new RegExp(
  `(?:https?:\\/\\/${HOST}|${HOST})(?:[/?#][^\\s<>"'\\u0000-\\u001f\\u007f]*)?`,
  "giu",
);

const UNSAFE_PREFIX_PATTERN = /[a-z][a-z0-9+.-]*:(?:\/\/)?$/i;
const TRAILING_PUNCTUATION = /[.,!?;:]$/;
const DELIMITER_PAIRS = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
] as const;

function trimTrailingProsePunctuation(candidate: string): string {
  let value = candidate;

  while (TRAILING_PUNCTUATION.test(value)) value = value.slice(0, -1);

  // Keep balanced delimiters in paths, queries, and fragments, but do not
  // swallow unmatched closing punctuation around a URL in ordinary prose.
  let removed = true;
  while (removed) {
    removed = false;
    for (const [open, close] of DELIMITER_PAIRS) {
      if (!value.endsWith(close)) continue;
      const openCount = [...value].filter((char) => char === open).length;
      const closeCount = [...value].filter((char) => char === close).length;
      if (closeCount > openCount) {
        value = value.slice(0, -1);
        removed = true;
        break;
      }
    }
  }

  return value;
}

function hasSafeBoundary(text: string, start: number, end: number): boolean {
  const previous = start > 0 ? text[start - 1] : "";
  if (previous && /[\w@.-]/u.test(previous)) return false;

  // Do not link the host-shaped tail of an unsupported scheme such as
  // `javascript:example.com` or `ftp://example.com`.
  const prefix = text.slice(Math.max(0, start - 48), start);
  if (UNSAFE_PREFIX_PATTERN.test(prefix)) return false;
  const tokenPrefix = text.slice(0, start).match(/\S*$/u)?.[0] ?? "";
  if (/(?:^|[([{])[a-z][a-z0-9+.-]*:/i.test(tokenPrefix)) return false;

  // A control character must not turn a truncated prefix into a clickable URL.
  const next = text[end];
  if (next && /[\u0000-\u001f\u007f]/u.test(next)) return false;
  if (next && /[\w@-]/u.test(next)) return false;
  if (next === ":" && text[end + 1] && !/\s/u.test(text[end + 1])) return false;
  return true;
}

function safeHref(value: string): string | null {
  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const authority = value
    .replace(/^https?:\/\//i, "")
    .split(/[/?#]/u, 1)[0];
  const rawHostname = authority.replace(/:\d{1,5}$/u, "");

  // Validate dotted numeric input before URL parsing. WHATWG URL parsing
  // expands short forms (`1.2.3` -> `1.2.0.3`), which would otherwise turn a
  // version number into an apparently valid IPv4 link.
  if (/^\d+(?:\.\d+)+$/u.test(rawHostname)) {
    const octets = rawHostname.split(".");
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) =>
          Number(octet) > 255 ||
          (octet.length > 1 && octet.startsWith("0")),
      )
    ) {
      return null;
    }
  }

  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;

    const hostname = parsed.hostname;
    if (!hostname) return null;
    if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
      if (hostname.split(".").some((part) => Number(part) > 255)) return null;
    } else if (
      hostname.toLowerCase() !== "localhost" &&
      !/[a-z]/i.test(rawHostname.split(".").pop() ?? "")
    ) {
      return null;
    }

    return href;
  } catch {
    return null;
  }
}

function collectEntities(text: string): EntityMatch[] {
  const entities: EntityMatch[] = [];

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const value = match[0];
    entities.push({
      start: match.index,
      end: match.index + value.length,
      segment: { type: "mention", value, username: value.slice(1) },
    });
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const value = trimTrailingProsePunctuation(match[0]);
    if (!value) continue;
    const end = start + value.length;
    if (!hasSafeBoundary(text, start, end)) continue;
    const href = safeHref(value);
    if (!href) continue;
    entities.push({
      start,
      end,
      segment: { type: "url", value, href },
    });
  }

  return entities.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Tokenize cast text without changing the characters shown to the reader. */
export function tokenizeCastText(text: string): CastTextSegment[] {
  const segments: CastTextSegment[] = [];
  let cursor = 0;

  for (const entity of collectEntities(text)) {
    if (entity.start < cursor) continue;
    if (entity.start > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, entity.start) });
    }
    segments.push(entity.segment);
    cursor = entity.end;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }

  return segments;
}

export function filterHiddenCastUrls(
  segments: CastTextSegment[],
  hiddenUrls?: Set<string>,
): CastTextSegment[] {
  if (!hiddenUrls?.size) return segments;

  let filtered = segments.filter(
    (segment) =>
      !(segment.type === "url" && hiddenUrls.has(segment.value)),
  );

  const last = filtered.at(-1);
  if (last?.type === "text") {
    const value = last.value.replace(/\s+$/, "");
    filtered = value
      ? [...filtered.slice(0, -1), { ...last, value }]
      : filtered.slice(0, -1);
  }

  return filtered;
}
