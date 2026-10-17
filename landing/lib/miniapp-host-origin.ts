/**
 * Who is framing us, and is it a real Farcaster client?
 *
 * The Mini App SDK talks to `window.parent` with no origin check, so any site
 * allowed to frame a juke.audio page (every legacy `/embed/*` room is
 * frameable by `*`) can impersonate a Mini App host. Its "host wallet" would
 * then sign a Protocol Auth token for the ATTACKER's FID and the embed would
 * silently sign the visitor in as the attacker (login CSRF). So the Mini App
 * sign-in path is only taken when the immediate parent is a known Farcaster
 * client; everywhere else callers fall back to the first-party popup.
 *
 * Top-level windows (native-app WebViews, which bridge through
 * `ReactNativeWebView` rather than a parent frame) aren't affected.
 */

/** Registrable domains of Farcaster clients that host Mini Apps on the web. */
export const TRUSTED_MINIAPP_HOST_DOMAINS: readonly string[] = [
  "farcaster.xyz",
  "warpcast.com",
];

export interface FrameContext {
  /** True when this document is inside an iframe. */
  readonly isFramed: boolean;
  /** Origin of the immediate parent, when the browser discloses it. */
  readonly parentOrigin: string | null;
}

/** True for `https://` origins on (a subdomain of) a trusted client domain. */
export function isTrustedMiniappHostOrigin(origin: string | null): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return TRUSTED_MINIAPP_HOST_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function toOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface FrameWindow {
  readonly parent: unknown;
  readonly location: { readonly ancestorOrigins?: ArrayLike<string> };
}

/**
 * Read the framing context. `location.ancestorOrigins[0]` (Chromium, Safari)
 * is the immediate parent and can't be suppressed by the parent. Where it is
 * missing (Firefox) the parent is unknown: `document.referrer` names whoever
 * navigated this frame, not the frame's parent, so a trusted page could be
 * made to navigate an attacker-owned frame. The parent is reported as `null`
 * (untrusted), which only costs those browsers the Mini App fast path.
 */
export function readFrameContext(win?: FrameWindow): FrameContext {
  const target =
    win ??
    (typeof window === "undefined" ? undefined : (window as FrameWindow));
  if (!target) return { isFramed: false, parentOrigin: null };
  let isFramed: boolean;
  try {
    isFramed = target.parent !== target;
  } catch {
    isFramed = true;
  }
  if (!isFramed) return { isFramed: false, parentOrigin: null };
  const ancestors = target.location.ancestorOrigins;
  const parentOrigin =
    ancestors && ancestors.length > 0 ? toOrigin(ancestors[0]) : null;
  return { isFramed, parentOrigin };
}

/**
 * Whether a Mini App host bridge, if one answers, may be trusted for sign-in.
 */
export function canTrustMiniappHost(
  context: FrameContext = readFrameContext(),
): boolean {
  if (!context.isFramed) return true;
  return isTrustedMiniappHostOrigin(context.parentOrigin);
}
