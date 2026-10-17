"use client";

import { usePathname } from "next/navigation";
import { SpacesPanel } from "@/components/spaces/SpacesPanel";

/**
 * Pathname prefixes where the right rail is suppressed.
 * The space player and login pages need the full width.
 */
const HIDDEN_PREFIXES = ["/app/space/", "/app/login", "/app/messages"];

/**
 * Sticky right-hand panel that renders the SpacesPanel at xl+ breakpoints.
 * Hidden on routes that need full-width layout (space player, login).
 * SpacesPanel's internal hook is ref-counted, so mounting it alongside the
 * home-page strips causes no duplicate network requests or sockets.
 */
export function RightRail() {
  const pathname = usePathname();

  if (HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  return (
    <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[340px] shrink-0 self-start overflow-y-auto py-4 pr-2 pb-28 xl:block">
      <SpacesPanel />
    </aside>
  );
}
