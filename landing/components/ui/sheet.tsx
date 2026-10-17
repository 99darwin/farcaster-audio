"use client";

import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "./cn";

export type SheetSide = "bottom" | "right";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  /** Slide-in edge. `bottom` suits mobile; `right` suits desktop drawers. */
  side?: SheetSide;
  className?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

const PANEL_VARIANTS: Record<SheetSide, Variants> = {
  bottom: { hidden: { y: "100%" }, visible: { y: 0 } },
  right: { hidden: { x: "100%" }, visible: { x: 0 } },
};

const SIDE_CLASSES: Record<SheetSide, { container: string; panel: string }> = {
  bottom: {
    container: "items-end justify-center",
    panel:
      "w-full max-w-lg rounded-t-2xl border-t border-x border-juke-border",
  },
  right: {
    container: "items-stretch justify-end",
    panel: "h-full w-full max-w-sm border-l border-juke-border",
  },
};

/**
 * Edge-anchored panel (bottom sheet / side drawer). Same a11y contract as
 * {@link Modal}: ESC + backdrop close, scroll-lock, focus trap, role=dialog.
 */
export function Sheet({
  open,
  onClose,
  children,
  title,
  side = "bottom",
  className,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const classes = SIDE_CLASSES[side];
  const variants = PANEL_VARIANTS[side];
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Remember the trigger so focus can return to it on close (WCAG 2.4.3).
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
      returnFocusRef.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Escape is handled on the sheet's own subtree (not document-level) so a
      // nested portaled dialog — e.g. HostPanel's confirm Modal — can absorb its
      // own Escape without also collapsing this sheet. The focus trap below
      // keeps focus inside the panel, so this handler reliably sees the key.
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const target = panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target.focus();
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn("fixed inset-0 z-50 flex", classes.container)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onKeyDown={handleKeyDown}
        >
          {/* Backdrop. The click handler lives HERE (not on the flex container)
              because this absolutely-positioned layer covers the container and
              intercepts every outside click — a `target === currentTarget` check
              on the parent would therefore never match, leaving the sheet
              impossible to dismiss by clicking away. */}
          <button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            onMouseDown={onClose}
            className="absolute inset-0 h-full w-full cursor-default bg-juke-navy/70 backdrop-blur-sm"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            tabIndex={-1}
            variants={variants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className={cn(
              "relative z-10 bg-juke-surface p-6 text-juke-text-on-dark shadow-2xl outline-none",
              classes.panel,
              className,
            )}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              {title ? (
                <h2 id={titleId} className="text-lg font-bold">
                  {title}
                </h2>
              ) : (
                <span />
              )}
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="-mr-1.5 -mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-juke-navy/40 hover:text-juke-text-on-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="h-4 w-4"
                  aria-hidden
                >
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
