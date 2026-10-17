"use client";

/**
 * The canonical Farcaster cast card: author, text, embeds, channel chip, and a
 * like/recast/reply/bookmark action row with optimistic viewer-state highlight.
 *
 * Owned by Stream C (feed/home) but imported by Stream F (profile/thread/
 * channel), so the `CastCard` export and `CastCardProps` shape are a contract:
 * existing props must not break. Handlers are optional — callers that don't
 * pass one get a non-interactive (read-only) action for that slot.
 *
 * The card renders `Cast` (the normalised shape from `@/lib/api/types`); the
 * Home page keeps the optimistic bookkeeping in `feedStore` and just passes
 * `onLike`/`onRecast`/`onBookmark` here. `onReply` is the compose hook — the
 * page routes it to Stream I's compose flow.
 *
 * Reaction feedback animations (like/recast):
 *   - false→true: icon "pop" (scale burst) + ping ring + brief floating pill
 *   - true→false: subtle shrink (optimistic revert)
 *   - prefers-reduced-motion: pop/float suppressed; instant color change kept
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/components/ui/cn";
import { CastText } from "@/components/ui/cast-text";
import { CastEmbeds } from "@/components/ui/embeds";
import { safeImageUrl } from "@/lib/safe-url";
import type { Cast, ParentCast } from "@/lib/api/types";

export interface CastCardProps {
  cast: Cast;
  /** Optional handlers — the Home page wires optimistic feedStore updates. */
  onLike?: (cast: Cast) => void;
  onRecast?: (cast: Cast) => void;
  onReply?: (cast: Cast) => void;
  onBookmark?: (cast: Cast) => void;
  /**
   * Whole-card activation → open the thread. Attaches a click + Enter handler
   * to the card; a click is ignored when the user is selecting text so
   * highlighting a cast doesn't accidentally navigate. Inner links/buttons
   * stop propagation so they never trigger this.
   */
  onPress?: (cast: Cast) => void;
  /** Quote-cast handler; the quote button is only rendered when provided. */
  onQuote?: (cast: Cast) => void;
  /**
   * Delete handler — only rendered when provided (i.e. the viewer owns the
   * cast). Shows a two-step inline confirm before firing.
   */
  onDelete?: (cast: Cast) => void;
  /** When true, render as a compact thread/detail variant (no bottom border). */
  detail?: boolean;
  /** Threaded variant: tighter left rhythm for nested replies. */
  threaded?: boolean;
  /** Focus-target highlight (deep-linked reply): ring + left border. */
  focused?: boolean;
  /**
   * Thread connectors (X-style): draw the avatar-to-avatar line into this
   * card from the one above, and/or out of it to the one below.
   */
  connectAbove?: boolean;
  connectBelow?: boolean;
  /**
   * The thread's focal post: name stacked over handle, full-width larger
   * text, absolute timestamp and a stats row above the actions.
   */
  focal?: boolean;
  className?: string;
}

