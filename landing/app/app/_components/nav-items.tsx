import type { ReactNode } from "react";
import { MessagesNavIcon } from "@/components/messages/MessagesNavIcon";
import { MESSAGING_UI_ENABLED } from "@/components/messages/useMessagingSync";

/**
 * Single source of truth for the primary navigation destinations, shared by
 * {@link SideNav} (desktop) and {@link BottomNav} (mobile) so the two stay in
 * lockstep. Icons are inline SVGs to avoid an icon-library dependency.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Optional compact label for the seven-slot mobile tab bar. */
  mobileLabel?: string;
  icon: (props: { className?: string }) => ReactNode;
  /** When true, treat as notifications and show the unread badge slot. */
  showsUnreadBadge?: boolean;
}

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M3 10.5 12 3l9 7.5M5.25 9v10.5a.75.75 0 0 0 .75.75H9.75V15a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75v5.25H18a.75.75 0 0 0 .75-.75V9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle
        cx="11"
        cy="11"
        r="6.25"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="m20 20-3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MiniAppsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect
        x="3.25"
        y="3.25"
        width="7.25"
        height="7.25"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="13.5"
        y="13.5"
        width="7.25"
        height="7.25"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M16.9 3.2c.22 1.83 1.13 2.74 2.96 2.96-1.83.22-2.74 1.13-2.96 2.96-.22-1.83-1.13-2.74-2.96-2.96 1.83-.22 2.74-1.13 2.96-2.96ZM7.1 14.88c.22 1.83 1.13 2.74 2.96 2.96-1.83.22-2.74 1.13-2.96 2.96-.22-1.83-1.13-2.74-2.96-2.96 1.83-.22 2.74-1.13 2.96-2.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M6 9a6 6 0 0 1 12 0c0 4.5 1.5 6 1.5 6H4.5S6 13.5 6 9Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M10 19a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BookmarkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.75L6 21V4.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 7.5V12l3.25 2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PersonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M4 20c0-3.866 3.582-7 8-7s8 3.134 8 7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/app", label: "Home", icon: HomeIcon },
  { href: "/app/search", label: "Search", icon: SearchIcon },
  {
    href: "/app/miniapps",
    label: "Mini Apps",
    mobileLabel: "Apps",
    icon: MiniAppsIcon,
  },
  {
    href: "/app/notifications",
    label: "Notifications",
    mobileLabel: "Alerts",
    icon: BellIcon,
    showsUnreadBadge: true,
  },
  // Direct Casts. Gated behind NEXT_PUBLIC_MESSAGING_ENABLED (mirrors the
  // backend MESSAGING_ENABLED flag). The icon renders its own unread badge;
  // `showsUnreadBadge` is the notification count, so it is left unset here.
  ...(MESSAGING_UI_ENABLED
    ? [
        {
          href: "/app/messages",
          label: "Messages",
          mobileLabel: "DMs",
          icon: MessagesNavIcon,
        },
      ]
    : []),
  {
    href: "/app/scheduled",
    label: "Scheduled",
    mobileLabel: "Queue",
    icon: ClockIcon,
  },
  {
    href: "/app/bookmarks",
    label: "Bookmarks",
    mobileLabel: "Saved",
    icon: BookmarkIcon,
  },
];

/**
 * Active-route test. `/app` matches only exactly (so it isn't highlighted on
 * every child route); the rest match the segment prefix.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}
