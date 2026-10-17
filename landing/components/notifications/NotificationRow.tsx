"use client";

/**
 * A single interactive notification row for the Juke web app.
 *
 * Mirrors mobile `components/notifications/NotificationItem.tsx`: a typed header
 * (reactor stack + action summary, or single-actor line with a "Replying to"
 * sub-line) above the full, interactive {@link CastCard} for every cast-bearing
 * notification — reply, mention, quote, and likes/recasts of your own cast.
 * `follows` notifications have no cast, so only the header renders.
 *
 * The cast is normalised here (via `normalizeCast`) so the shared `CastCard`
 * contract is reused verbatim; like/recast/reply/bookmark/quote/open-thread all
 * flow through the handlers the page wires to the notification store + API.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { CastCard } from "@/components/ui/cast-card";
import { cn } from "@/components/ui/cn";
import { normalizeCast } from "@/lib/api/users";
import type { Cast } from "@/lib/api/types";
import type {
  Notification,
  NotificationCast,
  NotificationType,
  NotificationUser,
} from "@/lib/api/notifications";

// ---------------------------------------------------------------------------
// Type metadata: icon + accent colour per notification type.
// ---------------------------------------------------------------------------

const AGGREGATE_ACTION_TEXT: Record<"likes" | "recasts" | "follows", string> = {
  likes: "liked your cast",
  recasts: "recasted your cast",
  follows: "followed you",
};

const SINGLE_ACTION_TEXT: Record<"reply" | "mention" | "quote", string> = {
  reply: "replied to your cast",
  mention: "mentioned you",
  quote: "quoted your cast",
};

interface TypeMeta {
  color: string;
  icon: (props: { className?: string }) => ReactNode;
}

function HeartIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 21s-7.5-4.6-10-9.2C.4 8.7 1.9 5 5.3 5c2 0 3.4 1.2 4.2 2.4l.5.8.5-.8C11.3 6.2 12.7 5 14.7 5 18.1 5 19.6 8.7 22 11.8 19.5 16.4 12 21 12 21Z" />
    </svg>
  );
}

function RepeatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 8h12l-2.5-2.5M20 16H8l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PersonAddIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="9" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M3.5 19a5.5 5.5 0 0 1 11 0M18 8v5M15.5 10.5h5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 6a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 6v8a1.5 1.5 0 0 1-1.5 1.5H9l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14V6Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AtIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function QuoteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M5 5.5h14A1.5 1.5 0 0 1 20.5 7v7a1.5 1.5 0 0 1-1.5 1.5h-4l-3.5 3.5V15.5H5A1.5 1.5 0 0 1 3.5 14V7A1.5 1.5 0 0 1 5 5.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TYPE_META: Record<NotificationType, TypeMeta> = {
  likes: { color: "text-red-400", icon: HeartIcon },
  recasts: { color: "text-green-400", icon: RepeatIcon },
  follows: { color: "text-juke-purple", icon: PersonAddIcon },
  reply: { color: "text-sky-400", icon: ReplyIcon },
  mention: { color: "text-juke-orange", icon: AtIcon },
  quote: { color: "text-amber-400", icon: QuoteIcon },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return `${Math.floor(diffDays / 7)}w`;
}

function displayName(user: NotificationUser): string {
  return user.display_name || user.username;
}

/** Live (non-spam) actors for an aggregate like/recast/follow notification. */
function liveActors(notification: Notification): NotificationUser[] {
  if (notification.type === "follows") {
    return (notification.follows ?? [])
      .map((f) => f.user)
      .filter((u) => !u.is_spam);
  }
  return (notification.reactions ?? [])
    .map((r) => r.user)
    .filter((u) => !u.is_spam);
}

/** Route to the relevant thread, focusing the specific cast when nested. */
export function castHref(cast: NotificationCast): string {
  const threadHash = cast.thread_hash ?? cast.parent_hash ?? cast.hash;
  const focusHash = cast.hash !== threadHash ? cast.hash : undefined;
  const base = `/app/cast/${encodeURIComponent(threadHash)}`;
  return focusHash ? `${base}?focus=${encodeURIComponent(focusHash)}` : base;
}

/**
 * The interactive, normalized cast a notification exposes — the same cast this
 * row renders inside its {@link CastCard}, or `null` when the row carries none
 * (a `follows`, or a fully spam-filtered aggregate/single). Shared with the
 * feed keyboard-nav hook so focus + actions map exactly onto the rows that show
 * an interactive cast, and can never drift from what the row renders.
 */
