"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { useFeedStore } from "@/lib/stores/feedStore";
import { TrophyIcon } from "@/components/leaderboard/icons";
import { NAV_ITEMS, isNavItemActive, PersonIcon } from "./nav-items";
import { ShortcutLegend } from "./ShortcutLegend";

export interface SideNavProps {
  /** Unread notifications count for the badge; 0 hides it. */
  unreadCount?: number;
  /**
   * Signed-in user's FID. When provided a Profile link is appended to the
   * nav pointing at `/app/profile/{profileFid}`. Hidden when null/undefined
   * (anonymous session).
   */
  profileFid?: number | null;
  className?: string;
}

/**
 * Desktop (md+) vertical primary nav. Hidden on mobile, where {@link BottomNav}
 * takes over. Highlights the active route via usePathname.
 *
 * The full-height wrapper pushes {@link ShortcutLegend} to the bottom of the
 * sidebar via `mt-auto`, making use of the dead space below the nav items.
 */
export function SideNav({
  unreadCount = 0,
  profileFid,
  className,
}: SideNavProps) {
  const pathname = usePathname();
  const requestRefresh = useFeedStore((s) => s.requestRefresh);

  const profileHref = profileFid != null ? `/app/profile/${profileFid}` : null;
  const profileActive = profileHref != null && isNavItemActive(profileHref, pathname);

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <nav aria-label="Primary" className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item.href, pathname);
          const Icon = item.icon;
          const showBadge = item.showsUnreadBadge && unreadCount > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                // Clicking Home while already on it refreshes the feed +
                // scrolls to top (standard social-app behavior), rather than a
                // no-op navigation.
                if (item.href === "/app" && pathname === "/app") {
                  e.preventDefault();
                  requestRefresh();
                }
                // Return DOM focus to the body after a mouse click so the
                // feed's action shortcuts (r/l/t/b/Enter, which require the
                // body to be the active element) keep working. `detail > 0`
                // scopes this to pointer clicks, preserving keyboard focus for
                // users navigating the nav with Tab/Enter.
                if (e.detail > 0) e.currentTarget.blur();
              }}
              className={cn(
                "group relative flex items-center gap-3 rounded-full px-4 py-2.5 text-base font-semibold transition-colors",
                active
                  ? "bg-juke-surface text-juke-text-on-dark"
                  : "text-juke-text-on-dark-secondary hover:bg-juke-surface/60 hover:text-juke-text-on-dark",
              )}
            >
              <span className="relative">
                <Icon className="h-6 w-6" />
                {showBadge && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-juke-orange px-1 text-[10px] font-bold leading-none text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </span>
              {item.label}
            </Link>
          );
        })}

        {/* Profile — only visible when authenticated (profileFid provided). */}
        {profileHref != null && (
          <Link
            href={profileHref}
            aria-current={profileActive ? "page" : undefined}
            // See NAV_ITEMS onClick — drop focus on pointer click so feed
            // shortcuts keep firing after navigating.
            onClick={(e) => {
              if (e.detail > 0) e.currentTarget.blur();
            }}
            className={cn(
              "group relative flex items-center gap-3 rounded-full px-4 py-2.5 text-base font-semibold transition-colors",
              profileActive
                ? "bg-juke-surface text-juke-text-on-dark"
                : "text-juke-text-on-dark-secondary hover:bg-juke-surface/60 hover:text-juke-text-on-dark",
            )}
          >
            <PersonIcon className="h-6 w-6" />
            Profile
          </Link>
        )}

        {/* Leaderboard — public recognition boards, lives outside the /app shell. */}
        <Link
          href="/leaderboard"
          className="group relative flex items-center gap-3 rounded-full px-4 py-2.5 text-base font-semibold text-juke-text-on-dark-secondary transition-colors hover:bg-juke-surface/60 hover:text-juke-text-on-dark"
        >
          <TrophyIcon className="h-6 w-6" />
          Leaderboard
        </Link>
      </nav>

      {/* Shortcut legend occupies the dead space below nav items. */}
      <ShortcutLegend className="mt-auto" />
    </div>
  );
}
