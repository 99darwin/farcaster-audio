"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  miniAppUsesModal,
  type MiniAppWindowMode,
} from "@/lib/embeds/miniapp-browser-mode";
import { safeMiniAppUrl } from "@/lib/embeds/miniapp";

interface MiniAppBrowserProps {
  launchUrl: string;
  title?: string;
  onClose: () => void;
}

type LoadState = "loading" | "ready" | "slow" | "error";
type DockSide = "left" | "right";
type Position = { x: number; y: number };

const WINDOW_PREFERENCE_KEY = "juke:miniapp-window";
const VIEWPORT_MARGIN = 20;

function readWindowPreference(): {
  mode: "standard" | "docked";
  side: DockSide;
} {
  if (typeof window === "undefined") return { mode: "standard", side: "right" };
  try {
    const value = JSON.parse(window.localStorage.getItem(WINDOW_PREFERENCE_KEY) ?? "null") as {
      mode?: unknown;
      side?: unknown;
    } | null;
    return {
      mode: value?.mode === "docked" ? "docked" : "standard",
      side: value?.side === "left" ? "left" : "right",
    };
  } catch {
    return { mode: "standard", side: "right" };
  }
}

/**
 * A deliberately small browser surface for untrusted Farcaster mini apps.
 * Wallet/provider bridging is out of scope: the iframe only receives the web
 * capabilities listed in `allow`, and cannot navigate Juke's top-level page.
 */
