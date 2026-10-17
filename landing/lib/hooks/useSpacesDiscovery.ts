"use client";

/**
 * React entry point for spaces discovery.
 *
 * Mounts the shared discovery lifecycle (refcounted WS + poll), selects the
 * four raw list slices, and memoizes the merged `live` / `upcoming` views for
 * the panel. Also re-refreshes whenever the viewer's auth status flips, since
 * `rsvp_summary.is_going` is viewer-relative.
 */

import { useEffect, useMemo } from "react";
import { useAuthStore } from "@/lib/stores/authStore";
import {
  normalizeDiscoveryLists,
  refresh,
  startSpacesDiscovery,
  useSpacesDiscoveryStore,
} from "@/lib/stores/spacesDiscoveryStore";
import { mergeDiscoverySpaces } from "@/lib/discovery/mergeDiscoverySpaces";
import type { DiscoverySpace } from "@/lib/spaces";

export interface SpacesDiscovery {
  live: DiscoverySpace[];
  upcoming: DiscoverySpace[];
  hydrated: boolean;
}

export function useSpacesDiscovery(): SpacesDiscovery {
  const jukeLive = useSpacesDiscoveryStore((s) => s.jukeLive);
  const jukeScheduled = useSpacesDiscoveryStore((s) => s.jukeScheduled);
  const farcasterLive = useSpacesDiscoveryStore((s) => s.farcasterLive);
  const farcasterScheduled = useSpacesDiscoveryStore((s) => s.farcasterScheduled);
  const hydrated = useSpacesDiscoveryStore((s) => s.hydrated);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => startSpacesDiscovery(), []);

  // `is_going` is viewer-relative — re-fetch when the viewer signs in/out.
  useEffect(() => {
    void refresh("all");
  }, [isAuthenticated]);

  const { live, upcoming } = useMemo(() => {
    const normalized = normalizeDiscoveryLists({
      jukeLive,
      jukeScheduled,
      farcasterLive,
      farcasterScheduled,
    });
    const result = mergeDiscoverySpaces(normalized);
    result.upcoming.sort((a, b) => {
      const aRaw = a.space.scheduled_at;
      const bRaw = b.space.scheduled_at;
      const parsedA = aRaw ? Date.parse(aRaw) : NaN;
      const parsedB = bRaw ? Date.parse(bRaw) : NaN;
      const aTime = Number.isFinite(parsedA)
        ? parsedA
        : Number.MAX_SAFE_INTEGER;
      const bTime = Number.isFinite(parsedB)
        ? parsedB
        : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
    return result;
  },
    [jukeLive, jukeScheduled, farcasterLive, farcasterScheduled],
  );

  return { live, upcoming, hydrated };
}
