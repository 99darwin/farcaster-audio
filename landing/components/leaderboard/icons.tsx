/**
 * Inline icons for the recognition leaderboard, matching the stroke-based
 * icon style used on the marketing homepage (`app/page.tsx`) and dashboard
 * (no icon-library dependency).
 */

import type { ReactElement } from "react";

type IconProps = { className?: string };

export function TrophyIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 4.5h9v4.5a4.5 4.5 0 0 1-9 0V4.5Z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 6H4.75A1.25 1.25 0 0 0 3.5 7.25v.5A3.25 3.25 0 0 0 6.75 11H7.5M16.5 6h2.75c.69 0 1.25.56 1.25 1.25v.5A3.25 3.25 0 0 1 17.25 11h-.75M12 13.5v3M9 20.25h6M9.75 16.5h4.5l.5 2.25a.75.75 0 0 1-.73.9H9.98a.75.75 0 0 1-.73-.9l.5-2.25Z"
      />
    </svg>
  );
}

export function HostIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 1.5a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3Z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 10.5a7.5 7.5 0 0 1-15 0"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v3.75m-3.75 0h7.5" />
    </svg>
  );
}

export function VoiceIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 12h2.1l2.4-6 3 12 2.4-9 1.8 3h4.8"
      />
    </svg>
  );
}

export function CasterIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
      />
    </svg>
  );
}

export function CommunityIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.25 10.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM15.75 10.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.75 19c0-2.9 2.46-5.25 5.5-5.25S13.75 16.1 13.75 19M11.5 14.1c.83-.53 1.83-.85 2.9-.85 3.04 0 5.5 2.35 5.5 5.25"
      />
    </svg>
  );
}

const CATEGORY_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  top_hosts: HostIcon,
  top_voices: VoiceIcon,
  top_casters: CasterIcon,
  community: CommunityIcon,
};

/** Resolve a category icon by key, falling back to the trophy glyph. */
export function categoryIcon(key: string): (props: IconProps) => ReactElement {
  return CATEGORY_ICONS[key] ?? TrophyIcon;
}