export function MiniAppBrowser({
  launchUrl,
  title,
  onClose,
}: MiniAppBrowserProps) {
  const safeUrl = safeMiniAppUrl(launchUrl);
  const [frameKey, setFrameKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [initialPreference] = useState(readWindowPreference);
  const [windowMode, setWindowMode] = useState<MiniAppWindowMode>(
    initialPreference.mode,
  );
  const [dockSide, setDockSide] = useState<DockSide>(
    initialPreference.side,
  );
  const [position, setPosition] = useState<Position | null>(null);
  const [backgroundInteractive, setBackgroundInteractive] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(min-width: 640px)").matches,
  );
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [returnFocusTarget] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  });
  const restoreWindowRef = useRef<{
    mode: Exclude<MiniAppWindowMode, "maximized">;
    side: DockSide;
    position: Position | null;
  }>({
    mode: initialPreference.mode,
    side: initialPreference.side,
    position: null,
  });
  const dragRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    windowX: number;
    windowY: number;
    width: number;
    height: number;
  } | null>(null);

  const isModal = miniAppUsesModal({
    isDesktop,
    windowMode,
    backgroundInteractive,
  });

  const resetToStart = useCallback(() => {
    setLoadState("loading");
    setFrameKey((key) => key + 1);
  }, []);

  useEffect(() => {
    return () => {
      // Modal cleanup restores `inert` after this effect's cleanup may run.
      // Deferring one frame guarantees the trigger is focusable again first.
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        const focusIsUnclaimed =
          active === null || active === document.body || !active.isConnected;
        if (focusIsUnclaimed && returnFocusTarget?.isConnected) {
          returnFocusTarget.focus({ preventScroll: true });
        }
      });
    };
  }, [returnFocusTarget]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isDesktop || windowMode === "maximized") return;
    try {
      window.localStorage.setItem(
        WINDOW_PREFERENCE_KEY,
        JSON.stringify({
          mode: windowMode === "docked" ? "docked" : "standard",
          side: dockSide,
        }),
      );
    } catch {
      // Storage can be unavailable in privacy modes. Window controls still work.
    }
  }, [dockSide, isDesktop, windowMode]);

  useEffect(() => {
    if (!isModal) return;
    const previousOverflow = document.body.style.overflow;
    const overlay = overlayRef.current;
    const background = Array.from(document.body.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child !== overlay,
    );
    const backgroundState = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of background) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() =>
      closeRef.current?.focus(),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const keepFocusInside = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(event.target as Node)) {
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", keepFocusInside);
      for (const { element, inert, ariaHidden } of backgroundState) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
    };
  }, [isModal, onClose]);

  const clampPosition = useCallback(
    (x: number, y: number, width: number, height: number): Position => {
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const minX = viewportLeft + VIEWPORT_MARGIN;
      const minY = viewportTop + VIEWPORT_MARGIN;
      return {
        x: Math.min(
          Math.max(minX, x),
          Math.max(minX, viewportLeft + viewportWidth - width - VIEWPORT_MARGIN),
        ),
        y: Math.min(
          Math.max(minY, y),
          Math.max(minY, viewportTop + viewportHeight - height - VIEWPORT_MARGIN),
        ),
      };
    },
    [],
  );

  useEffect(() => {
    if (!isDesktop || windowMode !== "standard") return;
    const keepInViewport = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const rect = dialog.getBoundingClientRect();
      setPosition((current) =>
        current
          ? clampPosition(current.x, current.y, rect.width, rect.height)
          : current,
      );
    };
    window.addEventListener("resize", keepInViewport);
    window.visualViewport?.addEventListener("resize", keepInViewport);
    keepInViewport();
    return () => {
      window.removeEventListener("resize", keepInViewport);
      window.visualViewport?.removeEventListener("resize", keepInViewport);
    };
  }, [clampPosition, isDesktop, windowMode]);

  const startDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDesktop || windowMode !== "standard" || event.button !== 0) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      windowX: rect.left,
      windowY: rect.top,
      width: rect.width,
      height: rect.height,
    };
    setPosition({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const continueDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(
      clampPosition(
        drag.windowX + event.clientX - drag.pointerX,
        drag.windowY + event.clientY - drag.pointerY,
        drag.width,
        drag.height,
      ),
    );
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const dockWindow = () => {
    const rect = dialogRef.current?.getBoundingClientRect();
    const side =
      rect && rect.left + rect.width / 2 < window.innerWidth / 2
        ? "left"
        : "right";
    setDockSide(side);
    setWindowMode("docked");
  };

  const maximizeWindow = () => {
    restoreWindowRef.current = {
      mode: windowMode === "docked" ? "docked" : "standard",
      side: dockSide,
      position,
    };
    setWindowMode("maximized");
  };

  const restoreWindow = () => {
    const previous = restoreWindowRef.current;
    setDockSide(previous.side);
    setPosition(previous.position);
    setWindowMode(previous.mode);
  };

  useEffect(() => {
    if (loadState !== "loading") return;
    const timeout = window.setTimeout(() => setLoadState("slow"), 12_000);
    return () => window.clearTimeout(timeout);
  }, [frameKey, loadState]);

  if (!safeUrl || typeof document === "undefined") return null;
  const domain = new URL(safeUrl).hostname.replace(/^www\./, "");
  const appTitle = title?.trim() || domain;
  const isSameOrigin = new URL(safeUrl).origin === window.location.origin;
  const sandbox = isSameOrigin
    ? "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-scripts"
    : "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts";

  let dialogStyle: CSSProperties | undefined;
  if (isDesktop && windowMode === "standard") {
    dialogStyle = position
      ? { left: position.x, top: position.y }
      : { left: "50%", top: "50%", transform: "translate3d(-50%, -50%, 0)" };
  }

  const desktopWindowClass =
    windowMode === "docked"
      ? `fixed bottom-4 h-[min(620px,calc(100dvh-2rem))] w-[min(400px,calc(100vw-2rem))] rounded-[18px] ${dockSide === "left" ? "left-4" : "right-4"}`
      : windowMode === "maximized"
        ? "fixed inset-4 rounded-[18px]"
        : "fixed h-[min(820px,calc(100dvh-2.5rem))] w-[min(520px,calc(100vw-2.5rem))] rounded-[22px]";

  return createPortal(
    <div
      ref={overlayRef}
      role="presentation"
      className={`fixed inset-0 z-[100] ${isModal ? "bg-[#070711]/80 backdrop-blur-sm" : "pointer-events-none"}`}
      onPointerDown={(event) => {
        if (isModal && event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal={isModal ? "true" : undefined}
        aria-label={`${appTitle} mini app`}
        style={dialogStyle}
        className={`pointer-events-auto flex flex-col overflow-hidden border border-white/10 bg-juke-navy shadow-2xl ${isDesktop ? desktopWindowClass : "fixed inset-x-0 bottom-0 h-[94dvh] w-full rounded-t-[22px]"}`}
      >
        {isModal && (
          <span
            tabIndex={0}
            onFocus={() => iframeRef.current?.focus()}
            className="sr-only"
          />
        )}
        <header className="flex min-h-16 items-center gap-2 border-b border-white/10 bg-juke-surface px-2.5 py-2.5">
          <button
            type="button"
            onClick={resetToStart}
            aria-label="Back to mini app start"
            title="Back to start"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-white/10 hover:text-juke-text-on-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>

          <div
            onPointerDown={startDragging}
            onPointerMove={continueDragging}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onLostPointerCapture={() => {
              dragRef.current = null;
            }}
            title={
              isDesktop && windowMode === "standard" ? "Drag to move" : undefined
            }
            className={`min-w-0 flex-1 select-none text-center ${isDesktop && windowMode === "standard" ? "cursor-grab touch-none active:cursor-grabbing" : ""}`}
          >
            {isDesktop && windowMode === "standard" && (
              <span className="mb-1 flex justify-center gap-0.5 text-juke-text-on-dark-tertiary" aria-hidden="true">
                <i className="h-1 w-1 rounded-full bg-current" />
                <i className="h-1 w-1 rounded-full bg-current" />
                <i className="h-1 w-1 rounded-full bg-current" />
              </span>
            )}
            <p className="truncate text-[13px] font-semibold text-juke-text-on-dark">
              {appTitle}
            </p>
            <div className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-juke-text-on-dark-secondary">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" aria-hidden>
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span className="truncate">{domain}</span>
            </div>
          </div>

          {isDesktop && windowMode !== "docked" && (
            <button
              type="button"
              onClick={() => setBackgroundInteractive((interactive) => !interactive)}
              aria-label={
                backgroundInteractive
                  ? "Focus mini app and block the Juke background"
                  : "Browse Juke behind the mini app"
              }
              aria-pressed={backgroundInteractive}
              title={
                backgroundInteractive
                  ? "Focus mini app"
                  : "Browse Juke behind mini app"
              }
              className="flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-semibold text-juke-text-on-dark-secondary transition-colors hover:bg-white/10 hover:text-juke-text-on-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
            >
              {backgroundInteractive ? (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <path d="M8 12h8M12 8v8" />
                </svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
                  <circle cx="12" cy="12" r="2.5" />
                </svg>
              )}
              <span>{backgroundInteractive ? "Focus" : "Browse"}</span>
            </button>
          )}

          {isDesktop && (
            <button
              type="button"
              onClick={() => {
                if (windowMode === "docked") {
                  setPosition(null);
                  setWindowMode("standard");
                } else dockWindow();
              }}
              aria-label={
                windowMode === "docked" ? "Undock mini app" : "Dock mini app"
              }
              aria-pressed={windowMode === "docked"}
              title={windowMode === "docked" ? "Undock" : "Dock to edge"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-white/10 hover:text-juke-text-on-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
            >
              {windowMode === "docked" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="4" y="4" width="12" height="12" rx="2" />
                  <path d="M9 20h9a2 2 0 0 0 2-2V9" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d={dockSide === "left" ? "M9 3v18" : "M15 3v18"} />
                </svg>
              )}
            </button>
          )}

          {isDesktop && (
            <button
              type="button"
              onClick={() => {
                if (windowMode === "maximized") {
                  restoreWindow();
                } else maximizeWindow();
              }}
              aria-label={
                windowMode === "maximized"
                  ? "Restore mini app window"
                  : "Maximize mini app"
              }
              aria-pressed={windowMode === "maximized"}
              title={windowMode === "maximized" ? "Restore window" : "Maximize"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-white/10 hover:text-juke-text-on-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
            >
              {windowMode === "maximized" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
                </svg>
              )}
            </button>
          )}

          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            referrerPolicy="no-referrer"
            aria-label={`Open ${appTitle} in a new tab`}
            title="Open in new tab"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-white/10 hover:text-juke-text-on-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </a>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close mini app"
            title="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-juke-text-on-dark-secondary transition-colors hover:bg-white/10 hover:text-juke-text-on-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="relative min-h-0 flex-1 bg-[#11111f]">
          <iframe
            ref={iframeRef}
            key={frameKey}
            src={safeUrl}
            title={`${appTitle} mini app`}
            sandbox={sandbox}
            allow="autoplay; clipboard-write; fullscreen; web-share"
            referrerPolicy="no-referrer"
            onLoad={() => setLoadState("ready")}
            onError={() => setLoadState("error")}
            className="h-full w-full border-0 bg-[#11111f]"
          />

          {loadState === "loading" && (
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#11111f] text-center"
            >
              <span className="h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-juke-orange" aria-hidden />
              <p className="mt-4 text-sm font-medium text-juke-text-on-dark">
                Opening {appTitle}
              </p>
              <p className="mt-1 text-xs text-juke-text-on-dark-secondary">
                Mini apps run in a protected browser.
              </p>
            </div>
          )}

          {(loadState === "slow" || loadState === "error") && (
            <div
              role={loadState === "error" ? "alert" : "status"}
              className="absolute inset-x-3 bottom-3 rounded-xl border border-white/10 bg-juke-surface/95 p-3 shadow-xl backdrop-blur"
            >
              <p className="text-sm font-semibold text-juke-text-on-dark">
                {loadState === "error"
                  ? "This mini app couldn’t load here."
                  : "This mini app is taking a while."}
              </p>
              <p className="mt-0.5 text-xs text-juke-text-on-dark-secondary">
                Some apps only allow their own browser. You can retry or open it directly.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={resetToStart}
                  className="min-h-11 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-juke-text-on-dark hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
                >
                  Try again
                </button>
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  referrerPolicy="no-referrer"
                  className="inline-flex min-h-11 items-center rounded-lg bg-juke-orange px-3 py-2 text-xs font-semibold text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/70"
                >
                  Open in new tab
                </a>
              </div>
            </div>
          )}
        </div>
        {isModal && (
          <span
            tabIndex={0}
            onFocus={() => closeRef.current?.focus()}
            className="sr-only"
          />
        )}
      </section>
    </div>,
    document.body,
  );
}
