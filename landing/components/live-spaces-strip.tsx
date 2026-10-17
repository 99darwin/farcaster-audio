"use client";

/**
 * Horizontal scrolling strip of currently-live Juke-hosted spaces.
 *
 * Migrated to `useSpacesDiscovery()` — data comes from the shared
 * `spacesDiscoveryStore` (refcounted WS + 30s poll) rather than a local
 * setInterval. No duplicate socket is opened; mounting multiple consumers of
 * `useSpacesDiscovery` is safe.
 *
 * Renders nothing when there are no active Juke spaces so the home feed stays
 * clean. Skeleton while `!hydrated`.
 *
 * Below ≥1280px this strip is wrapped in `xl:hidden` by the shell; the panel
 * becomes the primary discovery surface. Both consume the same store so there
 * is no double-fetch.
 */

import { useSpacesDiscovery } from "@/lib/hooks/useSpacesDiscovery";
import type { JukeHostedDiscoverySpace } from "@/lib/spaces";
import { LiveSpaceCard } from "@/components/spaces/cards";

/**
 * Horizontal scrolling strip of currently-live Juke-hosted spaces.
 * Renders nothing when there are no active Juke spaces.
 */
export function LiveSpacesStrip() {
  const { live, hydrated } = useSpacesDiscovery();

  // Only show Juke-hosted live spaces in this strip.
  const jukeSpaces = live.filter(
    (item): item is JukeHostedDiscoverySpace => !item.isFarcasterNative,
  );

  // Skeleton while we wait for the first hydration — matches the voice-note
  // skeleton rhythm so the page doesn't jank.
  //
  // Guard: show skeleton only when we have NO data yet AND the store hasn't
  // finished its first refresh. The store updates each list independently as
  // fetches complete, so Juke data can arrive before the global `hydrated` flag
  // if Farcaster proxies are slower (the flag is set after all 4 fetches). This
  // prevents the skeleton from stalling on the miniapp page, which only mounts
  // this strip (no panel) and only cares about Juke live spaces.
  if (!hydrated && jukeSpaces.length === 0) {
    return (
      <div className="border-b border-white/10 px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/20" />
          <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
        </div>
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="h-24 w-44 shrink-0 animate-pulse rounded-xl bg-white/5"
            />
          ))}
        </div>
      </div>
    );
  }

  if (jukeSpaces.length === 0) return null;

  return (
    <section
      aria-label="Live now"
      className="border-b border-white/10 px-4 py-3"
    >
      <h2 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-white/50">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
        </span>
        Live now
      </h2>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {jukeSpaces.map((item) => (
          // isFarcasterNative is false here — narrowed above
          <LiveSpaceCard
            key={item.space.id}
            space={item.space}
            layout="rail"
          />
        ))}
      </div>
    </section>
  );
}
