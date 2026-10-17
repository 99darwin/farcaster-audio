"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Optional accessible title; wired to aria-labelledby when provided. */
  title?: string;
  className?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/**
 * Centered dialog with a dimmed backdrop. Handles ESC + backdrop-click close,
 * body scroll-lock, initial focus, and a lightweight focus trap. Motion is a
 * fade+scale that respects reduced-motion via the global CSS override.
 */
export function Modal({ open, onClose, children, title, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // SSR guard: only portal into document.body after client mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

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

  // Native document-level Escape listener — fires regardless of where focus
  // sits (body, an element outside the React tree, etc.). This is the
  // belt-and-suspenders fix: the React onKeyDown below handles the in-dialog
  // case, but if focus is outside the modal's subtree the synthetic handler
  // never fires. stopPropagation prevents useKeyboardShortcuts from also
  // processing the same Escape press via the window listener.
  useEffect(() => {
    if (!open) return;
    function handleDocEscape(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleDocEscape);
    return () => document.removeEventListener("keydown", handleDocEscape);
  }, [open, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Escape is handled by the document-level native listener above so that
      // it fires even when focus sits outside the dialog's React subtree. We
      // do NOT call stopPropagation here to avoid interfering with that path.
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
    [],
  );

  useEffect(() => {
    if (!open) return;
    // Focus the first focusable node (or the panel) once mounted.
    const panel = panelRef.current;
    if (!panel) return;
    const target =
      panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target.focus();
  }, [open]);

  const content = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => {
            // Close only when the backdrop itself is pressed, not the panel.
            if (e.target === e.currentTarget) onClose();
          }}
          onKeyDown={handleKeyDown}
        >
          <div className="absolute inset-0 bg-juke-navy/70 backdrop-blur-sm" />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={cn(
              "relative z-10 w-full max-w-md rounded-2xl border border-juke-border bg-juke-surface p-6 text-juke-text-on-dark shadow-2xl outline-none",
              className,
            )}
          >
            {title && (
              <h2 id={titleId} className="mb-4 text-lg font-bold">
                {title}
              </h2>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Portal into document.body so the modal escapes any stacking-context
  // isolation created by ancestors (sticky headers, transformed elements,
  // z-indexed components in <main>). Falls back to inline render on the
  // server / before first client paint.
  return mounted ? createPortal(content, document.body) : content;
}
