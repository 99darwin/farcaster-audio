"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from "framer-motion";
import type { Message } from "@/lib/api/messages.types";
import {
  formatFullTimestamp,
  formatMessageTime,
  profileHref,
  userLabel,
} from "@/lib/messages/format";
import { isDoubleTap, QUICK_TOGGLE_REACTION, type Tap } from "@/lib/messages/double-tap";
import type { ReadReceipt } from "@/lib/messages/receipts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/components/ui/cn";
import { MessageEmbeds } from "./MessageEmbeds";
import { HighlightedText, MessageText } from "./MessageText";
import { QUICK_REACTIONS, ReactionBar } from "./ReactionBar";
import {
  AlertGlyph,
  ClockGlyph,
  CopyIcon,
  PeopleGlyph,
  ReplyIcon,
  SmileIcon,
  TrashIcon,
} from "./icons";

/** Horizontal drag (px, leftwards) that triggers swipe-to-reply. */
const SWIPE_REPLY_THRESHOLD_PX = 64;
const SWIPE_MAX_PX = 88;
/** Drag distance at which the reply hint starts fading in. */
const REPLY_HINT_FADE_START_PX = 12;
/** Open the reaction bar below the bubble when it sits this close to the scroller top. */
const REACTION_BAR_FLIP_PX = 64;
/** Press-and-hold duration that opens the touch action menu. */
const LONG_PRESS_MS = 450;
/** Movement that cancels a pending long-press. */
const LONG_PRESS_SLOP_PX = 8;
/** Jump-target pulse (scale keyframes); skipped under prefers-reduced-motion (the ring still shows). */
const FLASH_PULSE = { scale: [1, 1.035, 1] };
const FLASH_PULSE_TRANSITION = { duration: 0.45, ease: "easeOut" } as const;
const REACTION_CHIP_TRANSITION = {
  type: "spring",
  stiffness: 520,
  damping: 28,
} as const;
/** Double-taps on these keep their own meaning (open link, play, jump to reply). */
const CONTROL_SELECTOR = "a, button, input, textarea, video, audio, [role='button']";

function isFromControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROL_SELECTOR) !== null;
}

const RECEIPT_LABELS: Record<ReadReceipt, string> = {
  sent: "Sent",
  seen: "Seen",
};

export interface MessageBubbleActions {
  onReply: (message: Message) => void;
  onToggleReaction: (message: Message, reaction: string) => void;
  onOpenReactors: (message: Message, reaction: string | null) => void;
  onJumpToMessage: (messageId: string) => void;
  onRetry: (message: Message) => void;
  onDiscard: (message: Message) => void;
  onDelete: (message: Message) => void;
  onCopy: (message: Message) => void;
}

export interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  isGroup: boolean;
  canWrite: boolean;
  isCoarsePointer: boolean;
  tabIndex: 0 | -1;
  highlightTerms?: readonly string[];
  isFlashing: boolean;
  /** "Sent"/"Seen" under the viewer's newest message in a 1:1 (null elsewhere). */
  readReceipt?: ReadReceipt | null;
  /** Upstream's reason a failed send was refused (`upstream_rejected`). */
  sendError?: string | null;
  actions: MessageBubbleActions;
}

function bubbleCorners(isOwn: boolean, isFirst: boolean, isLast: boolean): string {
  if (isOwn) {
    return cn("rounded-2xl", !isFirst && "rounded-tr-md", !isLast && "rounded-br-md");
  }
  return cn("rounded-2xl", !isFirst && "rounded-tl-md", !isLast && "rounded-bl-md");
}

function accessibleSummary(message: Message, isOwn: boolean): string {
  const who = isOwn ? "You" : userLabel(message.sender);
  const body = message.is_deleted ? "Message deleted" : message.text || "Attachment";
  const reply = message.in_reply_to ? `, replying to ${userLabel(message.in_reply_to.sender)}` : "";
  const reactions = message.reactions.length
    ? `, reactions: ${message.reactions.map((r) => `${r.reaction} ${r.count}`).join(", ")}`
    : "";
  const state =
    message.send_state === "failed"
      ? ", failed to send"
      : message.send_state === "sending"
        ? ", sending"
        : "";
  return `${who}${reply}: ${body}. ${formatFullTimestamp(message.sent_at)}${reactions}${state}`;
}

