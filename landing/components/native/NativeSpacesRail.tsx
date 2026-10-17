"use client";

/**
 * Horizontal rail of currently-live Farcaster-NATIVE audio spaces.
 *
 * Migrated to `useSpacesDiscovery()` — data comes from the shared
 * `spacesDiscoveryStore` (refcounted WS + 30s poll) rather than a local
 * setInterval. Multiple consumers of `useSpacesDiscovery` share a single
 * socket + timer via the store's refcount.
 *
 * On tap: mirrors the chosen native space into a Juke room (`mirrorNativeSpace`,
 * idempotent + JWT-gated) then navigates to the space page, which handles the
 * native-join flow from there. Anonymous users are routed to the connect screen.
 *
 * Mirrors the visual rhythm of `components/live-spaces-strip.tsx` (the Juke-
 * hosted rail) and degrades to rendering nothing when the proxy returns empty
 * or 503, so the home feed stays clean.
 *
 * Below ≥1280px this rail is wrapped in `xl:hidden` by the shell; the panel
 * becomes the primary discovery surface. Both consume the same store so there
 * is no double-fetch.
 */

import { useSpacesDiscovery } from "@/lib/hooks/useSpacesDiscovery";
import type { FarcasterDiscoverySpace } from "@/lib/spaces";
import { NativeSpaceCard } from "@/components/spaces/cards";

export function NativeSpacesRail() {
  const { live, hydrated } = useSpacesDiscovery();

  // Only show Farcaster-native live spaces in this rail.
  const nativeSpaces = live.filter(
    (item): item is FarcasterDiscoverySpace => item.isFarcasterNative,
  );

  // Discovery is additive to the home feed; while the first hydration is in
  // flight we render nothing so we never reserve space for a rail that may be
  // empty.
  if (!hydrated) return null;
  if (nativeSpaces.length === 0) return null;

  return (
    <section
      aria-label="Live on Farcaster"
      className="border-b border-white/10 px-4 py-3"
    >
      <h2 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-white/50">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8a63d2] opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#8a63d2]" />
        </span>
        Live on Farcaster
      </h2>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {nativeSpaces.map((item) => (
          // isFarcasterNative is true here — narrowed above
          <NativeSpaceCard
            key={item.space.id}
            space={item.space}
            layout="rail"
          />
        ))}
      </div>
    </section>
  );
}
