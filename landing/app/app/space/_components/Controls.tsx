"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";

const REACTION_KEYS = ["❤️", "🔥", "👏", "😂", "🎉", "💯"] as const;

interface ControlsProps {
  /** Whether the local user can publish audio (host/co-host/speaker). */
  canSpeak: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  micPermissionDenied: boolean;
  onToggleMute: () => void;
  onToggleRaiseHand: () => void;
  onRetryMic: () => void;
  onReact: (key: string) => void;
  onLeave: () => void;
  /**
   * Opens the audio-sources mixer panel. The button renders only when this is
   * provided AND the user can publish — listeners never see it.
   */
  onOpenSources?: () => void;
}

/**
 * Compact single-row bottom control bar for the space screen.
 *
 * Layout: [primary action] ── [emoji popover] [leave]
 *
 * Speakers get a mic toggle (with accent ring when muted to prompt unmute);
 * listeners get raise-hand; mic-denied gets a retry gesture. Emoji reactions
 * collapse behind a single 😀 trigger that pops a strip upward. Both the
 * listener view and host console mount this same bar — host-specific
 * moderation lives in the separate HostPanel sheet.
 */
export function Controls({
  canSpeak,
  isMuted,
  isHandRaised,
  micPermissionDenied,
  onToggleMute,
  onToggleRaiseHand,
  onRetryMic,
  onReact,
  onLeave,
  onOpenSources,
}: ControlsProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40">
      <div className="mx-auto max-w-2xl px-4 pb-4">
        <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-juke-surface/95 px-3 py-2.5 shadow-2xl backdrop-blur-md">
          {/* Primary action ------------------------------------------------ */}
          {micPermissionDenied ? (
            <button
              type="button"
              onClick={onRetryMic}
              aria-label="Microphone access blocked — tap to retry"
              className="flex items-center gap-1.5 rounded-xl bg-juke-orange/20 px-3 py-2 text-sm font-semibold text-juke-orange transition-all hover:bg-juke-orange/30 active:scale-95"
            >
              <MicOffIcon />
              Retry mic
            </button>
          ) : canSpeak ? (
            <button
              type="button"
              onClick={onToggleMute}
              aria-pressed={!isMuted}
              aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
              className={cn(
                "flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-all active:scale-95",
                isMuted
                  ? // Muted: orange ring draws attention — tap to unmute
                    "ring-2 ring-juke-orange bg-juke-navy text-juke-text-on-dark hover:bg-white/10"
                  : // Live: subtle active state — clearly speaking
                    "bg-juke-orange/20 text-juke-orange hover:bg-juke-orange/30",
              )}
            >
              {isMuted ? <MicOffIcon /> : <MicIcon />}
              {isMuted ? "Unmute" : "Mute"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onToggleRaiseHand}
              aria-pressed={isHandRaised}
              aria-label={isHandRaised ? "Lower hand" : "Raise hand to speak"}
              className={cn(
                "flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-all active:scale-95",
                isHandRaised
                  ? "bg-juke-orange text-white hover:bg-juke-orange-hover"
                  : "bg-juke-navy text-juke-text-on-dark hover:bg-white/10",
              )}
            >
              <HandIcon />
              {isHandRaised ? "Lower hand" : "Raise hand"}
            </button>
          )}

          {/* Sources — audio mixer for publishers. Shown even when the mic is
              denied: computer audio / line-in can still publish without it. */}
          {canSpeak && onOpenSources && (
            <button
              type="button"
              onClick={onOpenSources}
              aria-haspopup="dialog"
              aria-label="Open audio sources mixer"
              className="flex items-center gap-1.5 rounded-xl bg-juke-navy px-3 py-2 text-sm font-semibold text-juke-text-on-dark transition-all hover:bg-white/10 active:scale-95"
            >
              <SlidersIcon />
              <span className="hidden sm:inline">Sources</span>
            </button>
          )}

          {/* Push right group to the end ----------------------------------- */}
          <div className="flex-1" />

          {/* Emoji popover ------------------------------------------------- */}
          <EmojiPopover onReact={onReact} />

          {/* Leave --------------------------------------------------------- */}
          <button
            type="button"
            onClick={onLeave}
            aria-label="Leave space"
            className="flex items-center gap-1.5 rounded-xl bg-juke-navy px-3 py-2 text-sm font-semibold text-red-400 transition-all hover:bg-red-500/15 active:scale-95"
          >
            <LeaveIcon />
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

// ── EmojiPopover ────────────────────────────────────────────────────────────

interface EmojiPopoverProps {
  onReact: (key: string) => void;
}

/**
 * A 😀 trigger button that opens a small strip of reaction emoji above the
 * controls bar. Closes on Escape or click outside.
 *
 * Accessibility:
 * - Popover uses role="menu"; each emoji uses role="menuitem".
 * - First emoji receives focus when the menu opens; trigger regains focus on close.
 * - Left/Right arrow keys cycle focus within the menu.
 */
function EmojiPopover({ onReact }: EmojiPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const emojiRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Auto-focus first emoji when menu opens; return focus to trigger on close.
  useEffect(() => {
    if (open) {
      emojiRefs.current[0]?.focus();
    } else {
      triggerRef.current?.focus();
    }
  }, [open]);

  // Close on Escape key.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Close on outside click/touch.
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [open]);

  const handleReact = useCallback(
    (key: string) => {
      // Keep the strip open so reactions can be fired rapidly ("spammed")
      // without reopening. It closes on Escape, outside-click, or the toggle.
      onReact(key);
    },
    [onReact],
  );

  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const buttons = emojiRefs.current.filter(
        (b): b is HTMLButtonElement => b !== null,
      );
      const currentIndex = buttons.findIndex(
        (btn) => btn === document.activeElement,
      );
      if (e.key === "ArrowRight") {
        e.preventDefault();
        buttons[(currentIndex + 1) % buttons.length]?.focus();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus();
      }
    },
    [],
  );

  return (
    <div ref={containerRef} className="relative">
      {/* Popover strip — floats upward from the trigger */}
      {open && (
        <div
          id="emoji-popover-strip"
          role="menu"
          aria-label="Emoji reactions"
          onKeyDown={handleMenuKeyDown}
          className="absolute bottom-full right-0 mb-2 flex items-center gap-1 rounded-2xl border border-white/10 bg-juke-surface/98 px-2.5 py-2 shadow-2xl backdrop-blur-md"
        >
          {REACTION_KEYS.map((key, i) => (
            <button
              key={key}
              ref={(el) => {
                emojiRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              onClick={() => handleReact(key)}
              aria-label={`React ${key}`}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-xl transition-transform hover:scale-125 active:scale-90"
            >
              {key}
            </button>
          ))}
        </div>
      )}

      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="emoji-popover-strip"
        aria-label="Open emoji reactions"
        className="flex items-center gap-1 rounded-xl bg-juke-navy px-3 py-2 text-xl leading-none transition-colors hover:bg-white/10 active:scale-95"
      >
        😀
        <ChevronUpIcon
          className={cn(
            "h-2.5 w-2.5 text-juke-text-on-dark-secondary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
    </div>
  );
}

// ── Icon components ──────────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="M9 9v2a3 3 0 0 0 4.5 2.6M15 11V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 10.5 6M12 18v3M4 4l16 16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11m0 0V5a1.5 1.5 0 0 1 3 0v6m0 0V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.5L3 14.5a1.6 1.6 0 0 1 2.6-1.8L7 14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="M5 4v6m0 4v6m7-16v2m0 4v10m7-16v10m0 4v2M3 12h4m3-4h4m3 10h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LeaveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 10 6"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M1 5L5 1l4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