export function CastCard({
  cast,
  onLike,
  onRecast,
  onReply,
  onBookmark,
  onPress,
  onQuote,
  onDelete,
  detail = false,
  threaded = false,
  focused = false,
  connectAbove = false,
  connectBelow = false,
  focal = false,
  className,
}: CastCardProps) {
  const { author, reactions } = cast;

  // Detect user's motion preference (framer-motion's hook; null = no pref).
  const reducedMotion = useReducedMotion();

  // Track prev reaction states so we can detect false→true transitions.
  const prevLikedRef = useRef(reactions.viewer_liked);
  const prevRecastedRef = useRef(reactions.viewer_recasted);

  // "pop" = scale-burst on activate; "shrink" = quiet undo; null = settled.
  const [likeAnim, setLikeAnim] = useState<"pop" | "shrink" | null>(null);
  const [recastAnim, setRecastAnim] = useState<"pop" | "shrink" | null>(null);

  // Floating pill labels — only shown on false→true, hidden after 800 ms.
  const [showLikedPill, setShowLikedPill] = useState(false);
  const [showRecastedPill, setShowRecastedPill] = useState(false);

  useEffect(() => {
    const prev = prevLikedRef.current;
    prevLikedRef.current = reactions.viewer_liked;
    if (reactions.viewer_liked === prev) return;
    if (reactions.viewer_liked) {
      setLikeAnim("pop");
      if (!reducedMotion) {
        setShowLikedPill(true);
        const t = setTimeout(() => setShowLikedPill(false), 800);
        return () => clearTimeout(t);
      }
    } else {
      setLikeAnim("shrink");
    }
  }, [reactions.viewer_liked, reducedMotion]);

  useEffect(() => {
    const prev = prevRecastedRef.current;
    prevRecastedRef.current = reactions.viewer_recasted;
    if (reactions.viewer_recasted === prev) return;
    if (reactions.viewer_recasted) {
      setRecastAnim("pop");
      if (!reducedMotion) {
        setShowRecastedPill(true);
        const t = setTimeout(() => setShowRecastedPill(false), 800);
        return () => clearTimeout(t);
      }
    } else {
      setRecastAnim("shrink");
    }
  }, [reactions.viewer_recasted, reducedMotion]);

  // Don't navigate when the click concluded a text selection.
  const handlePress = onPress
    ? () => {
        if (typeof window !== "undefined") {
          const selection = window.getSelection()?.toString();
          if (selection) return;
        }
        onPress(cast);
      }
    : undefined;

  const profileHref = `/app/profile/${author.fid}`;
  // Threads and the detail view already render the parent above the reply.
  const parentCast = detail || threaded ? null : cast.parent_cast;

  // `self-start` keeps the profile link's hitbox to the avatar only, while the
  // column itself stretches the card height so the thread line below the
  // avatar can fill it. Mirrors the mobile fix (`avatarPressable:
  // { alignSelf: "flex-start" }`). The connector segments overshoot into the
  // card's vertical padding (py-3) so adjacent cards join seamlessly.
  const avatarColumn = (
    <div className="relative flex shrink-0 flex-col items-center">
      {connectAbove && (
        <span
          aria-hidden
          data-thread-line="above"
          className="absolute -top-3 left-1/2 h-3 w-0.5 -translate-x-1/2 bg-juke-text-on-dark-tertiary/40"
        />
      )}
      <Link
        href={profileHref}
        onClick={(event) => event.stopPropagation()}
        className="self-start"
        aria-label={`${author.display_name}'s profile`}
      >
        <Avatar src={author.pfp_url} name={author.display_name} size="md" />
      </Link>
      {connectBelow && (
        <span
          aria-hidden
          data-thread-line="below"
          className="-mb-3 mt-1 w-0.5 flex-1 bg-juke-text-on-dark-tertiary/40"
        />
      )}
    </div>
  );

  const headerActions = (
    <div className="flex shrink-0 items-center gap-1.5">
      {cast.channel && <ChannelChip channel={cast.channel} />}
      {onDelete && <DeleteMenu cast={cast} onDelete={onDelete} />}
    </div>
  );

  // Action row — relative so floating pills can escape upward.
  const actionRow = (
    <div className="relative mt-2 flex max-w-md items-center justify-between text-juke-text-on-dark-secondary">
      <ActionButton
        label={`Reply${count(reactions.replies_count)}`}
        count={reactions.replies_count}
        onClick={onReply ? () => onReply(cast) : undefined}
        icon={<ReplyIcon />}
      />

      {/* Recast — animated icon + floating pill */}
      <div className="relative">
        <ActionButton
          toggle
          animated
          label={`Recast${count(reactions.recasts_count)}`}
          count={reactions.recasts_count}
          active={reactions.viewer_recasted}
          activeClassName="text-green-500"
          onClick={onRecast ? () => onRecast(cast) : undefined}
          icon={
            <AnimatedIcon
              anim={reducedMotion ? null : recastAnim}
              onAnimEnd={() => setRecastAnim(null)}
              pingColor="green"
              popRotate
            >
              <RecastIcon />
            </AnimatedIcon>
          }
        />
        <AnimatePresence>
          {showRecastedPill && (
            <motion.span
              key="recasted-pill"
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute -top-7 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10, transition: { duration: 0.4 } }}
              transition={{ duration: 0.12 }}
            >
              Recasted
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {onQuote && (
        <ActionButton
          label="Quote cast"
          onClick={() => onQuote(cast)}
          icon={<QuoteIcon />}
        />
      )}

      {/* Like — animated icon + floating pill */}
      <div className="relative">
        <ActionButton
          toggle
          animated
          label={`Like${count(reactions.likes_count)}`}
          count={reactions.likes_count}
          active={reactions.viewer_liked}
          activeClassName="text-red-500"
          onClick={onLike ? () => onLike(cast) : undefined}
          icon={
            <AnimatedIcon
              anim={reducedMotion ? null : likeAnim}
              onAnimEnd={() => setLikeAnim(null)}
              pingColor="red"
            >
              <HeartIcon filled={reactions.viewer_liked} />
            </AnimatedIcon>
          }
        />
        <AnimatePresence>
          {showLikedPill && (
            <motion.span
              key="liked-pill"
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute -top-7 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10, transition: { duration: 0.4 } }}
              transition={{ duration: 0.12 }}
            >
              Liked
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <ActionButton
        toggle
        label={cast.viewer_bookmarked ? "Remove bookmark" : "Bookmark"}
        active={cast.viewer_bookmarked}
        activeClassName="text-juke-purple"
        onClick={onBookmark ? () => onBookmark(cast) : undefined}
        icon={<BookmarkIcon filled={cast.viewer_bookmarked} />}
      />
    </div>
  );

  if (focal) {
    return (
      <article
        className={cn(
          "border-b border-juke-border px-4 pt-3",
          focused && "bg-juke-purple/[0.08]",
          className,
        )}
        data-focused={focused || undefined}
        data-focal
      >
        <div className="flex items-center gap-3">
          {avatarColumn}
          <div className="flex min-w-0 flex-1 items-start justify-between gap-1">
            <div className="min-w-0 text-[15px] leading-tight">
              <Link
                href={profileHref}
                className="block truncate font-bold text-juke-text-on-dark hover:underline"
              >
                {author.display_name}
              </Link>
              <span className="block truncate text-juke-text-on-dark-secondary">
                @{author.username}
              </span>
            </div>
            {headerActions}
          </div>
        </div>

        {cast.text && (
          <CastText
            text={cast.text}
            className="mt-3 whitespace-pre-wrap break-words text-[17px] leading-normal text-juke-text-on-dark"
          />
        )}

        <CastEmbeds embeds={cast.embeds} />

        <time
          dateTime={cast.timestamp}
          className="mt-3 block text-[15px] text-juke-text-on-dark-tertiary"
        >
          {formatAbsoluteTime(cast.timestamp)}
        </time>

        <FocalStats reactions={reactions} />

        <div className="border-t border-juke-border py-1">{actionRow}</div>
      </article>
    );
  }

  return (
    <article
      className={cn(
        "group px-4 py-3",
        !detail && "border-b border-juke-border",
        handlePress &&
          "cursor-pointer transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-juke-orange/60",
        focused && "border-l-2 border-l-juke-purple bg-juke-purple/[0.08]",
        className,
      )}
      data-focused={focused || undefined}
      onClick={handlePress}
      onKeyDown={
        handlePress
          ? (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handlePress();
              }
            }
          : undefined
      }
      role={handlePress ? "link" : undefined}
      tabIndex={handlePress ? 0 : undefined}
      aria-label={
        handlePress
          ? `Open thread by ${author.display_name}`
          : undefined
      }
    >
      {parentCast && <ParentCastPreview parent={parentCast} />}

      <div className={cn("flex", threaded ? "gap-2" : "gap-3")}>
        {avatarColumn}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-1 text-sm">
              <Link
                href={profileHref}
                onClick={(event) => event.stopPropagation()}
                className="truncate font-semibold text-juke-text-on-dark hover:underline"
              >
                {author.display_name}
              </Link>
              <span className="truncate text-juke-text-on-dark-secondary">
                @{author.username}
              </span>
              <span aria-hidden className="text-juke-text-on-dark-tertiary">
                ·
              </span>
              <time
                dateTime={cast.timestamp}
                className="shrink-0 text-juke-text-on-dark-tertiary"
              >
                {formatRelativeTime(cast.timestamp)}
              </time>
            </div>
            {/*
              Channel chip lives top-right of the header (mobile parity) instead
              of stacked underneath the post body.
            */}
            {headerActions}
          </div>

          {cast.text && (
            <CastText
              text={cast.text}
              className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-snug text-juke-text-on-dark"
            />
          )}

          <CastEmbeds embeds={cast.embeds} />

          {actionRow}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Parent-cast preview (the cast a feed reply responds to)
// ---------------------------------------------------------------------------

/**
 * Compact, clamped preview of the parent cast, rendered above a reply in the
 * feed so the reply isn't shown without context. The avatar column carries a
 * connector line down to the reply's avatar; clicking opens the parent thread.
 *
 * Text renders plain (not `CastText`): its mention/channel/URL links would
 * nest inside this link, which is invalid HTML.
 */
function ParentCastPreview({ parent }: { parent: ParentCast }) {
  const { author } = parent;
  return (
    <Link
      href={`/app/cast/${encodeURIComponent(parent.hash)}`}
      onClick={(event) => event.stopPropagation()}
      className="flex gap-3 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-juke-orange/60"
      aria-label={`Replying to ${author.display_name}: ${parent.text}`}
    >
      <div className="flex w-10 shrink-0 flex-col items-center">
        <Avatar src={author.pfp_url} name={author.display_name} size="sm" />
        <span aria-hidden className="mt-1 w-0.5 flex-1 rounded-full bg-juke-border" />
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex min-w-0 items-baseline gap-1 text-sm">
          <span className="truncate font-semibold text-juke-text-on-dark-secondary">
            {author.display_name}
          </span>
          <span className="truncate text-juke-text-on-dark-tertiary">
            @{author.username}
          </span>
          <span aria-hidden className="text-juke-text-on-dark-tertiary">
            ·
          </span>
          <time
            dateTime={parent.timestamp}
            className="shrink-0 text-juke-text-on-dark-tertiary"
          >
            {formatRelativeTime(parent.timestamp)}
          </time>
        </div>
        {parent.text && (
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-snug text-juke-text-on-dark-secondary">
            {parent.text}
          </p>
        )}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Focal stats row ("12 Recasts  80 Likes") — X shows engagement totals as
// labelled counts on the focal post instead of beside the action icons.
// ---------------------------------------------------------------------------

function FocalStats({ reactions }: { reactions: Cast["reactions"] }) {
  const stats = [
    { label: "Replies", singular: "Reply", value: reactions.replies_count },
    { label: "Recasts", singular: "Recast", value: reactions.recasts_count },
    { label: "Likes", singular: "Like", value: reactions.likes_count },
  ].filter((stat) => stat.value > 0);
  if (stats.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-juke-border py-3 text-sm">
      {stats.map((stat) => (
        <span key={stat.label} className="text-juke-text-on-dark-secondary">
          <span className="font-semibold tabular-nums text-juke-text-on-dark">
            {formatCount(stat.value)}
          </span>{" "}
          {stat.value === 1 ? stat.singular : stat.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel chip (top-right of the card header — mobile parity)
// ---------------------------------------------------------------------------

function ChannelChip({
  channel,
}: {
  channel: NonNullable<Cast["channel"]>;
}) {
  const image = safeImageUrl(channel.image_url);
  return (
    <Link
      href={`/app/channel/${encodeURIComponent(channel.id)}`}
      onClick={(event) => event.stopPropagation()}
      className="inline-flex max-w-[7rem] items-center gap-1 rounded-full border border-juke-purple/50 bg-juke-purple/10 px-2 py-0.5 text-xs font-medium text-juke-text-on-dark transition-colors hover:bg-juke-purple/20"
      aria-label={`View channel /${channel.id}`}
    >
      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- channel avatars come from arbitrary hosts
        <img
          src={image}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
        />
      )}
      <span className="truncate">/{channel.id}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Delete overflow menu
// ---------------------------------------------------------------------------

/**
 * A small "⋯" overflow button that reveals a two-step destructive delete menu.
 * First click shows "Delete cast"; second click shows "Confirm delete?" which
 * fires `onDelete`. Closes on Escape or a click outside the popover.
 */
function DeleteMenu({
  cast,
  onDelete,
}: {
  cast: Cast;
  onDelete: (cast: Cast) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function handleOutside(event: globalThis.MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setConfirming(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setConfirming(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  function handleTrigger(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (open) {
      setOpen(false);
      setConfirming(false);
    } else {
      setOpen(true);
      setConfirming(false);
    }
  }

  function handleDeleteClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setOpen(false);
    setConfirming(false);
    onDelete(cast);
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="More options"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={handleTrigger}
        className="rounded p-0.5 text-juke-text-on-dark-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:text-juke-text-on-dark focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-juke-orange/60"
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden
        >
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Cast options"
          className="absolute right-0 top-full z-50 mt-1 min-w-[10rem] overflow-hidden rounded-lg border border-juke-border bg-juke-surface shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleDeleteClick}
            className={cn(
              "w-full px-4 py-2 text-left text-sm transition-colors",
              confirming
                ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                : "text-red-400 hover:bg-white/5",
            )}
          >
            {confirming ? "Confirm delete?" : "Delete cast"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action row
// ---------------------------------------------------------------------------

// Module-level animation variant maps for AnimatedIcon — hoisted so the
// objects are not rebuilt on every render (stable reference for framer-motion).
const STRAIGHT_VARIANTS = {
  idle: { scale: 1, rotate: 0 },
  pop: {
    scale: [1, 1.4, 1.1, 1] as number[],
    rotate: 0,
    transition: { duration: 0.32, times: [0, 0.25, 0.65, 1] },
  },
  shrink: {
    scale: [1, 0.78, 1] as number[],
    rotate: 0,
    transition: { duration: 0.18 },
  },
};

const ROTATE_VARIANTS = {
  idle: { scale: 1, rotate: 0 },
  pop: {
    scale: [1, 1.4, 1.1, 1] as number[],
    rotate: [0, -18, 6, 0] as number[],
    transition: { duration: 0.32, times: [0, 0.25, 0.65, 1] },
  },
  shrink: {
    scale: [1, 0.78, 1] as number[],
    rotate: 0,
    transition: { duration: 0.18 },
  },
};

/**
 * Wraps an icon with a framer-motion pop/shrink burst and a brief ping ring.
 * Reduced-motion callers should pass `anim={null}` to skip all motion.
 */
interface AnimatedIconProps {
  /** Animation to play: "pop" on activate, "shrink" on undo, null = settled. */
  anim: "pop" | "shrink" | null;
  /** Called once the animation finishes so the parent can clear the state. */
  onAnimEnd?: () => void;
  /** Color of the expanding ping ring behind the icon. */
  pingColor?: "red" | "green";
  /** Add a slight rotation to the pop (used for the recast arrow icon). */
  popRotate?: boolean;
  children: ReactNode;
}

function AnimatedIcon({
  anim,
  onAnimEnd,
  pingColor,
  popRotate = false,
  children,
}: AnimatedIconProps) {
  const variants = popRotate ? ROTATE_VARIANTS : STRAIGHT_VARIANTS;

  return (
    <span className="relative inline-flex items-center justify-center">
      {/* Expanding ping ring — appears only on the "pop" burst */}
      <AnimatePresence>
        {anim === "pop" && pingColor && (
          <motion.span
            key="ping"
            aria-hidden
            className={cn(
              "absolute inset-[-5px] rounded-full",
              pingColor === "red" ? "bg-red-500/30" : "bg-green-500/30",
            )}
            initial={{ scale: 0.6, opacity: 0.9 }}
            animate={{ scale: 2.4, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.48, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      <motion.span
        className="relative"
        initial="idle"
        animate={anim ?? "idle"}
        variants={variants}
        onAnimationComplete={() => {
          if (anim !== null) onAnimEnd?.();
        }}
      >
        {children}
      </motion.span>
    </span>
  );
}

interface ActionButtonProps {
  label: string;
  count?: number;
  active?: boolean;
  activeClassName?: string;
  /** When true, expose toggle state via `aria-pressed` (like/recast/bookmark). */
  toggle?: boolean;
  /**
   * When true the icon already handles its own motion (framer-motion). Suppress
   * the CSS `group-active:scale-90` on the wrapper so the two scales don't
   * compound during the pop burst. Non-animated icons retain the CSS scale.
   */
  animated?: boolean;
  onClick?: () => void;
  icon: ReactNode;
}

function ActionButton({
  label,
  count: value,
  active = false,
  activeClassName,
  toggle = false,
  animated = false,
  onClick,
  icon,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={toggle ? active : undefined}
      disabled={!onClick}
      onClick={
        onClick
          ? (event) => {
              // The card sits inside profile/thread links elsewhere — never
              // let an action bubble into a navigation.
              event.preventDefault();
              event.stopPropagation();
              onClick();
            }
          : undefined
      }
      className={cn(
        "group inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-xs transition-colors",
        onClick && "hover:text-juke-text-on-dark",
        active && activeClassName,
        !onClick && "cursor-default",
      )}
    >
      <span
        className={cn(
          "transition-transform",
          !animated && "group-active:scale-90",
        )}
      >
        {icon}
      </span>
      {value !== undefined && value > 0 && (
        <span className="tabular-nums">{formatCount(value)}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function count(value: number): string {
  return value > 0 ? ` (${value})` : "";
}

function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** X-style focal timestamp: "3:42 PM · Oct 16, 2026". */
function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${time} · ${day}`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Icons (inline; no icon dependency in the landing package)
// ---------------------------------------------------------------------------

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ReplyIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
    </svg>
  );
}

function RecastIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4" />
      <path d="M14 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function HeartIcon({ filled }: { filled?: boolean }) {
  return (
    <svg {...ICON_PROPS} fill={filled ? "currentColor" : "none"}>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.5 1-1a5.5 5.5 0 0 0 0-7.9z" />
    </svg>
  );
}

function BookmarkIcon({ filled }: { filled?: boolean }) {
  return (
    <svg {...ICON_PROPS} fill={filled ? "currentColor" : "none"}>
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}
