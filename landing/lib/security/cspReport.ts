/**
 * Parser for CSP violation reports posted to `/api/csp-report`.
 *
 * Accepts both wire formats browsers send:
 * - legacy `report-uri`: `application/csp-report`,
 *   `{ "csp-report": { "document-uri", "blocked-uri", "violated-directive" } }`
 * - Reporting API `report-to`: `application/reports+json`,
 *   `[{ "type": "csp-violation", "body": { documentURL, blockedURL, ... } }]`
 *
 * The body is attacker-controllable, so everything is treated as untrusted:
 * only three fields are kept, URLs lose their query and fragment (presigned
 * upload URLs and auth callbacks carry secrets there), and every value is
 * length-capped before it reaches the logs.
 */

/** Largest request body the collector will read. */
export const MAX_CSP_REPORT_BYTES = 16 * 1024;

/** Most violations logged from one request (the Reporting API batches). */
export const MAX_CSP_VIOLATIONS_PER_REQUEST = 10;

const MAX_FIELD_LENGTH = 256;
const CSP_VIOLATION_TYPE = "csp-violation";
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/** The fields of one violation worth logging. */
export interface CspViolation {
  documentUri: string;
  blockedUri: string;
  directive: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string): string {
  return value.slice(0, MAX_FIELD_LENGTH);
}

/**
 * Keep only origin + path of a network URL; reduce other schemes (`data:`,
 * `blob:`) to the scheme name. Keywords browsers report in place of a URL
 * (`inline`, `eval`) are not URLs and pass through, minus any `?`/`#` tail.
 */
function redactUri(value: unknown): string {
  if (typeof value !== "string") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return truncate(value.split(/[?#]/, 1)[0] ?? "");
  }
  if (!NETWORK_PROTOCOLS.has(url.protocol)) {
    return url.protocol.slice(0, -1);
  }
  return truncate(`${url.origin}${url.pathname}`);
}

function toText(value: unknown): string {
  return typeof value === "string" ? truncate(value) : "";
}

function fromLegacyReport(report: JsonRecord): CspViolation {
  return {
    documentUri: redactUri(report["document-uri"]),
    blockedUri: redactUri(report["blocked-uri"]),
    directive: toText(
      report["effective-directive"] ?? report["violated-directive"],
    ),
  };
}

function fromReportingApiBody(body: JsonRecord): CspViolation {
  return {
    documentUri: redactUri(body.documentURL),
    blockedUri: redactUri(body.blockedURL),
    directive: toText(body.effectiveDirective),
  };
}

/**
 * Extract at most {@link MAX_CSP_VIOLATIONS_PER_REQUEST} violations from a
 * parsed report body. Unknown shapes yield an empty list rather than throwing.
 */
export function parseCspReports(payload: unknown): CspViolation[] {
  if (isRecord(payload) && isRecord(payload["csp-report"])) {
    return [fromLegacyReport(payload["csp-report"])];
  }
  if (!Array.isArray(payload)) return [];
  return payload
    .filter(
      (entry): entry is JsonRecord & { body: JsonRecord } =>
        isRecord(entry) &&
        entry.type === CSP_VIOLATION_TYPE &&
        isRecord(entry.body),
    )
    .slice(0, MAX_CSP_VIOLATIONS_PER_REQUEST)
    .map((entry) => fromReportingApiBody(entry.body));
}
