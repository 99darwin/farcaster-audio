import { apiFetch } from "@/lib/api/client";

export interface MiniAppAuthor {
  fid?: number;
  username?: string;
  display_name?: string;
  pfp_url?: string | null;
  [key: string]: unknown;
}

export interface MiniAppMetrics {
  [key: string]: unknown;
}

export interface MiniAppCatalogItem {
  name: string;
  description: string | null;
  image_url: string | null;
  frames_url: string;
  author: MiniAppAuthor | null;
  metrics: MiniAppMetrics | null;
  rank: number | null;
}

export interface MiniAppDiscoveryResponse {
  frames: MiniAppCatalogItem[];
  next: { cursor: string | null };
  meta: {
    source: "neynar" | "fallback";
    metrics_available: boolean;
    unsupported: boolean;
  };
}

export interface DiscoverMiniAppsOptions {
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 24;

export async function discoverMiniApps(
  options: DiscoverMiniAppsOptions = {},
): Promise<MiniAppDiscoveryResponse> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? DEFAULT_LIMIT),
  });
  if (options.cursor) params.set("cursor", options.cursor);

  return apiFetch<MiniAppDiscoveryResponse>(
    `/v1/search/miniapps/discover?${params.toString()}`,
    { signal: options.signal },
  );
}
