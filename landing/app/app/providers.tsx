"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "@/lib/auth/AuthProvider";
import { useNotificationStore } from "@/lib/stores/notificationStore";
import { AppHeader } from "./_components/AppHeader";
import { SideNav } from "./_components/SideNav";
import { BottomNav } from "./_components/BottomNav";
import { SpaceMiniBar } from "./_components/SpaceMiniBar";
import { ComposeModal } from "./_components/ComposeModal";
import { GlobalShortcuts } from "./_components/GlobalShortcuts";
import { RightRail } from "./_components/RightRail";
import { SignerRelinkBanner } from "./_components/SignerRelinkBanner";
import { MiniAppShellProvider } from "@/components/miniapp/MiniAppShell";

/**
 * Client shell for the `/app` route group. Rendered once by the layout, so
 * everything mounted here (auth context, the persistent SpaceMiniBar, the
 * global compose modal) survives navigation between sibling page routes.
 *
 * `ShellChrome` lives INSIDE `<AuthProvider>` so it can read `useAuth()` — it
 * wires the notification unread badge into the nav and kicks off an initial
 * background notification fetch plus a recurring poll (every 60 s) while the
 * session remains authenticated.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <MiniAppShellProvider>
        <ShellChrome>{children}</ShellChrome>
      </MiniAppShellProvider>
    </AuthProvider>
  );
}

/** How often to poll for new notifications while the user browses (ms). */
const NOTIFICATION_POLL_INTERVAL_MS = 60_000;

function ShellChrome({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const loadNotifications = useNotificationStore((s) => s.load);
  const refreshNotifications = useNotificationStore((s) => s.refresh);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isAuthenticated = status === "authenticated";
  // Messages is a full-height two-pane surface (it owns its own scrolling and
  // composer), so it drops the feed column's width cap and bottom padding.
  const isMessagesRoute = (usePathname() ?? "").startsWith("/app/messages");

  // Initial fetch — populates the badge without forcing a visit to /notifications.
  useEffect(() => {
    if (isAuthenticated) {
      void loadNotifications();
    }
  }, [isAuthenticated, loadNotifications]);

  // Background poll — keeps the unread badge current while the user browses
  // other pages. A single interval is registered at the shell level so
  // individual pages don't need their own timers. Cleared when the user signs
  // out (status changes away from "authenticated").
  useEffect(() => {
    if (!isAuthenticated) {
      if (intervalRef.current != null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    if (intervalRef.current != null) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      void refreshNotifications();
    }, NOTIFICATION_POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current != null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isAuthenticated, refreshNotifications]);

  const profileFid = user?.fid ?? null;

  return (
    <div className="min-h-screen">
      <AppHeader unreadCount={unreadCount} />
      <SignerRelinkBanner />

      <div className="mx-auto flex w-full max-w-7xl justify-center gap-x-6">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 self-start overflow-y-auto px-3 py-4 md:block">
          <SideNav unreadCount={unreadCount} profileFid={profileFid} />
        </aside>

        {/* Bottom padding clears the mobile BottomNav + persistent mini-bar. */}
        <main
          className={
            isMessagesRoute
              ? "min-w-0 flex-1"
              : "min-w-0 flex-1 pb-40 md:pb-24 xl:w-[640px] xl:max-w-[640px] xl:flex-none"
          }
        >
          {children}
        </main>

        <RightRail />
      </div>

      <BottomNav unreadCount={unreadCount} profileFid={profileFid} />
      <SpaceMiniBar />
      <ComposeModal />
      <GlobalShortcuts />
    </div>
  );
}
