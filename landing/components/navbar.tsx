"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";

const SCROLL_THRESHOLD_PX = 12;

/** Small disclosure for the nav links that don't fit at narrow widths
 * (below `sm`). "Launch app" always stays visible in the main bar. */
function MobileNavMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative sm:hidden">
      <button
        type="button"
        aria-label="More links"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-juke-text-secondary transition-colors hover:bg-juke-navy/[0.05] hover:text-juke-text-primary focus-visible:ring-2 focus-visible:ring-juke-purple"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="19" cy="12" r="1.5" fill="currentColor" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 flex min-w-[9rem] flex-col gap-1 rounded-2xl bg-juke-cream p-1.5 shadow-lg shadow-juke-navy/[0.1] ring-1 ring-juke-navy/[0.07]">
          <Link
            href="/leaderboard"
            onClick={() => setIsOpen(false)}
            className="rounded-xl px-3 py-2 text-sm font-semibold text-juke-text-secondary transition-colors hover:bg-juke-navy/[0.05] hover:text-juke-text-primary focus-visible:ring-2 focus-visible:ring-juke-purple"
          >
            Leaderboard
          </Link>
          <Link
            href="/developers"
            onClick={() => setIsOpen(false)}
            className="rounded-xl px-3 py-2 text-sm font-semibold text-juke-text-secondary transition-colors hover:bg-juke-navy/[0.05] hover:text-juke-text-primary focus-visible:ring-2 focus-visible:ring-juke-purple"
          >
            Developers
          </Link>
        </div>
      )}
    </div>
  );
}

export function Navbar() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > SCROLL_THRESHOLD_PX);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-4 pt-3 sm:px-6 sm:pt-4">
      <nav
        aria-label="Main"
        className={`mx-auto flex max-w-5xl items-center justify-between rounded-full py-2 pl-4 pr-2 transition-all duration-300 sm:pl-5 ${
          isScrolled
            ? "bg-juke-cream/85 shadow-lg shadow-juke-navy/[0.06] ring-1 ring-juke-navy/[0.07] backdrop-blur-md"
            : "bg-transparent"
        }`}
      >
        <Link
          href="/"
          className="flex items-center gap-2 rounded-full focus-visible:ring-2 focus-visible:ring-juke-purple"
          aria-label="Juke home"
        >
          <Image
            src="/logomark.png"
            alt=""
            width={64}
            height={64}
            sizes="32px"
            className="h-8 w-8 brightness-0"
            priority
          />
          <span className="font-display text-lg font-bold tracking-[0.18em] text-juke-text-primary">
            JUKE
          </span>
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/leaderboard"
            className="hidden rounded-full px-3 py-2 text-sm font-semibold text-juke-text-secondary transition-colors hover:bg-juke-navy/[0.05] hover:text-juke-text-primary focus-visible:ring-2 focus-visible:ring-juke-purple sm:flex sm:px-4"
          >
            Leaderboard
          </Link>
          <Link
            href="/developers"
            className="hidden rounded-full px-3 py-2 text-sm font-semibold text-juke-text-secondary transition-colors hover:bg-juke-navy/[0.05] hover:text-juke-text-primary focus-visible:ring-2 focus-visible:ring-juke-purple sm:flex sm:px-4"
          >
            Developers
          </Link>
          <Link
            href="/app"
            className="rounded-full bg-juke-purple px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-juke-purple-hover focus-visible:ring-2 focus-visible:ring-juke-purple focus-visible:ring-offset-2 focus-visible:ring-offset-juke-cream sm:px-5"
          >
            Launch app
          </Link>
          <MobileNavMenu />
        </div>
      </nav>
    </header>
  );
}
