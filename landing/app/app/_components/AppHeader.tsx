"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/cn";

export interface AppHeaderProps {
  /**
   * Unread notifications count for the header badge. Defaults to 0 so Stream H
   * can wire the real count later without editing this file.
   */
  unreadCount?: number;
}

/**
 * Top app bar: Juke logomark (links home), and a right-side auth control.
 * When authenticated it shows an avatar button that opens a small menu
 * (profile + sign out); when anonymous it shows a "Connect" button that calls
 * `signIn()`. While the session is resolving it shows a spinner.
 */
export function AppHeader({ unreadCount = 0 }: AppHeaderProps) {
  const { user, status, signIn, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the avatar menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const handleConnect = useCallback(async () => {
    setSigningIn(true);
    try {
      await signIn();
    } finally {
      setSigningIn(false);
    }
  }, [signIn]);

  const handleSignOut = useCallback(async () => {
    setMenuOpen(false);
    await signOut();
  }, [signOut]);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-juke-border bg-juke-navy/95 px-4 backdrop-blur-sm">
      <Link href="/app" aria-label="Juke home" className="flex items-center">
        <Image
          src="/logomark.png"
          alt="Juke"
          width={28}
          height={28}
          priority
          className="h-7 w-7"
        />
      </Link>

      <div className="flex items-center gap-2">
        {status === "loading" && <Spinner size="sm" />}

        {status === "anonymous" && (
          <Button
            size="sm"
            onClick={handleConnect}
            loading={signingIn}
          >
            Connect
          </Button>
        )}

        {status === "authenticated" && user && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
              onClick={() => setMenuOpen((v) => !v)}
              className="relative flex items-center rounded-full transition-opacity hover:opacity-90"
            >
              <Avatar src={user.pfp_url} name={user.display_name} size="sm" />
              {unreadCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-juke-orange px-1 text-[10px] font-bold leading-none text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-11 w-48 overflow-hidden rounded-xl border border-juke-border bg-juke-surface py-1 shadow-2xl"
              >
                <div className="border-b border-juke-border px-3 py-2">
                  <p className="truncate text-sm font-semibold text-juke-text-on-dark">
                    {user.display_name}
                  </p>
                  <p className="truncate text-xs text-juke-text-on-dark-secondary">
                    @{user.username}
                  </p>
                </div>
                <Link
                  role="menuitem"
                  href={`/app/profile/${encodeURIComponent(user.username)}`}
                  onClick={() => setMenuOpen(false)}
                  className={menuItemClass}
                >
                  Profile
                </Link>
                <Link
                  role="menuitem"
                  href="/leaderboard"
                  onClick={() => setMenuOpen(false)}
                  className={menuItemClass}
                >
                  Leaderboard
                </Link>
                <Link
                  role="menuitem"
                  href="/app/settings"
                  onClick={() => setMenuOpen(false)}
                  className={menuItemClass}
                >
                  Settings
                </Link>
                <button
                  role="menuitem"
                  type="button"
                  onClick={handleSignOut}
                  className={cn(menuItemClass, "w-full text-left text-red-400")}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

const menuItemClass =
  "block px-3 py-2 text-sm text-juke-text-on-dark transition-colors hover:bg-juke-navy/60";