function MessageBubbleImpl({
  message,
  isOwn,
  isFirstInGroup,
  isLastInGroup,
  isGroup,
  canWrite,
  isCoarsePointer,
  tabIndex,
  highlightTerms,
  isFlashing,
  readReceipt = null,
  sendError = null,
  actions,
}: MessageBubbleProps) {
  const [isReactionBarOpen, setIsReactionBarOpen] = useState(false);
  const [reactionBarBelow, setReactionBarBelow] = useState(false);
  const [isTouchMenuOpen, setIsTouchMenuOpen] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  const didLongPressRef = useRef(false);
  /** Last touch tap, to pair a double-tap. */
  const lastTapRef = useRef<Tap | null>(null);
  /** Where the current touch began; a moved touch (swipe, scroll) isn't a tap. */
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  /** Input type of the latest press: `dblclick` is honoured for the mouse only. */
  const lastPointerTypeRef = useRef("mouse");

  const shouldReduceMotion = useReducedMotion() ?? false;
  const dragX = useMotionValue(0);
  const replyHintOpacity = useTransform(
    dragX,
    [-SWIPE_REPLY_THRESHOLD_PX, -REPLY_HINT_FADE_START_PX, 0],
    [1, 0.2, 0],
  );

  const isPending = Boolean(message.send_state);
  const isInteractive = !message.is_deleted && !isPending;
  const canReact = canWrite && isInteractive;
  const canReply = canWrite && isInteractive;
  const viewerReactions = useMemo(
    () => new Set(message.reactions.filter((r) => r.viewer_reacted).map((r) => r.reaction)),
    [message.reactions],
  );

  const openReactionBar = useCallback(() => {
    if (!canReact) return;
    const rect = rowRef.current?.getBoundingClientRect();
    const scroller = rowRef.current?.closest('[role="log"]')?.getBoundingClientRect();
    setReactionBarBelow(
      Boolean(rect && scroller && rect.top - scroller.top < REACTION_BAR_FLIP_PX),
    );
    setIsReactionBarOpen(true);
  }, [canReact]);

  const pickReaction = (emoji: string) => {
    setIsReactionBarOpen(false);
    setIsTouchMenuOpen(false);
    actions.onToggleReaction(message, emoji);
  };

  const closeMenuThen = (action: () => void) => () => {
    setIsTouchMenuOpen(false);
    action();
  };

  // --- touch: long-press + swipe ----------------------------------------

  const cancelLongPress = () => {
    if (longPressRef.current) clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    lastPointerTypeRef.current = event.pointerType;
    tapStartRef.current = { x: event.clientX, y: event.clientY };
    if (!isCoarsePointer || event.pointerType === "mouse" || !isInteractive) return;
    didLongPressRef.current = false;
    cancelLongPress();
    longPressRef.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        didLongPressRef.current = true;
        longPressRef.current = null;
        setIsTouchMenuOpen(true);
      }, LONG_PRESS_MS),
    };
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const pending = longPressRef.current;
    if (!pending) return;
    if (
      Math.abs(event.clientX - pending.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - pending.y) > LONG_PRESS_SLOP_PX
    ) {
      cancelLongPress();
    }
  };

  // --- quick reaction: double-tap (touch) / double-click (mouse) ----------
  // Accessible alternatives: the hover/"e" reaction bar and the touch menu.

  const toggleQuickReaction = () => {
    if (!canReact) return;
    actions.onToggleReaction(message, QUICK_TOGGLE_REACTION);
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    cancelLongPress();
    const start = tapStartRef.current;
    tapStartRef.current = null;
    if (event.pointerType === "mouse" || !canReact) return;
    const hasMoved =
      !start ||
      Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP_PX;
    if (didLongPressRef.current || hasMoved || isFromControl(event.target)) {
      lastTapRef.current = null;
      return;
    }
    const tap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    if (isDoubleTap(lastTapRef.current, tap)) {
      lastTapRef.current = null;
      toggleQuickReaction();
    } else {
      lastTapRef.current = tap;
    }
  };

  const handleDoubleClick = (event: React.MouseEvent) => {
    // Touch double-taps are paired in handlePointerUp; a synthesized
    // dblclick after them must not toggle the heart back off.
    if (lastPointerTypeRef.current !== "mouse" || !canReact || isFromControl(event.target)) return;
    // Drop the word selection the double-click just made.
    window.getSelection()?.removeAllRanges();
    toggleQuickReaction();
  };

  const handleDragEnd = (_event: unknown, info: PanInfo) => {
    if (info.offset.x <= -SWIPE_REPLY_THRESHOLD_PX && canReply) actions.onReply(message);
  };

  // --- keyboard ----------------------------------------------------------

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (event.key === "r" && canReply) {
      event.preventDefault();
      actions.onReply(message);
    } else if (event.key === "e" && canReact) {
      event.preventDefault();
      openReactionBar();
    } else if ((event.key === "Delete" || event.key === "Backspace") && isOwn && isInteractive) {
      event.preventDefault();
      setIsConfirmingDelete(true);
    } else if (event.key === "Enter" && message.in_reply_to) {
      event.preventDefault();
      actions.onJumpToMessage(message.in_reply_to.message_id);
    }
  };

  const showSenderName = isGroup && !isOwn && isFirstInGroup;
  const showAvatar = isGroup && !isOwn;
  const ownLinkClass = "text-white underline underline-offset-2";

  const bubbleBody = (
    <div
      className={cn(
        "relative max-w-full px-3 py-2 text-[15px] leading-snug",
        bubbleCorners(isOwn, isFirstInGroup, isLastInGroup),
        isOwn ? "bg-juke-orange text-white" : "bg-juke-surface text-juke-text-on-dark",
        message.send_state === "sending" && "opacity-70",
        message.send_state === "failed" && "ring-1 ring-red-400/70",
        isFlashing && "ring-2 ring-juke-purple ring-offset-2 ring-offset-juke-navy",
        "transition-shadow duration-300",
      )}
    >
      {showSenderName && (
        <Link
          href={profileHref(message.sender)}
          className="mb-0.5 block truncate text-xs font-semibold text-juke-purple hover:underline"
        >
          {userLabel(message.sender)}
        </Link>
      )}

      {message.in_reply_to && !message.is_deleted && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            actions.onJumpToMessage(message.in_reply_to!.message_id);
          }}
          aria-label={`Jump to replied message from ${userLabel(message.in_reply_to.sender)}`}
          className={cn(
            "mb-1.5 block w-full min-w-0 rounded-lg border-l-2 px-2 py-1 text-left text-xs transition-colors",
            isOwn
              ? "border-white/80 bg-white/15 hover:bg-white/25"
              : "border-juke-purple bg-juke-navy/50 hover:bg-juke-navy/80",
          )}
        >
          <span
            className={cn(
              "block truncate font-semibold",
              isOwn ? "text-white" : "text-juke-purple",
            )}
          >
            {userLabel(message.in_reply_to.sender)}
          </span>
          <span
            className={cn(
              "line-clamp-2 block",
              isOwn ? "text-white/85" : "text-juke-text-on-dark-secondary",
            )}
          >
            {message.in_reply_to.is_deleted
              ? "Message deleted"
              : message.in_reply_to.text || "Attachment"}
          </span>
        </button>
      )}

      {message.is_deleted ? (
        <p className={cn("italic", isOwn ? "text-white/80" : "text-juke-text-on-dark-tertiary")}>
          Message deleted
        </p>
      ) : (
        message.text && (
          <MessageText
            text={message.text}
            highlightTerms={highlightTerms}
            linkClassName={isOwn ? ownLinkClass : undefined}
          />
        )
      )}

      {!message.is_deleted && message.metadata && <MessageEmbeds metadata={message.metadata} />}

      <span
        className={cn(
          "mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none",
          isOwn ? "text-white/75" : "text-juke-text-on-dark-tertiary",
        )}
      >
        <time
          dateTime={new Date(message.sent_at).toISOString()}
          title={formatFullTimestamp(message.sent_at)}
        >
          {formatMessageTime(message.sent_at)}
        </time>
        {message.send_state === "sending" && <ClockGlyph className="h-3 w-3" />}
        {message.send_state === "failed" && <AlertGlyph className="h-3.5 w-3.5 text-red-200" />}
      </span>
    </div>
  );

  return (
    <div
      ref={rowRef}
      className={cn(
        "group/message relative flex items-end gap-2 px-3 md:px-4",
        isOwn ? "justify-end" : "justify-start",
        isLastInGroup ? "pb-2" : "pb-0.5",
      )}
    >
      {showAvatar && (
        <div className="w-8 shrink-0">
          {isLastInGroup && (
            <Link
              href={profileHref(message.sender)}
              aria-label={`${userLabel(message.sender)}'s profile`}
              tabIndex={-1}
            >
              <Avatar src={message.sender.pfp_url} name={userLabel(message.sender)} size="sm" />
            </Link>
          )}
        </div>
      )}

      <div
        className={cn(
          "relative flex min-w-0 max-w-[85%] flex-col sm:max-w-[75%] lg:max-w-[65%]",
          isOwn ? "items-end" : "items-start",
        )}
      >
        {/* Swipe-to-reply hint, revealed under the dragged bubble. */}
        {isCoarsePointer && canReply && (
          <motion.span
            aria-hidden
            style={{ opacity: replyHintOpacity }}
            className="pointer-events-none absolute -right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 translate-x-full items-center justify-center rounded-full bg-juke-surface text-juke-text-on-dark-secondary"
          >
            <ReplyIcon className="h-4 w-4" />
          </motion.span>
        )}

        <motion.div
          data-row-focus
          tabIndex={tabIndex}
          role="article"
          aria-label={accessibleSummary(message, isOwn)}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            cancelLongPress();
            tapStartRef.current = null;
            lastTapRef.current = null;
          }}
          onDoubleClick={handleDoubleClick}
          onContextMenu={(event) => {
            // Touch long-press opens our menu instead of the browser's.
            if (isCoarsePointer && isInteractive) event.preventDefault();
          }}
          onClickCapture={(event) => {
            if (didLongPressRef.current) {
              event.preventDefault();
              event.stopPropagation();
              didLongPressRef.current = false;
            }
          }}
          drag={isCoarsePointer && canReply ? "x" : false}
          dragDirectionLock
          dragConstraints={{ left: -SWIPE_MAX_PX, right: 0 }}
          dragElastic={{ left: 0.15, right: 0 }}
          dragSnapToOrigin
          onDragStart={cancelLongPress}
          onDragEnd={handleDragEnd}
          style={{ x: dragX, touchAction: "pan-y" }}
          animate={isFlashing && !shouldReduceMotion ? FLASH_PULSE : undefined}
          transition={FLASH_PULSE_TRANSITION}
          className="max-w-full rounded-2xl outline-none select-text focus-visible:ring-2 focus-visible:ring-juke-orange focus-visible:ring-offset-2 focus-visible:ring-offset-juke-navy"
        >
          {bubbleBody}
        </motion.div>

        {message.reactions.length > 0 && (
          <div
            className={cn(
              "mt-1 flex flex-wrap items-center gap-1",
              isOwn ? "justify-end" : "justify-start",
            )}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {message.reactions.map((reaction) => (
                <motion.button
                  key={reaction.reaction}
                  layout={!shouldReduceMotion}
                  initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                  whileTap={shouldReduceMotion ? undefined : { scale: 0.9 }}
                  transition={REACTION_CHIP_TRANSITION}
                  type="button"
                  disabled={!canReact}
                  aria-pressed={reaction.viewer_reacted}
                  aria-label={`${reaction.reaction} ${reaction.count}${reaction.viewer_reacted ? ", including you" : ""}. Toggle reaction`}
                  onClick={() => actions.onToggleReaction(message, reaction.reaction)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    actions.onOpenReactors(message, reaction.reaction);
                  }}
                  className={cn(
                    "flex h-7 items-center gap-1 rounded-full border px-2 text-sm transition-colors disabled:cursor-default",
                    reaction.viewer_reacted
                      ? "border-juke-orange/70 bg-juke-orange/20 text-juke-text-on-dark"
                      : "border-juke-border bg-juke-surface text-juke-text-on-dark-secondary hover:border-juke-text-on-dark-tertiary",
                  )}
                >
                  <span aria-hidden>{reaction.reaction}</span>
                  <motion.span
                    key={reaction.count}
                    aria-hidden
                    initial={shouldReduceMotion ? false : { y: -6, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={REACTION_CHIP_TRANSITION}
                    className="text-xs font-semibold tabular-nums"
                  >
                    {reaction.count}
                  </motion.span>
                </motion.button>
              ))}
            </AnimatePresence>
            <button
              type="button"
              onClick={() => actions.onOpenReactors(message, null)}
              aria-label="See who reacted"
              title="See who reacted"
              className="flex h-7 w-7 items-center justify-center rounded-full text-juke-text-on-dark-tertiary transition-colors hover:bg-juke-surface hover:text-juke-text-on-dark"
            >
              <PeopleGlyph className="h-4 w-4" />
            </button>
          </div>
        )}

        {readReceipt && (
          <p
            className="mt-0.5 px-1 text-[11px] font-medium text-juke-text-on-dark-tertiary"
            aria-label={readReceipt === "seen" ? "Seen by recipient" : "Sent, not seen yet"}
          >
            {RECEIPT_LABELS[readReceipt]}
          </p>
        )}

        {message.send_state === "failed" && (
          <p role="alert" className="mt-1 flex items-center gap-2 text-xs text-red-300">
            {sendError ? `Not sent: ${sendError}` : "Not sent."}
            <button
              type="button"
              onClick={() => actions.onRetry(message)}
              className="font-semibold text-juke-text-on-dark underline-offset-2 hover:underline"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => actions.onDiscard(message)}
              className="text-juke-text-on-dark-secondary underline-offset-2 hover:underline"
            >
              Delete
            </button>
          </p>
        )}

        {/* Hover action bar (fine pointers + keyboard focus). */}
        {!isCoarsePointer && isInteractive && (canReply || canReact || isOwn || message.text) && (
          <div
            className={cn(
              "pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-full border border-juke-border bg-juke-surface p-0.5 opacity-0 shadow-lg transition-opacity",
              "group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
              isOwn ? "right-full mr-1.5" : "left-full ml-1.5",
              isReactionBarOpen && "pointer-events-auto opacity-100",
            )}
          >
            {canReact && (
              <ActionButton label="React (e)" onClick={openReactionBar}>
                <SmileIcon className="h-4 w-4" />
              </ActionButton>
            )}
            {canReply && (
              <ActionButton label="Reply (r)" onClick={() => actions.onReply(message)}>
                <ReplyIcon className="h-4 w-4" />
              </ActionButton>
            )}
            {message.text && (
              <ActionButton label="Copy text" onClick={() => actions.onCopy(message)}>
                <CopyIcon className="h-4 w-4" />
              </ActionButton>
            )}
            {isOwn && canWrite && (
              <ActionButton label="Delete message" onClick={() => setIsConfirmingDelete(true)}>
                <TrashIcon className="h-4 w-4" />
              </ActionButton>
            )}
          </div>
        )}

        {isReactionBarOpen && (
          <ReactionBar
            activeReactions={viewerReactions}
            onPick={pickReaction}
            onClose={() => setIsReactionBarOpen(false)}
            className={cn(
              "absolute",
              reactionBarBelow ? "top-full mt-1" : "bottom-full mb-1",
              isOwn ? "right-0" : "left-0",
            )}
          />
        )}
      </div>

      {isCoarsePointer && (
        <Sheet open={isTouchMenuOpen} onClose={() => setIsTouchMenuOpen(false)} title="Message">
          <div className="flex flex-col gap-3 pb-[env(safe-area-inset-bottom)]">
            {canReact && (
              <div className="flex justify-between gap-1" role="group" aria-label="React">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-pressed={viewerReactions.has(emoji)}
                    aria-label={`React ${emoji}`}
                    onClick={() => pickReaction(emoji)}
                    className={cn(
                      "flex h-12 w-12 items-center justify-center rounded-full text-2xl",
                      viewerReactions.has(emoji) ? "bg-juke-orange/25" : "bg-juke-navy",
                    )}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-col overflow-hidden rounded-xl bg-juke-navy">
              {canReply && (
                <SheetAction
                  label="Reply"
                  icon={<ReplyIcon className="h-5 w-5" />}
                  onClick={closeMenuThen(() => actions.onReply(message))}
                />
              )}
              {canReact && (
                <SheetAction
                  label="More reactions"
                  icon={<SmileIcon className="h-5 w-5" />}
                  onClick={closeMenuThen(() => openReactionBar())}
                />
              )}
              {message.text && (
                <SheetAction
                  label="Copy text"
                  icon={<CopyIcon className="h-5 w-5" />}
                  onClick={closeMenuThen(() => actions.onCopy(message))}
                />
              )}
              {isOwn && canWrite && (
                <SheetAction
                  label="Delete"
                  destructive
                  icon={<TrashIcon className="h-5 w-5" />}
                  onClick={closeMenuThen(() => setIsConfirmingDelete(true))}
                />
              )}
            </div>
          </div>
        </Sheet>
      )}

      <Modal
        open={isConfirmingDelete}
        onClose={() => setIsConfirmingDelete(false)}
        title="Delete message?"
        className="max-w-sm"
      >
        <p className="text-sm text-juke-text-on-dark-secondary">
          This deletes the message for everyone in the conversation.
        </p>
        {message.text && (
          <p className="mt-3 line-clamp-3 rounded-lg bg-juke-navy px-3 py-2 text-sm text-juke-text-on-dark">
            <HighlightedText text={message.text} />
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setIsConfirmingDelete(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setIsConfirmingDelete(false);
              actions.onDelete(message);
            }}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-juke-border hover:text-juke-text-on-dark"
    >
      {children}
    </button>
  );
}

function SheetAction({
  label,
  icon,
  onClick,
  destructive = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 border-b border-juke-border px-4 py-3 text-left text-base font-medium last:border-b-0",
        destructive ? "text-red-300" : "text-juke-text-on-dark",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
