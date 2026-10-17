"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/components/ui/cn";
import { EmojiPicker } from "./EmojiPicker";

/** Same quick set as the space screen's reaction row. */
export const QUICK_REACTIONS = ["❤️", "🔥", "👏", "😂", "🎉", "💯"] as const;

export interface ReactionBarProps {
  /** Reactions the viewer already left (rendered pressed). */
  activeReactions: ReadonlySet<string>;
  onPick: (emoji: string) => void;
  onClose: () => void;
  className?: string;
}

/**
 * Quick-reaction pill with a "more" button that expands into the full emoji
 * picker. Arrow keys move between options, Escape closes.
 */
export function ReactionBar({ activeReactions, onPick, onClose, className }: ReactionBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onClose]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (isExpanded || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const buttons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-quick-reaction]") ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowRight" ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
    event.preventDefault();
  };

  return (
    <motion.div
      ref={rootRef}
      role="dialog"
      aria-label="React to message"
      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      onKeyDown={handleKeyDown}
      className={cn(
        "z-30 rounded-2xl border border-juke-border bg-juke-surface p-1.5 shadow-2xl",
        className,
      )}
    >
      {isExpanded ? (
        <div className="p-1">
          <EmojiPicker onPick={onPick} />
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          {QUICK_REACTIONS.map((emoji) => {
            const isActive = activeReactions.has(emoji);
            return (
              <button
                key={emoji}
                type="button"
                data-quick-reaction
                aria-pressed={isActive}
                aria-label={`React ${emoji}`}
                onClick={() => onPick(emoji)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full text-xl transition-transform hover:scale-110 motion-reduce:hover:scale-100",
                  isActive && "bg-juke-orange/25",
                )}
              >
                {emoji}
              </button>
            );
          })}
          <button
            type="button"
            data-quick-reaction
            aria-label="More reactions"
            onClick={() => setIsExpanded(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-juke-text-on-dark-secondary transition-colors hover:bg-juke-border hover:text-juke-text-on-dark"
          >
            <span aria-hidden>+</span>
          </button>
        </div>
      )}
    </motion.div>
  );
}
