"use client";

import { useCallback, useEffect, type ReactNode } from "react";
import { useParams, usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useSpaceStore } from "@/lib/space/spaceStore";
import { MESSAGES_INBOX_PATH, decodeConversationParam } from "@/lib/messages/deep-link";
import { useMessageStore } from "@/lib/stores/messageStore";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/cn";
import { EnableMessagesGate } from "./EnableMessagesGate";
import { InboxPane } from "./InboxPane";
import { ChatBubbleIcon } from "./icons";
import { MESSAGING_UI_ENABLED, useMessagesRealtime, useMessagingSession } from "./useMessagingSync";
import { useMessagingTokenStatus } from "./useMessagingTokenStatus";

/**
 * Two-pane Messages layout (inbox + thread) on `lg+`; a single pane with back
 * navigation below that. Gates the surface on sign-in, the backend feature flag
 * and an active Direct Cast token (`token_status` from GET /status, or a 403
 * `messaging_token_*` / 4403 seen since), and owns the realtime subscription.
 */
export function MessagesShell({ children }: { children: ReactNode }) {
  const access = useMessagingSession();
  const availability = useMessageStore((s) => s.availability);
  const pathname = usePathname() ?? MESSAGES_INBOX_PATH;
  const params = useParams<{ conversationId?: string }>();
  const hasSpaceBar = useSpaceStore((s) => s.room !== null);
  const { signIn, user } = useAuth();
  const setAvailability = useMessageStore((s) => s.setAvailability);
  const { gate: tokenGate, refresh: refreshTokenStatus } = useMessagingTokenStatus(
    MESSAGING_UI_ENABLED && access === "ready",
  );
  const hasActiveToken =
    availability !== "token_required" &&
    (tokenGate.kind === "unknown" ||
      (tokenGate.kind === "ready" && tokenGate.status.token_status === "active"));
  const handleTokenEnabled = useCallback(async () => {
    await refreshTokenStatus();
    // Clear a token error seen mid-session so the gate defers to the new status.
    if (useMessageStore.getState().availability === "token_required") setAvailability("unknown");
  }, [refreshTokenStatus, setAvailability]);

  // A 403 / 4403 token error mid-session: re-read /status so the gate shows
  // the right copy (expired vs never enabled).
  useEffect(() => {
    if (availability === "token_required") void refreshTokenStatus();
  }, [availability, refreshTokenStatus]);

  const isUsable = access === "ready" && hasActiveToken && availability !== "disabled";
  useMessagesRealtime(MESSAGING_UI_ENABLED && isUsable);

  const isThreadRoute = pathname !== MESSAGES_INBOX_PATH;
  const activeConversationId = decodeConversationParam(params?.conversationId);

  if (!MESSAGING_UI_ENABLED || availability === "disabled" || tokenGate.kind === "disabled") {
    return (
      <Gate>
        <EmptyState
          icon={<ChatBubbleIcon className="h-8 w-8" />}
          title="Messages aren't switched on yet"
          description="Direct Casts are coming to Juke on the web soon."
        />
      </Gate>
    );
  }
  if (access === "loading") {
    return (
      <Gate>
        <Spinner label="Loading messages" />
      </Gate>
    );
  }
  if (access === "anonymous") {
    return (
      <Gate>
        <EmptyState
          icon={<ChatBubbleIcon className="h-8 w-8" />}
          title="Sign in to see your messages"
          description="Read and send Farcaster Direct Casts without leaving Juke."
          action={<Button onClick={() => void signIn()}>Sign in with Farcaster</Button>}
        />
      </Gate>
    );
  }
  if (tokenGate.kind === "loading") {
    return (
      <Gate>
        <Spinner label="Loading messages" />
      </Gate>
    );
  }
  if (!hasActiveToken && user) {
    return (
      <Gate>
        <EnableMessagesGate
          fid={user.fid}
          custodyAddress={user.custody_address}
          tokenStatus={tokenGate.kind === "ready" ? tokenGate.status.token_status : null}
          onEnabled={handleTokenEnabled}
        />
      </Gate>
    );
  }

  return (
    <div
      className={cn(
        "flex w-full overflow-hidden",
        // Mobile: header (3.5rem) above, bottom nav (3.5rem + safe area) below.
        "h-[calc(100dvh-7rem-env(safe-area-inset-bottom))]",
        "md:sticky md:top-14 md:h-[calc(100dvh-3.5rem)] md:border-x md:border-juke-border",
      )}
    >
      <div
        className={cn(
          "min-h-0 w-full flex-col lg:w-80 lg:shrink-0 lg:border-r lg:border-juke-border",
          isThreadRoute ? "hidden lg:flex" : "flex",
          hasSpaceBar && "pb-16",
        )}
      >
        <InboxPane activeConversationId={activeConversationId} />
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          isThreadRoute
            ? // Below md the thread takes over the screen (over the app header and bottom nav).
              "fixed inset-x-0 top-0 z-50 flex h-[100dvh] bg-juke-navy pt-[env(safe-area-inset-top)] md:static md:z-auto md:h-auto md:pt-0"
            : "hidden lg:flex",
          hasSpaceBar && "md:pb-16",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Gate({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[60vh] w-full items-center justify-center px-4">{children}</div>;
}
