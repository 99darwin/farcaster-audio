/**
 * Sentry scrubbing that guarantees a recovery phrase can't reach a crash
 * report (auth contract §5). Two layers:
 *
 * 1. While the recovery-phrase screen is mounted it flags itself sensitive:
 *    every breadcrumb is dropped and events go out without breadcrumbs,
 *    extras or contexts that UI instrumentation might have filled in.
 * 2. Always: any run of BIP-39 words long enough to be (part of) a phrase is
 *    redacted from every string in an event or breadcrumb.
 * 3. Always: credentials are redacted. Values under credential-looking keys
 *    (authorization, token, jwt, signature, cookie, ...) are replaced
 *    wholesale, bearer/JWT strings and credential query params are masked
 *    inside free text, and `request.headers` / `request.cookies` are dropped.
 *
 * The phrase is never logged in the first place; this is defence in depth.
 */

import { english } from "viem/accounts";

const ENGLISH_WORDS = new Set(english);
/**
 * Runs this long are redacted. Ordinary prose almost never strings together
 * this many consecutive BIP-39 words, while a 12/24-word phrase always does.
 */
export const MIN_REDACTED_WORD_RUN = 6;
export const REDACTED = "[redacted]";
const MAX_SCRUB_DEPTH = 12;
/** Separators that keep a run going: spaces, newlines, commas, "1." numbering. */
const RUN_SEPARATOR = /^[\s,;:.\d]+$/;

/**
 * Keys whose values are credentials regardless of shape. Matched as a
 * substring, case-insensitively, so `access_token`, `X-Auth-Token`,
 * `refreshToken` and `livekit_token` are all covered. Over-redaction of an
 * innocuous key is an acceptable cost for a crash reporter.
 */
const SENSITIVE_KEY =
  /authorization|token|jwt|refresh|signature|secret|bearer|cookie|password|passwd|private[_-]?key|mnemonic|seed[_-]?phrase|api[_-]?key/i;
/** `Bearer abc.def` / `Basic abc=` inside free text. */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Compact JWS/JWT: three base64url segments, header starting `eyJ`. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
/** Credential-bearing URL query / fragment params. */
const CREDENTIAL_PARAM_PATTERN =
  /([?&#;](?:access_token|refresh_token|id_token|token|jwt|signature|sig|secret|bearer|code|prepare_id|api_key|key)=)[^&#\s"']+/gi;

let sensitiveScreenCount = 0;

/** Mark a sensitive screen as mounted; returns the matching release. */
export function enterSensitiveScreen(): () => void {
  sensitiveScreenCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sensitiveScreenCount = Math.max(0, sensitiveScreenCount - 1);
  };
}

export function isSensitiveScreenActive(): boolean {
  return sensitiveScreenCount > 0;
}

/** Replace every run of ≥ MIN_REDACTED_WORD_RUN BIP-39 words. */
export function redactMnemonicLikeText(text: string): string {
  // Tokens alternate word / separator so the original spacing survives.
  const tokens = text.split(/([^a-zA-Z]+)/);
  const out: string[] = [];
  let run: string[] = [];
  let runWords = 0;

  const flush = () => {
    if (runWords >= MIN_REDACTED_WORD_RUN) {
      // Keep the trailing separator so the following text stays readable.
      const last = run[run.length - 1];
      const trailing = last && !/[a-zA-Z]/.test(last) ? last : "";
      out.push(REDACTED + trailing);
    } else {
      out.push(...run);
    }
    run = [];
    runWords = 0;
  };

  for (const token of tokens) {
    if (token === "") continue;
    const isWord = /^[a-zA-Z]+$/.test(token);
    if (isWord && ENGLISH_WORDS.has(token.toLowerCase())) {
      run.push(token);
      runWords += 1;
    } else if (!isWord && runWords > 0 && RUN_SEPARATOR.test(token)) {
      run.push(token);
    } else {
      flush();
      out.push(token);
    }
  }
  flush();
  return out.join("");
}

/** Mask bearer tokens, JWTs and credential query params inside free text. */
export function redactCredentialText(text: string): string {
  return text
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(CREDENTIAL_PARAM_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Deep-copy `value`, redacting credential-keyed values, credential-looking
 * substrings and mnemonic-like runs in every string.
 */
export function scrubValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") {
    return redactMnemonicLikeText(redactCredentialText(value)) as T;
  }
  if (value === null || typeof value !== "object") return value;
  // Too deep to inspect means too deep to trust: drop it rather than pass it.
  if (depth >= MAX_SCRUB_DEPTH) return REDACTED as T;
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      isSensitiveKey(key) && item !== null && item !== undefined
        ? REDACTED
        : scrubValue(item, depth + 1);
  }
  return out as T;
}

/** Sentry `beforeBreadcrumb`: nothing while sensitive, else scrubbed. */
export function scrubBreadcrumb<T extends object>(breadcrumb: T): T | null {
  if (isSensitiveScreenActive()) return null;
  return scrubValue(breadcrumb);
}

/** Drop `request.headers` / `request.cookies`: they carry auth by design. */
function withoutRequestCredentials(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const request = event.request;
  if (!request || typeof request !== "object") return event;
  const {
    headers: _h,
    cookies: _c,
    ...safeRequest
  } = request as Record<string, unknown>;
  return { ...event, request: safeRequest };
}

/**
 * Sentry `beforeSend`: drop request credentials, strip UI-derived payloads
 * while sensitive, then scrub.
 */
export function scrubEvent<T extends object>(event: T): T {
  const safeEvent = withoutRequestCredentials(event as Record<string, unknown>);
  if (!isSensitiveScreenActive()) return scrubValue(safeEvent) as T;
  const { breadcrumbs: _b, extra: _e, contexts: _c, ...rest } = safeEvent;
  return scrubValue(rest) as T;
}
