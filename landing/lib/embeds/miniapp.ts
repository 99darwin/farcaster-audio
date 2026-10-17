/**
 * Pure helpers for identifying and launching Farcaster mini apps from v2
 * embed records. Embed metadata has changed shape a few times, so extraction
 * intentionally accepts both Frames v2 and legacy field names.
 */

export interface MiniAppEmbedLike {
  url?: unknown;
  metadata?: unknown;
}

export interface MiniAppLaunch {
  launchUrl: string;
  domain: string;
  title?: string;
}

const FARCASTER_MINIAPP_PATHS = [
  /^https:\/\/(?:www\.)?warpcast\.com\/~\/mini-app\//i,
  /^https:\/\/(?:www\.)?farcaster\.com\/~\/mini-app\//i,
  /^https:\/\/(?:www\.)?farcaster\.xyz\/(?:~\/mini-app|miniapps)\//i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function frameMetadata(embed: MiniAppEmbedLike): Record<string, unknown> | null {
  if (!isRecord(embed.metadata)) return null;
  const frame = embed.metadata.fc_frame ?? embed.metadata.frame;
  return isRecord(frame) ? frame : null;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Validate a URL before it is placed in an iframe. Besides HTTPS, local and
 * private-network targets are rejected so a cast cannot turn a client into a
 * blind request surface for the viewer's router or local development tools.
 */
export function safeMiniAppUrl(value: unknown): string | null {
  const candidate = nonEmptyString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const privateIpv6 =
      host === "::" ||
      host === "::1" ||
      /^f[cd][0-9a-f]{2}:/i.test(host) ||
      /^fe[89ab][0-9a-f]:/i.test(host);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      privateIpv6 ||
      isPrivateIpv4(host)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function isMiniAppEmbed(embed: MiniAppEmbedLike): boolean {
  if (frameMetadata(embed)) return true;
  const url = nonEmptyString(embed.url);
  return !!url && FARCASTER_MINIAPP_PATHS.some((pattern) => pattern.test(url));
}

function launchButtonUrl(frame: Record<string, unknown>): unknown {
  if (isRecord(frame.button) && isRecord(frame.button.action)) {
    const action = frame.button.action;
    const type = nonEmptyString(action.type ?? action.action_type);
    if (!type || type === "launch_frame" || type === "launch_miniapp") {
      return action.url ?? action.target;
    }
  }

  if (Array.isArray(frame.buttons)) {
    for (const value of frame.buttons) {
      if (!isRecord(value)) continue;
      const action = isRecord(value.action) ? value.action : null;
      const type = nonEmptyString(
        value.action_type ?? value.type ?? action?.type ?? action?.action_type,
      );
      if (type === "launch_frame" || type === "launch_miniapp") {
        return value.target ?? value.url ?? action?.url ?? action?.target;
      }
    }
  }
  return undefined;
}

function miniAppTitle(
  frame: Record<string, unknown> | null,
  metadata: unknown,
): string | undefined {
  if (frame) {
    const button = isRecord(frame.button) ? frame.button : null;
    const action = button && isRecord(button.action) ? button.action : null;
    const title = nonEmptyString(
      frame.name ?? frame.title ?? action?.name ?? button?.title,
    );
    if (title) return title;
  }
  if (isRecord(metadata) && isRecord(metadata.html)) {
    return nonEmptyString(metadata.html.ogTitle);
  }
  return undefined;
}

/** Return the first valid HTTPS launch target from the known frame shapes. */
export function extractMiniAppLaunch(
  embed: MiniAppEmbedLike,
): MiniAppLaunch | null {
  if (!isMiniAppEmbed(embed)) return null;
  const frame = frameMetadata(embed);
  const candidates: unknown[] = frame
    ? [
        launchButtonUrl(frame),
        frame.homeUrl,
        frame.home_url,
        frame.launchUrl,
        frame.launch_url,
        frame.url,
        embed.url,
      ]
    : [embed.url];

  for (const candidate of candidates) {
    const launchUrl = safeMiniAppUrl(candidate);
    if (!launchUrl) continue;
    const parsed = new URL(launchUrl);
    return {
      launchUrl,
      domain: parsed.hostname.replace(/^www\./, ""),
      title: miniAppTitle(frame, embed.metadata),
    };
  }
  return null;
}
