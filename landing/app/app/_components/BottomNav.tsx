"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { useFeedStore } from "@/lib/stores/feedStore";
import { NAV_ITEMS, isNavItemActive, PersonIcon } from "./nav-items";

export interface BottomNavProps {
  /** Unread notifications count for the badge; 0 hides it. */
  unreadCount?: number;
  /**
   * Signed-in user's FID. When provided a Profile tab is appended
   * pointing at `/app/profile/{profileFid}`. Omitted for anonymous sessions.
   */
  profileFid?: number | null;
  className?: string;
}

/**
 * Mobile primary nav — a fixed bottom tab bar (hidden on md+ where
 * {@link SideNav} is used). Sits above page content but below the persistent
 * SpaceMiniBar, which stacks on top of it.
 *
 * Every destination keeps a 44px+ touch target at 390px. Longer labels can
 * provide a compact mobile variant through the shared nav item definition.
 */
export function BottomNav({
  unreadCount = 0,
  profileFid,
  className,
}: BottomNavProps) {
  const pathname = usePathname();
  const requestRefresh = useFeedStore((s) => s.requestRefresh);

  const profileHref = profileFid != null ? `/app/profile/${profileFid}` : null;
  const profileActive = profileHref != null && isNavItemActive(profileHref, pathname);

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-juke-border bg-juke-navy/95 backdrop-blur-sm md:hidden",
        "pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
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
              // Tapping Home while already on it refreshes the feed + scrolls
              // to top, rather than a no-op navigation.
              if (item.href === "/app" && pathname === "/app") {
                e.preventDefault();
                requestRefresh();
              }
            }}
            className={cn(
              "relative flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5 py-2.5 text-[9px] font-semibold leading-none transition-colors",
              active
                ? "text-juke-orange"
                : "text-juke-text-on-dark-secondary hover:text-juke-text-on-dark",
            )}
          >
            {/* Accessible name = full label + any badge text inside the icon
                (an aria-label here would hide the unread count). */}
            <span className="sr-only">{item.label}</span>
            <span className="relative">
              <Icon className="h-6 w-6" />
              {showBadge && (
                <span className="absolute -right-1.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-juke-orange px-1 text-[9px] font-bold leading-none text-white">
                  <span aria-hidden>{unreadCount > 99 ? "99+" : unreadCount}</span>
                  <span className="sr-only">, {unreadCount} unread</span>
                </span>
              )}
            </span>
            <span aria-hidden>{item.mobileLabel ?? item.label}</span>
          </Link>
        );
      })}

      {/* Profile tab — only shown when authenticated. */}
      {profileHref != null && (
        <Link
          href={profileHref}
          aria-current={profileActive ? "page" : undefined}
          aria-label="Profile"
          className={cn(
            "relative flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5 py-2.5 text-[9px] font-semibold leading-none transition-colors",
            profileActive
              ? "text-juke-orange"
              : "text-juke-text-on-dark-secondary hover:text-juke-text-on-dark",
          )}
        >
          <PersonIcon className="h-6 w-6" />
          Profile
        </Link>
      )}
    </nav>
  );
}