export function resolveNotificationCast(notification: Notification): Cast | null {
  const { type, cast } = notification;
  const isAggregate =
    type === "likes" || type === "recasts" || type === "follows";
  if (isAggregate) {
    if (liveActors(notification).length === 0) return null;
    return cast ? normalizeCast(cast) : null;
  }
  if (!cast || cast.author.is_spam) return null;
  return normalizeCast(cast);
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

const MAX_STACK = 6;

function ReactorStack({ users }: { users: NotificationUser[] }) {
  const visible = users.slice(0, MAX_STACK);
  return (
    <div className="flex -space-x-2">
      {visible.map((user) => (
        <Link
          key={user.fid}
          href={`/app/profile/${user.fid}`}
          aria-label={displayName(user)}
        >
          <Avatar
            src={user.pfp_url}
            name={displayName(user)}
            size="sm"
            className="ring-2 ring-juke-navy"
          />
        </Link>
      ))}
    </div>
  );
}

function TypeIcon({ type }: { type: NotificationType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return <Icon className={cn("inline h-3.5 w-3.5 shrink-0", meta.color)} />;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export interface NotificationRowProps {
  notification: Notification;
  /** Renders the keyboard focus ring on this row's cast (j/k navigation). */
  focused?: boolean;
  /** Optimistic like/recast/reply/bookmark/quote handlers on the shared Cast. */
  onLike: (cast: Cast) => void;
  onRecast: (cast: Cast) => void;
  onReply: (cast: Cast) => void;
  onBookmark: (cast: Cast) => void;
  onQuote: (cast: Cast) => void;
}

export function NotificationRow({
  notification,
  focused = false,
  onLike,
  onRecast,
  onReply,
  onBookmark,
  onQuote,
}: NotificationRowProps) {
  const router = useRouter();
  const { type, cast, most_recent_timestamp } = notification;
  const time = getRelativeTime(most_recent_timestamp);
  const isAggregate =
    type === "likes" || type === "recasts" || type === "follows";

  // Spam guards — mirror mobile so a fully-filtered notification collapses.
  const actors = isAggregate ? liveActors(notification) : [];
  if (isAggregate && actors.length === 0) return null;
  if (!isAggregate && (!cast || cast.author.is_spam)) return null;

  // A cast can only be interacted with if it is present. Follows never carry
  // one; likes/recasts/reply/mention/quote do. Resolved via the shared helper
  // so the row and the keyboard-nav hook agree on which rows are interactive.
  const normalizedCast: Cast | null = resolveNotificationCast(notification);

  const header = isAggregate ? (
    <AggregateHeader
      type={type as "likes" | "recasts" | "follows"}
      actors={actors}
      count={notification.count}
      time={time}
    />
  ) : (
    <SingleHeader
      type={type as "reply" | "mention" | "quote"}
      cast={cast!}
      time={time}
    />
  );

  return (
    <div
      className={cn(
        "flex flex-col",
        // `follows` has no cast, so this row owns the separator; otherwise the
        // CastCard's own bottom border provides it.
        !normalizedCast && "border-b border-juke-border",
      )}
    >
      <div className="px-4 pt-3 pb-1">{header}</div>
      {normalizedCast && cast ? (
        <CastCard
          cast={normalizedCast}
          focused={focused}
          onLike={onLike}
          onRecast={onRecast}
          onReply={onReply}
          onBookmark={onBookmark}
          onQuote={onQuote}
          onPress={() => router.push(castHref(cast))}
        />
      ) : null}
    </div>
  );
}

function AggregateHeader({
  type,
  actors,
  count,
  time,
}: {
  type: "likes" | "recasts" | "follows";
  actors: NotificationUser[];
  count: number | undefined;
  time: string;
}) {
  const first = actors[0];
  const totalCount = count ?? actors.length;
  const extraCount = Math.max(0, totalCount - 1);

  return (
    <div className="flex flex-col gap-2">
      <ReactorStack users={actors} />
      <p className="text-sm text-juke-text-on-dark-secondary">
        <Link
          href={`/app/profile/${first.fid}`}
          className="font-semibold text-juke-text-on-dark hover:underline"
        >
          {displayName(first)}
        </Link>
        {extraCount > 0 ? (
          <span>
            {" "}
            and {extraCount} other{extraCount > 1 ? "s" : ""}
          </span>
        ) : null}{" "}
        <TypeIcon type={type} /> <span>{AGGREGATE_ACTION_TEXT[type]}</span>
        <span className="text-juke-text-on-dark-tertiary"> · {time}</span>
      </p>
    </div>
  );
}

function SingleHeader({
  type,
  cast,
  time,
}: {
  type: "reply" | "mention" | "quote";
  cast: NotificationCast;
  time: string;
}) {
  const actor = cast.author;
  const parentAuthor = cast.parent_author;
  const parentUsername = parentAuthor?.username ?? undefined;

  return (
    <div className="flex flex-col">
      <p className="text-sm text-juke-text-on-dark-secondary">
        <Link
          href={`/app/profile/${actor.fid}`}
          className="font-semibold text-juke-text-on-dark hover:underline"
        >
          {displayName(actor)}
        </Link>{" "}
        <TypeIcon type={type} /> <span>{SINGLE_ACTION_TEXT[type]}</span>
        <span className="text-juke-text-on-dark-tertiary"> · {time}</span>
      </p>
      {type === "reply" && parentUsername ? (
        <p className="mt-0.5 text-xs text-juke-text-on-dark-secondary">
          Replying to{" "}
          {parentAuthor ? (
            <Link
              href={`/app/profile/${parentAuthor.fid}`}
              className="font-semibold hover:underline"
            >
              @{parentUsername}
            </Link>
          ) : (
            <span className="font-semibold">@{parentUsername}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
