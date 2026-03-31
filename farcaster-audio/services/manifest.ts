import type { MiniAppManifest, MiniAppConfig } from '@/types/miniapp';

const MANIFEST_CACHE = new Map<string, { manifest: MiniAppManifest; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const INTERMEDIARY_PREFIXES = [
  'https://warpcast.com/~/mini-app/',
  'https://farcaster.com/~/mini-app/',
  'https://farcaster.xyz/miniapps/',
  'https://farcaster.xyz/~/mini-app/',
];

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function fetchManifest(domain: string): Promise<MiniAppManifest | null> {
  const cached = MANIFEST_CACHE.get(domain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.manifest;
  }

  try {
    const response = await fetch(`https://${domain}/.well-known/farcaster.json`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;

    const manifest: MiniAppManifest = await response.json();
    MANIFEST_CACHE.set(domain, { manifest, fetchedAt: Date.now() });
    return manifest;
  } catch {
    return null;
  }
}

export function extractMiniAppConfig(manifest: MiniAppManifest): MiniAppConfig | undefined {
  return manifest.miniapp ?? manifest.frame;
}

export function getDomainFromUrl(url: string): string {
  return getDomain(url);
}

/**
 * Check if a URL is an intermediary miniapp URL (warpcast, farcaster.xyz, etc.)
 * These don't point to the actual miniapp domain.
 */
function isIntermediaryUrl(url: string): boolean {
  return INTERMEDIARY_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Resolve a miniapp URL to its launch URL and manifest config.
 * Handles direct URLs, intermediary URLs, and manifest homeUrl overrides.
 */
export async function resolveMiniApp(url: string, domainHint?: string): Promise<{
  domain: string;
  launchUrl: string;
  manifest: MiniAppManifest | null;
  config: MiniAppConfig | null;
}> {
  // For intermediary URLs, we can't derive the miniapp domain from the URL itself.
  // The actual miniapp URL should have been extracted from frame metadata by the caller.
  // If we still end up here with an intermediary URL, try to follow it.
  if (isIntermediaryUrl(url)) {
    // Try domain hint first (extracted from frame image/icon URLs)
    if (domainHint) {
      const manifest = await fetchManifest(domainHint);
      const config = manifest ? extractMiniAppConfig(manifest) ?? null : null;
      if (config?.homeUrl) {
        return { domain: domainHint, launchUrl: config.homeUrl, manifest, config };
      }
      // Even without homeUrl, use the hint domain root
      if (manifest) {
        return { domain: domainHint, launchUrl: `https://${domainHint}`, manifest, config };
      }
    }

    // Fallback: try following HTTP redirects
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const finalUrl = response.url;
      const finalDomain = getDomain(finalUrl);

      if (finalDomain !== getDomain(url) && finalDomain !== 'farcaster.xyz' && finalDomain !== 'warpcast.com') {
        const manifest = await fetchManifest(finalDomain);
        const config = manifest ? extractMiniAppConfig(manifest) ?? null : null;
        return {
          domain: finalDomain,
          launchUrl: config?.homeUrl ?? finalUrl,
          manifest,
          config,
        };
      }
    } catch {
      // Redirect follow failed
    }

    // Can't resolve — return as-is but mark no config
    return { domain: getDomain(url), launchUrl: url, manifest: null, config: null };
  }

  const domain = getDomain(url);
  const manifest = await fetchManifest(domain);
  const config = manifest ? extractMiniAppConfig(manifest) ?? null : null;

  // Use homeUrl from manifest if available and it's on the same domain
  if (config?.homeUrl) {
    const homeUrlDomain = getDomain(config.homeUrl);
    // Only override if homeUrl is on the same domain (prevent manifest hijacking)
    if (homeUrlDomain === domain || homeUrlDomain.endsWith(`.${domain}`)) {
      return { domain, launchUrl: config.homeUrl, manifest, config };
    }
  }

  return { domain, launchUrl: url, manifest, config };
}
